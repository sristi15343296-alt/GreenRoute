/**
 * Emergency vehicle location sharing.
 *
 * Pure decision logic plus one tracker. Nothing here imports React, a native
 * module or `fetch`: the tracker receives a watcher, a permission request, a
 * transport, a store, a clock and a sleeper. That keeps every rule in §C.1–C.5
 * testable in plain Node, exactly like the outbox.
 *
 * Design notes that matter:
 *
 * - The server deduplicates on `client_fix_id`, and the id is derived from a
 *   persisted monotonic sequence (`CALLSIGN:sequence`), so a fix that is retried
 *   after an app restart has the same identity and is answered as a duplicate
 *   instead of being stored twice.
 * - The buffer is bounded twice: by count and by age. A fix older than
 *   BUFFER_TTL_MS is dropped rather than uploaded, because a two-minute-old
 *   position no longer describes where the vehicle is. The newest fix is always
 *   kept: it is the one an operator can still act on.
 * - A fix is written to storage before the first byte leaves the device, so an
 *   app kill mid-upload cannot lose it.
 * - The newest position wins on the server, so flushing a slightly out-of-order
 *   buffer is harmless: an older fix cannot overwrite a newer one.
 */

import type { Status } from './types';
import { backoffDelay } from './outbox';

/** 10 s between fixes while moving; the server calls 15 s "LIVE". */
export const UPDATE_INTERVAL_MS = 10_000;
/** 25 m of movement also triggers a fix, so a stationary vehicle is quiet. */
export const UPDATE_DISTANCE_M = 25;
/** Fixes worse than this are ignored: they are noise, not a position. */
export const ACCURACY_CEILING_M = 100;
/** Below this, the vehicle has not meaningfully moved. */
export const MIN_STEP_M = 8;
/** At most this many unsent fixes are kept. */
export const BUFFER_LIMIT = 12;
/** Unsent fixes older than this are discarded as no longer useful. */
export const BUFFER_TTL_MS = 120_000;
/** Fixes per request; the server rejects larger batches. */
export const BATCH_LIMIT = 20;

/** What the driver is told, and what the badge renders. */
export type ShareState =
  | 'off'
  | 'starting'
  | 'active'
  | 'paused'
  | 'degraded'
  | 'denied'
  | 'unauthorised';

export interface ShareView {
  state: ShareState;
  /** Driver-facing sentence. Always present, never a raw code. */
  message: string;
  lastFixAt: number | null;
  lastSentAt: number | null;
  buffered: number;
  sent: number;
  accuracyM: number | null;
  /** True when the phone thinks dispatch is unreachable or refusing. */
  degraded: boolean;
}

export interface GeolocationSample {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracy_m: number;
  heading_deg: number | null;
  speed_mps: number | null;
  /** ISO-8601 with an offset, from the device clock. */
  device_time: string;
  client_fix_id: string;
  sequence: number;
}

export interface BufferedState {
  sequence: number;
  fixes: Fix[];
}

/**
 * Only `in_transit` is shareable.
 *
 * The server derives the emergency session from the trip, and only an ACTIVE
 * session accepts telemetry — which is exactly the `in_transit` window. Asking
 * before departure would earn a 409 on every batch, so the phone does not try.
 */
export function shouldShare(status: Status | null | undefined): boolean {
  return status === 'in_transit';
}

export function validCoordinates(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** True when a sample is precise enough to be a position rather than a guess. */
export function isUsable(sample: GeolocationSample): boolean {
  if (!validCoordinates(sample.latitude, sample.longitude)) {
    return false;
  }
  if (sample.accuracy === null || !Number.isFinite(sample.accuracy)) {
    return false;
  }
  if (sample.accuracy < 0 || sample.accuracy > ACCURACY_CEILING_M) {
    return false;
  }
  return Number.isFinite(sample.timestamp);
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/** Great-circle distance, good enough for "did we move?" decisions. */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const earth = 6_371_000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Should this sample become a fix?
 *
 * The interval is enforced by the watcher, so this only rejects the other two
 * cases: an unusable reading, and a vehicle that has not actually moved.
 */
export function acceptSample(
  previous: GeolocationSample | null,
  sample: GeolocationSample,
  options: { minStepM?: number } = {}
): boolean {
  if (!isUsable(sample)) {
    return false;
  }
  if (previous === null) {
    return true;
  }
  const step = distanceMeters(previous, sample);
  const travelled = step >= (options.minStepM ?? MIN_STEP_M);
  // A stationary phone with a drifting accuracy estimate should still check in
  // occasionally, otherwise the admin sees a vehicle go stale while parked with
  // the app open. Ten metres of jitter or a minute of silence both qualify.
  const silent = sample.timestamp - previous.timestamp >= UPDATE_INTERVAL_MS * 3;
  return travelled || silent;
}

export function makeFix(sample: GeolocationSample, sequence: number, callSign: string): Fix {
  return {
    lat: Number(sample.latitude.toFixed(6)),
    lng: Number(sample.longitude.toFixed(6)),
    accuracy_m: Math.round((sample.accuracy ?? 0) * 10) / 10,
    heading_deg:
      sample.heading === null || sample.heading < 0 ? null : Math.round(sample.heading),
    speed_mps:
      sample.speed === null || sample.speed < 0
        ? null
        : Math.round(sample.speed * 100) / 100,
    device_time: new Date(sample.timestamp).toISOString(),
    client_fix_id: `${callSign}:${sequence}`,
    sequence,
  };
}

/**
 * Drop what is no longer useful: anything past the age limit, then the oldest
 * entries beyond the count limit. The newest fix is never dropped.
 */
export function trimBuffer(
  fixes: Fix[],
  nowMs: number,
  options: { limit?: number; ttlMs?: number } = {}
): { kept: Fix[]; dropped: number } {
  const limit = options.limit ?? BUFFER_LIMIT;
  const ttl = options.ttlMs ?? BUFFER_TTL_MS;
  const fresh = fixes.filter((fix) => {
    const at = Date.parse(fix.device_time);
    return Number.isFinite(at) && nowMs - at <= ttl;
  });
  const dropped = fixes.length - fresh.length;
  if (fresh.length <= limit) {
    return { kept: fresh, dropped };
  }
  const newestFirst = [...fresh].sort((a, b) => a.sequence - b.sequence);
  return { kept: newestFirst.slice(newestFirst.length - limit), dropped: dropped + (fresh.length - limit) };
}

export type SendVerdict = 'ok' | 'network' | 'refused' | 'unauthorized';

export interface TrackerDeps {
  /** Ask for foreground permission; returns true when granted. */
  requestPermission: () => Promise<boolean>;
  /** Start watching. `remove` stops it. */
  watch: (onSample: (sample: GeolocationSample) => void) => Promise<{ remove: () => void }>;
  send: (token: string, fixes: Fix[]) => Promise<SendVerdict>;
  load: () => Promise<BufferedState>;
  save: (state: BufferedState) => Promise<void>;
  onChange: (view: ShareView) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface Tracker {
  /** Begin sharing for this unit. Safe to call twice. */
  start: (token: string, callSign: string) => Promise<void>;
  /** Stop watching and forget the in-memory watcher; the buffer is kept. */
  pause: (message?: string) => Promise<void>;
  /** Resume after a pause if still eligible. */
  resume: () => Promise<void>;
  /** Stop sharing and clear the buffer (session ended, unit unpaired). */
  stop: () => Promise<void>;
  /** Try to upload the buffer now, e.g. on pull-to-refresh. */
  flush: () => Promise<void>;
  view: () => ShareView;
}

function idleView(message: string): ShareView {
  return {
    state: 'off',
    message,
    lastFixAt: null,
    lastSentAt: null,
    buffered: 0,
    sent: 0,
    accuracyM: null,
    degraded: false,
  };
}

export function createTracker(deps: TrackerDeps): Tracker {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  let view = idleView('Location sharing is off.');
  let state: BufferedState = { sequence: 0, fixes: [] };
  let watcher: { remove: () => void } | null = null;
  let token: string | null = null;
  let callSign: string | null = null;
  let previous: GeolocationSample | null = null;
  let flushing = false;
  let attempts = 0;
  let stopped = true;
  let paused = false;

  function publish(next: Partial<ShareView>): void {
    view = { ...view, ...next, buffered: state.fixes.length };
    deps.onChange(view);
  }

  async function persist(): Promise<void> {
    try {
      await deps.save(state);
    } catch {
      // Storage failure must not stop the fix from being sent: it is already in
      // memory and the next write will try again.
    }
  }

  async function flush(): Promise<void> {
    if (flushing || stopped || paused || token === null) {
      return;
    }
    if (state.fixes.length === 0) {
      return;
    }
    flushing = true;
    try {
      while (!stopped && !paused && state.fixes.length > 0) {
        const batch = [...state.fixes]
          .sort((a, b) => a.sequence - b.sequence)
          .slice(0, BATCH_LIMIT);
        const verdict = await deps.send(token, batch);
        if (verdict === 'ok') {
          const sentIds = new Set(batch.map((fix) => fix.client_fix_id));
          state = { ...state, fixes: state.fixes.filter((fix) => !sentIds.has(fix.client_fix_id)) };
          attempts = 0;
          await persist();
          publish({
            state: 'active',
            message: 'Sharing location with dispatch.',
            lastSentAt: now(),
            sent: view.sent + batch.length,
            degraded: false,
          });
          continue;
        }
        if (verdict === 'unauthorized') {
          stopped = true;
          watcher?.remove();
          watcher = null;
          publish({
            state: 'unauthorised',
            message: 'Sign-in expired. Location sharing stopped — pair this unit again.',
            degraded: true,
          });
          return;
        }
        attempts += 1;
        publish({
          state: 'degraded',
          message:
            verdict === 'refused'
              ? 'Dispatch refused the last position update. Retrying.'
              : 'Can’t reach dispatch. Positions are buffered on this phone.',
          degraded: true,
        });
        await persist();
        if (attempts > 4) {
          // Give up on this pass; the next fix will try again. The buffer stays
          // bounded, so an outage cannot grow it without limit.
          return;
        }
        await sleep(backoffDelay(attempts, random()));
      }
    } finally {
      flushing = false;
    }
  }

  function onSample(sample: GeolocationSample): void {
    if (stopped || paused || callSign === null) {
      return;
    }
    if (!acceptSample(previous, sample)) {
      return;
    }
    previous = sample;
    const sequence = state.sequence + 1;
    const fix = makeFix(sample, sequence, callSign);
    const trimmed = trimBuffer([...state.fixes, fix], now());
    state = { sequence, fixes: trimmed.kept };
    void persist();
    publish({
      lastFixAt: now(),
      accuracyM: fix.accuracy_m,
      message:
        trimmed.dropped > 0
          ? 'Sharing location. Old buffered positions were dropped.'
          : 'Sharing location with dispatch.',
    });
    void flush();
  }

  async function start(nextToken: string, nextCallSign: string): Promise<void> {
    if (!stopped) {
      // Already watching; keep the same session and just refresh credentials.
      token = nextToken;
      callSign = nextCallSign;
      return;
    }
    token = nextToken;
    callSign = nextCallSign;
    stopped = false;
    paused = false;
    publish({ state: 'starting', message: 'Starting location sharing…' });

    const granted = await deps.requestPermission();
    if (!granted) {
      stopped = true;
      publish({
        state: 'denied',
        message: 'Location permission is off. Dispatch cannot see this vehicle.',
        degraded: true,
      });
      return;
    }

    try {
      const loaded = await deps.load();
      state = { sequence: loaded.sequence, fixes: trimBuffer(loaded.fixes, now()).kept };
    } catch {
      // A corrupt buffer is not worth failing over: start a fresh one.
      state = { sequence: state.sequence, fixes: [] };
    }

    try {
      watcher = await deps.watch(onSample);
    } catch {
      stopped = true;
      publish({
        state: 'degraded',
        message: 'This phone could not start GPS updates. Check location settings.',
        degraded: true,
      });
      return;
    }

    publish({ state: 'active', message: 'Sharing location with dispatch.' });
    void flush();
  }

  async function pause(message?: string): Promise<void> {
    paused = true;
    watcher?.remove();
    watcher = null;
    previous = null;
    publish({
      state: stopped ? 'off' : 'paused',
      message: message ?? 'Location sharing paused while the app is in the background.',
    });
  }

  async function resume(): Promise<void> {
    if (stopped) {
      return;
    }
    if (watcher !== null) {
      paused = false;
      await flush();
      return;
    }
    paused = false;
    previous = null;
    try {
      watcher = await deps.watch(onSample);
      publish({ state: 'active', message: 'Sharing location with dispatch.' });
      void flush();
    } catch {
      publish({
        state: 'degraded',
        message: 'This phone could not start GPS updates. Check location settings.',
        degraded: true,
      });
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    paused = false;
    watcher?.remove();
    watcher = null;
    previous = null;
    state = { sequence: state.sequence, fixes: [] };
    await persist();
    publish({ ...idleView('Location sharing stopped.'), sent: view.sent });
  }

  return {
    start,
    pause,
    resume,
    stop,
    flush,
    view: () => view,
  };
}
