/**
 * The outbox: pure decision logic plus one serial FIFO worker.
 *
 * Nothing in this module imports React, a native module or `fetch`, so the whole
 * of §4.4 can be exercised in a plain Node test. The app injects storage, a
 * transport and a clock; the worker never generates or mutates the identity of
 * a queued action.
 */

import type { TransitionOutcome } from './api';
import type { OutboxItem, Status, Trip } from './types';

export const QUEUE_LIMIT = 200;

/** 1s, 2s, 4s, 8s, 16s, 30s and 30s forever. */
export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/** The server's own wording, used to recognise the illegal-edge 400. */
export const ILLEGAL_TRANSITION_MESSAGE = 'That action is not allowed from this state.';

/** The worker reports what happened; the UI layer owns the wording. */
export type NoticeCode = 'conflict' | 'illegal' | 'rejected' | 'reassigned' | 'missing';

export type Verdict = 'done' | 'retry' | 'drop' | 'drop-trip' | 'halt' | 'conflict';

/**
 * The one place a server response is turned into a queue decision.
 *
 * - `done`      applied now, or replayed, or the id was reused for another action
 * - `conflict`  the state moved under us; adopt the trip and clear that trip
 * - `drop`      a 400: the item can never succeed, refresh the trip instead
 * - `drop-trip` 403/404: the trip is gone or belongs to someone else
 * - `halt`      401: stop the queue, keep everything, re-pair
 * - `retry`     anything unknown, including timeouts and 5xx
 */
export function decide(_item: OutboxItem, outcome: TransitionOutcome): Verdict {
  if (outcome.kind === 'ok') {
    return 'done';
  }
  if (outcome.kind === 'network' || outcome.kind === 'invalid') {
    return 'retry';
  }
  const { status, reason } = outcome;
  if (status === 401) {
    return 'halt';
  }
  if (status === 403 || status === 404) {
    return 'drop-trip';
  }
  if (status === 409) {
    // A reused id for a different action was already applied as that action;
    // the trip in the body is authoritative, so nothing is lost by accepting it.
    return reason === 'event_id_reused' ? 'done' : 'conflict';
  }
  if (status === 400) {
    return 'drop';
  }
  if (status >= 500) {
    return 'retry';
  }
  return 'retry';
}

/** Delay before retry number `attempt` (1-based), jittered by ±20%. */
export function backoffDelay(attempt: number, random: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_STEPS_MS.length) - 1;
  const base = BACKOFF_STEPS_MS[index] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1];
  const clamped = Math.min(Math.max(random, 0), 1);
  const factor = 1 + (clamped - 0.5) * 0.4;
  return Math.round(base * factor);
}

function describeFailure(outcome: TransitionOutcome): string {
  if (outcome.kind === 'ok') {
    return 'applied';
  }
  if (outcome.kind === 'network' || outcome.kind === 'invalid') {
    return outcome.error;
  }
  return `${outcome.status}: ${outcome.error}`;
}

export interface OutboxStore {
  load(): Promise<OutboxItem[]>;
  save(items: OutboxItem[]): Promise<void>;
}

export interface OutboxTransport {
  send(token: string, item: OutboxItem): Promise<TransitionOutcome>;
  fetchTrip(token: string, tripId: number): Promise<Trip | null>;
}

export interface OutboxClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  newId(): string;
}

export type OutboxEvent =
  | { type: 'trip'; trip: Trip }
  | { type: 'applied' }
  | { type: 'retry' }
  | { type: 'notice'; code: NoticeCode }
  | { type: 'halt'; code: 'expired' };

export interface OutboxWorkerOptions {
  store: OutboxStore;
  transport: OutboxTransport;
  clock: OutboxClock;
  onEvent?: (event: OutboxEvent) => void;
}

export interface EnqueueRequest {
  tripId: number;
  to: Status;
  expectedStatus: Status;
  clientEventId: string;
  clientAt: string;
}

export type EnqueueOutcome = 'queued' | 'duplicate' | 'full';

export interface OutboxWorker {
  enqueue(request: EnqueueRequest): Promise<EnqueueOutcome>;
  drain(token: string): Promise<void>;
  clear(): Promise<void>;
  reset(): void;
  isHalted(): boolean;
}

function adoptedTrip(outcome: TransitionOutcome): Trip | null {
  if (outcome.kind === 'ok') {
    return outcome.trip;
  }
  if (outcome.kind === 'http') {
    return outcome.trip;
  }
  return null;
}

export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const { store, transport, clock } = options;

  let halted = false;
  let active: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const emit = (event: OutboxEvent): void => {
    if (options.onEvent) {
      options.onEvent(event);
    }
  };

  /** All queue mutations run one at a time, always against freshly loaded state. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function removeItem(id: string): Promise<void> {
    return serialize(async () => {
      const items = await store.load();
      await store.save(items.filter((item) => item.id !== id));
    });
  }

  function removeTrip(tripId: number): Promise<void> {
    return serialize(async () => {
      const items = await store.load();
      await store.save(items.filter((item) => item.tripId !== tripId));
    });
  }

  function recordAttempt(id: string, attempts: number, lastError: string): Promise<void> {
    return serialize(async () => {
      const items = await store.load();
      await store.save(
        items.map((item) =>
          item.id === id ? { ...item, attempts, lastError } : item
        )
      );
    });
  }

  async function runLoop(token: string): Promise<void> {
    for (;;) {
      if (halted) {
        return;
      }
      const items = await store.load();
      const item = items[0];
      if (item === undefined) {
        return;
      }

      let outcome: TransitionOutcome;
      try {
        outcome = await transport.send(token, item);
      } catch {
        outcome = { kind: 'network', error: 'Could not reach dispatch.' };
      }

      const verdict = decide(item, outcome);
      const trip = adoptedTrip(outcome);
      if (trip !== null) {
        emit({ type: 'trip', trip });
      }

      if (verdict === 'done') {
        await removeItem(item.id);
        emit({ type: 'applied' });
        continue;
      }

      if (verdict === 'conflict') {
        // Every other queued action for this trip was computed against a state
        // that no longer exists.
        await removeTrip(item.tripId);
        emit({ type: 'notice', code: 'conflict' });
        emit({ type: 'applied' });
        continue;
      }

      if (verdict === 'drop') {
        await removeItem(item.id);
        if (outcome.kind === 'http' && outcome.status === 400) {
          const illegal =
            outcome.error === ILLEGAL_TRANSITION_MESSAGE ||
            /not allowed from this state/i.test(outcome.error);
          emit({ type: 'notice', code: illegal ? 'illegal' : 'rejected' });
          if (illegal) {
            const fresh = await transport.fetchTrip(token, item.tripId);
            if (fresh !== null) {
              emit({ type: 'trip', trip: fresh });
            }
          }
        }
        emit({ type: 'applied' });
        continue;
      }

      if (verdict === 'drop-trip') {
        await removeTrip(item.tripId);
        const reassigned = outcome.kind === 'http' && outcome.status === 403;
        emit({ type: 'notice', code: reassigned ? 'reassigned' : 'missing' });
        emit({ type: 'applied' });
        continue;
      }

      if (verdict === 'halt') {
        halted = true;
        emit({ type: 'halt', code: 'expired' });
        return;
      }

      // retry: persist the attempt first, then wait, then try the same item again.
      const attempts = item.attempts + 1;
      await recordAttempt(item.id, attempts, describeFailure(outcome));
      emit({ type: 'retry' });
      await clock.sleep(backoffDelay(attempts, clock.random()));
    }
  }

  function enqueue(request: EnqueueRequest): Promise<EnqueueOutcome> {
    return serialize(async () => {
      const items = await store.load();
      const duplicate = items.some(
        (item) =>
          item.tripId === request.tripId &&
          (item.clientEventId === request.clientEventId || item.to === request.to)
      );
      if (duplicate) {
        return 'duplicate';
      }
      if (items.length >= QUEUE_LIMIT) {
        return 'full';
      }
      const item: OutboxItem = {
        id: clock.newId(),
        tripId: request.tripId,
        to: request.to,
        expectedStatus: request.expectedStatus,
        clientEventId: request.clientEventId,
        clientAt: request.clientAt,
        attempts: 0,
        createdAt: new Date(clock.now()).toISOString(),
        lastError: null,
      };
      // Write-ahead: the tap is durable before the first byte leaves the device.
      await store.save([...items, item]);
      return 'queued';
    });
  }

  function drain(token: string): Promise<void> {
    if (halted) {
      return Promise.resolve();
    }
    if (active !== null) {
      return active;
    }
    let run: Promise<void>;
    run = runLoop(token).finally(() => {
      if (active === run) {
        active = null;
      }
    });
    active = run;
    return run;
  }

  function clear(): Promise<void> {
    return serialize(async () => {
      await store.save([]);
      halted = false;
    });
  }

  return {
    enqueue,
    drain,
    clear,
    reset: () => {
      halted = false;
    },
    isHalted: () => halted,
  };
}
