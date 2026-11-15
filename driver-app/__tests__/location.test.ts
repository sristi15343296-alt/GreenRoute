/**
 * Phase C location sharing: acceptance, buffering, retries and the badge.
 *
 * The tracker takes every dependency by injection, so these tests drive it with
 * a fake watcher and a fake transport. No GPS, no network, no device.
 */

import {
  ACCURACY_CEILING_M,
  BUFFER_LIMIT,
  BUFFER_TTL_MS,
  acceptSample,
  createTracker,
  distanceMeters,
  makeFix,
  shouldShare,
  trimBuffer,
  validCoordinates,
  type BufferedState,
  type Fix,
  type GeolocationSample,
  type ShareView,
} from '../src/location';

function sample(overrides: Partial<GeolocationSample> = {}): GeolocationSample {
  return {
    latitude: 19.1136,
    longitude: 72.8697,
    accuracy: 8,
    heading: 210,
    speed: 12,
    timestamp: Date.parse('2026-11-15T09:00:00Z'),
    ...overrides,
  };
}

function fixAt(sequence: number, overrides: Partial<Fix> = {}): Fix {
  return {
    lat: 19.1136,
    lng: 72.8697,
    accuracy_m: 8,
    heading_deg: 210,
    speed_mps: 12,
    device_time: '2026-11-15T09:00:00.000Z',
    client_fix_id: `MED-12:${sequence}`,
    sequence,
    ...overrides,
  };
}

describe('shouldShare', () => {
  it('shares only while the response is en route', () => {
    expect(shouldShare('in_transit')).toBe(true);
    expect(shouldShare('accepted')).toBe(false);
    expect(shouldShare('on_scene')).toBe(false);
    expect(shouldShare('completed')).toBe(false);
    expect(shouldShare(null)).toBe(false);
  });
});

describe('coordinates and sample acceptance', () => {
  it('rejects impossible coordinates and the null point', () => {
    expect(validCoordinates(19.1, 72.8)).toBe(true);
    expect(validCoordinates(91, 72.8)).toBe(false);
    expect(validCoordinates(19.1, 181)).toBe(false);
    expect(validCoordinates(0, 0)).toBe(false);
    expect(validCoordinates(Number.NaN, 72.8)).toBe(false);
  });

  it('ignores a reading worse than the accuracy ceiling', () => {
    expect(acceptSample(null, sample({ accuracy: ACCURACY_CEILING_M + 1 }))).toBe(false);
    expect(acceptSample(null, sample({ accuracy: null }))).toBe(false);
    expect(acceptSample(null, sample())).toBe(true);
  });

  it('ignores a stationary vehicle that has not moved', () => {
    const previous = sample();
    const same = sample({ timestamp: previous.timestamp + 10_000 });
    expect(acceptSample(previous, same)).toBe(false);

    const moved = sample({
      latitude: 19.1140,
      timestamp: previous.timestamp + 10_000,
    });
    expect(acceptSample(previous, moved)).toBe(true);
  });

  it('checks in when a parked vehicle has been silent', () => {
    const previous = sample();
    const later = sample({ timestamp: previous.timestamp + 40_000 });
    expect(acceptSample(previous, later)).toBe(true);
  });

  it('measures distance in metres', () => {
    const metres = distanceMeters(
      { latitude: 19.1136, longitude: 72.8697 },
      { latitude: 19.1146, longitude: 72.8697 }
    );
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(130);
  });
});

describe('fix shaping', () => {
  it('builds a stable identity from the call sign and sequence', () => {
    const fix = makeFix(sample(), 7, 'MED-12');
    expect(fix.client_fix_id).toBe('MED-12:7');
    expect(fix.sequence).toBe(7);
    expect(fix.device_time).toBe('2026-11-15T09:00:00.000Z');
    expect(fix.lat).toBe(19.1136);
  });

  it('drops a negative heading or speed instead of sending nonsense', () => {
    const fix = makeFix(sample({ heading: -1, speed: -1 }), 1, 'MED-12');
    expect(fix.heading_deg).toBeNull();
    expect(fix.speed_mps).toBeNull();
  });
});

describe('buffer trimming', () => {
  it('keeps the newest fixes within the count limit', () => {
    const fixes = [1, 2, 3, 4, 5].map((n) => fixAt(n));
    const now = Date.parse('2026-11-15T09:00:10Z');
    const { kept, dropped } = trimBuffer(fixes, now, { limit: 3 });
    expect(dropped).toBe(2);
    expect(kept.map((fix) => fix.sequence)).toEqual([3, 4, 5]);
  });

  it('discards fixes that are too old to be useful', () => {
    const now = Date.parse('2026-11-15T09:10:00Z');
    const fresh = fixAt(2, { device_time: '2026-11-15T09:09:30.000Z' });
    const stale = fixAt(1, { device_time: '2026-11-15T08:00:00.000Z' });
    const { kept, dropped } = trimBuffer([stale, fresh], now);
    expect(dropped).toBe(1);
    expect(kept).toEqual([fresh]);
  });

  it('drops a fix that is past its usefulness window', () => {
    const now = Date.parse('2026-11-15T09:00:10Z');
    const single = fixAt(1, {
      device_time: new Date(now - BUFFER_TTL_MS - 1000).toISOString(),
    });
    expect(trimBuffer([single], now).kept).toHaveLength(0);
  });
});

interface Harness {
  tracker: ReturnType<typeof createTracker>;
  views: ShareView[];
  sent: Fix[][];
  stored: BufferedState;
  emit: (sample: GeolocationSample) => void;
  failNext: (times: number) => void;
  allow: () => void;
  haltWatchCount: () => number;
}

function harness(options: {
  permission?: boolean;
  verdict?: 'ok' | 'network' | 'refused' | 'unauthorized';
  initial?: BufferedState;
} = {}): Harness {
  const views: ShareView[] = [];
  const sent: Fix[][] = [];
  const stored: BufferedState = options.initial ?? { sequence: 0, fixes: [] };
  let emit: (sample: GeolocationSample) => void = () => undefined;
  let failures = 0;
  let verdict: 'ok' | 'network' | 'refused' | 'unauthorized' = options.verdict ?? 'ok';
  let watchers = 0;
  let watchRemovals = 0;

  const tracker = createTracker({
    requestPermission: async () => options.permission ?? true,
    watch: async (onSample) => {
      emit = onSample;
      watchers += 1;
      return {
        remove: () => {
          watchRemovals += 1;
        },
      };
    },
    send: async (_token, fixes) => {
      sent.push(fixes);
      if (failures > 0) {
        failures -= 1;
        return 'network';
      }
      return verdict;
    },
    load: async () => stored,
    save: async (state) => {
      stored.sequence = state.sequence;
      stored.fixes = state.fixes;
    },
    onChange: (view) => views.push(view),
    now: () => Date.parse('2026-11-15T09:00:00Z'),
    sleep: async () => undefined,
    random: () => 0.5,
  });

  return {
    tracker,
    views,
    sent,
    stored,
    emit: (next) => emit(next),
    failNext: (times) => {
      failures = times;
    },
    allow: () => {
      verdict = 'ok';
      failures = 0;
    },
    haltWatchCount: () => watchRemovals + watchers, // watchers removed
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('tracker', () => {
  it('starts, sends an accepted fix and reports active', async () => {
    const h = harness();
    await h.tracker.start('token', 'MED-12');
    h.emit(sample());
    await settle();
    expect(h.tracker.view().state).toBe('active');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0][0].client_fix_id).toBe('MED-12:1');
    expect(h.stored.fixes).toHaveLength(0);
    expect(h.stored.sequence).toBe(1);
  });

  it('reports denial instead of pretending to share', async () => {
    const h = harness({ permission: false });
    await h.tracker.start('token', 'MED-12');
    expect(h.tracker.view().state).toBe('denied');
    expect(h.tracker.view().message).toMatch(/permission/i);
    h.emit(sample());
    await settle();
    expect(h.sent).toHaveLength(0);
  });

  it('buffers while dispatch is unreachable, then catches up', async () => {
    const h = harness({ verdict: 'network' });
    await h.tracker.start('token', 'MED-12');
    h.emit(sample());
    await settle();
    expect(h.tracker.view().state).toBe('degraded');
    expect(h.tracker.view().message).toMatch(/buffer/i);
    expect(h.stored.fixes.length).toBeGreaterThan(0);

    // The outage ends: the buffered fix goes out on the next flush.
    h.allow();
    await h.tracker.flush();
    await settle();
    expect(h.tracker.view().state).toBe('active');
    expect(h.tracker.view().buffered).toBe(0);
    expect(h.stored.fixes).toHaveLength(0);
  });

  it('never lets the buffer grow without limit', async () => {
    const h = harness({ verdict: 'network' });
    await h.tracker.start('token', 'MED-12');
    for (let index = 0; index < BUFFER_LIMIT + 6; index += 1) {
      h.emit(
        sample({
          latitude: 19.1136 + index * 0.001,
          timestamp: Date.parse('2026-11-15T09:00:00Z') + index * 10_000,
        })
      );
      await settle();
    }
    expect(h.stored.fixes.length).toBeLessThanOrEqual(BUFFER_LIMIT);
  });

  it('stops on an expired token and says so', async () => {
    const h = harness({ verdict: 'unauthorized' });
    await h.tracker.start('token', 'MED-12');
    h.emit(sample());
    await settle();
    expect(h.tracker.view().state).toBe('unauthorised');
    expect(h.tracker.view().message).toMatch(/sign-in/i);
  });

  it('resumes the sequence after an app restart', async () => {
    const h = harness({ initial: { sequence: 40, fixes: [] } });
    await h.tracker.start('token', 'MED-12');
    h.emit(sample());
    await settle();
    expect(h.stored.sequence).toBe(41);
    expect(h.sent[0][0].client_fix_id).toBe('MED-12:41');
  });

  it('pauses on background and resumes on foreground', async () => {
    const h = harness();
    await h.tracker.start('token', 'MED-12');
    await h.tracker.pause();
    expect(h.tracker.view().state).toBe('paused');
    h.emit(sample());
    await settle();
    expect(h.sent).toHaveLength(0);

    await h.tracker.resume();
    h.emit(sample());
    await settle();
    expect(h.sent.length).toBeGreaterThan(0);
  });

  it('clears the buffer when sharing stops', async () => {
    const h = harness({ verdict: 'network', initial: { sequence: 3, fixes: [fixAt(3)] } });
    await h.tracker.start('token', 'MED-12');
    expect(h.stored.fixes.length).toBeGreaterThan(0);
    await h.tracker.stop();
    expect(h.stored.fixes).toHaveLength(0);
    expect(h.tracker.view().state).toBe('off');
  });
});
