import type { TransitionOutcome } from '../src/api';
import {
  backoffDelay,
  createOutboxWorker,
  decide,
  QUEUE_LIMIT,
  type OutboxClock,
  type OutboxEvent,
  type OutboxStore,
  type OutboxTransport,
} from '../src/outbox';
import type { OutboxItem, Trip } from '../src/types';

const BASE_TIME = 1_760_000_000_000;
const CLIENT_AT = '2026-11-12T09:00:00.000Z';

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 1,
    reference: 'GR-1001',
    status: 'scheduled',
    status_label: 'Scheduled',
    priority: 'high',
    priority_label: 'High',
    emergency_type: 'medical',
    origin: 'Andheri Station',
    destination: 'Marol Fire Station',
    origin_lat: null,
    origin_lng: null,
    destination_lat: null,
    destination_lng: null,
    distance_km: null,
    duration_min: null,
    dispatch_at: '2026-11-12T14:30',
    instructions: null,
    incident_reference: null,
    timeline: [],
    next_actions: ['accept'],
    ...overrides,
  };
}

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'item-1',
    tripId: 1,
    to: 'accepted',
    expectedStatus: 'scheduled',
    clientEventId: 'evt-1',
    clientAt: CLIENT_AT,
    attempts: 0,
    createdAt: CLIENT_AT,
    lastError: null,
    ...overrides,
  };
}

function ok(replayed: boolean, value: Trip): TransitionOutcome {
  return { kind: 'ok', replayed, trip: value };
}

function http(
  status: number,
  reason: string | null,
  value: Trip | null = null,
  error = 'error'
): TransitionOutcome {
  return { kind: 'http', status, reason, trip: value, error };
}

class MemoryStore implements OutboxStore {
  items: OutboxItem[];

  saves = 0;

  constructor(initial: OutboxItem[]) {
    this.items = initial.map((entry) => ({ ...entry }));
  }

  async load(): Promise<OutboxItem[]> {
    return this.items.map((entry) => ({ ...entry }));
  }

  async save(items: OutboxItem[]): Promise<void> {
    this.items = items.map((entry) => ({ ...entry }));
    this.saves += 1;
  }
}

interface Harness {
  worker: ReturnType<typeof createOutboxWorker>;
  store: MemoryStore;
  sent: OutboxItem[];
  events: OutboxEvent[];
  sleeps: number[];
  fetches: number[];
}

function harness(options: {
  items?: OutboxItem[];
  outcomes: TransitionOutcome[];
  fetched?: Trip | null;
}): Harness {
  const store = new MemoryStore(options.items ?? []);
  const sent: OutboxItem[] = [];
  const events: OutboxEvent[] = [];
  const sleeps: number[] = [];
  const fetches: number[] = [];
  let index = 0;
  let idCounter = 0;

  const transport: OutboxTransport = {
    async send(_token, entry) {
      sent.push({ ...entry });
      const next = options.outcomes[Math.min(index, options.outcomes.length - 1)];
      index += 1;
      return next ?? { kind: 'network', error: 'no scripted outcome' };
    },
    async fetchTrip(_token, tripId) {
      fetches.push(tripId);
      return options.fetched ?? null;
    },
  };

  const clock: OutboxClock = {
    now: () => BASE_TIME,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    newId: () => {
      idCounter += 1;
      return `generated-${idCounter}`;
    },
  };

  const worker = createOutboxWorker({
    store,
    transport,
    clock,
    onEvent: (event) => events.push(event),
  });

  return { worker, store, sent, events, sleeps, fetches };
}

function enqueueRequest(tripId: number, clientEventId: string) {
  return {
    tripId,
    to: 'accepted' as const,
    expectedStatus: 'scheduled' as const,
    clientEventId,
    clientAt: CLIENT_AT,
  };
}

describe('decide', () => {
  it('1. treats a fresh 200 as applied', () => {
    expect(decide(item(), ok(false, trip()))).toBe('done');
  });

  it('2. treats a replayed 200 as applied', () => {
    expect(decide(item(), ok(true, trip()))).toBe('done');
  });

  it('3. treats a 409 conflict as a state loss for the whole trip', () => {
    expect(decide(item(), http(409, 'conflict', trip()))).toBe('conflict');
  });

  it('4. treats a reused event id as already applied', () => {
    expect(decide(item(), http(409, 'event_id_reused', trip()))).toBe('done');
  });

  it('5. treats a 400 as a permanent rejection', () => {
    expect(decide(item(), http(400, null, null, 'That action is not allowed from this state.'))).toBe(
      'drop'
    );
  });

  it('6. halts on 401', () => {
    expect(decide(item(), http(401, null, null, 'Driver authentication required.'))).toBe('halt');
  });

  it('7 and 8. drop the trip on 403 and 404', () => {
    expect(decide(item(), http(403, null, null, 'This response is assigned to another unit.'))).toBe(
      'drop-trip'
    );
    expect(decide(item(), http(404, null, null, 'Trip not found.'))).toBe('drop-trip');
  });

  it('9. retries a 5xx and a network failure', () => {
    expect(decide(item(), http(500, null))).toBe('retry');
    expect(decide(item(), http(503, null))).toBe('retry');
    expect(decide(item(), { kind: 'network', error: 'timeout' })).toBe('retry');
    expect(decide(item(), { kind: 'invalid', error: 'unreadable' })).toBe('retry');
  });
});

describe('worker', () => {
  it('1. applies a fresh 200 once and adopts the trip', async () => {
    const adopted = trip({ status: 'accepted', status_label: 'Accepted' });
    const context = harness({ items: [item()], outcomes: [ok(false, adopted)] });

    await context.worker.drain('token');

    expect(context.store.items).toHaveLength(0);
    expect(context.sent).toHaveLength(1);
    const tripEvent = context.events.find((event) => event.type === 'trip');
    expect(tripEvent).toEqual({ type: 'trip', trip: adopted });
    expect(context.events.some((event) => event.type === 'applied')).toBe(true);
  });

  it('2. treats replayed:true as success and enqueues nothing twice', async () => {
    const context = harness({ items: [item()], outcomes: [ok(true, trip())] });

    await context.worker.drain('token');

    expect(context.store.items).toHaveLength(0);
    expect(context.sent).toHaveLength(1);
    expect(context.events.filter((event) => event.type === 'applied')).toHaveLength(1);
  });

  it('3. on conflict adopts the trip and clears only that trip\'s items', async () => {
    const context = harness({
      items: [
        item({ id: 'a1', tripId: 1, clientEventId: 'evt-a1' }),
        item({ id: 'a2', tripId: 1, clientEventId: 'evt-a2', to: 'in_transit', expectedStatus: 'accepted' }),
        item({ id: 'b1', tripId: 2, clientEventId: 'evt-b1' }),
      ],
      outcomes: [
        http(409, 'conflict', trip({ status: 'cancelled', status_label: 'Cancelled' })),
        http(401, null, null, 'Driver authentication required.'),
      ],
    });

    await context.worker.drain('token');

    expect(context.store.items.map((entry) => entry.id)).toEqual(['b1']);
    const notice = context.events.find((event) => event.type === 'notice');
    expect(notice).toEqual({ type: 'notice', code: 'conflict' });
  });

  it('4. on event_id_reused discards the item as applied', async () => {
    const context = harness({ items: [item()], outcomes: [http(409, 'event_id_reused', trip())] });

    await context.worker.drain('token');

    expect(context.store.items).toHaveLength(0);
    expect(context.sent).toHaveLength(1);
  });

  it('5. on a 400 illegal edge drops the item and refreshes the trip', async () => {
    const context = harness({
      items: [item()],
      outcomes: [
        http(400, null, null, 'That action is not allowed from this state.'),
      ],
      fetched: trip({ status: 'in_transit', status_label: 'En route' }),
    });

    await context.worker.drain('token');

    expect(context.store.items).toHaveLength(0);
    expect(context.fetches).toEqual([1]);
    const refreshed = context.events.filter((event) => event.type === 'trip');
    expect(refreshed).toEqual([
      { type: 'trip', trip: trip({ status: 'in_transit', status_label: 'En route' }) },
    ]);
    expect(context.events.some((event) => event.type === 'applied')).toBe(true);
  });

  it('6. on 401 halts, preserves the queue and sends nothing else', async () => {
    const context = harness({
      items: [
        item({ id: 'a1', tripId: 1, clientEventId: 'evt-a1' }),
        item({ id: 'b1', tripId: 2, clientEventId: 'evt-b1' }),
      ],
      outcomes: [http(401, null, null, 'Driver authentication required.')],
    });

    await context.worker.drain('token');

    expect(context.worker.isHalted()).toBe(true);
    expect(context.store.items).toHaveLength(2);
    expect(context.sent).toHaveLength(1);

    await context.worker.drain('token');
    expect(context.sent).toHaveLength(1);
  });

  it('7. on 403 drops that trip\'s items and keeps other trips', async () => {
    const context = harness({
      items: [
        item({ id: 'a1', tripId: 1, clientEventId: 'evt-a1' }),
        item({ id: 'a2', tripId: 1, clientEventId: 'evt-a2', to: 'in_transit', expectedStatus: 'accepted' }),
        item({ id: 'b1', tripId: 2, clientEventId: 'evt-b1' }),
      ],
      outcomes: [
        http(403, null, null, 'This response is assigned to another unit.'),
        http(401, null, null, 'Driver authentication required.'),
      ],
    });

    await context.worker.drain('token');

    expect(context.store.items.map((entry) => entry.id)).toEqual(['b1']);
    expect(context.events.find((event) => event.type === 'notice')).toEqual({
      type: 'notice',
      code: 'reassigned',
    });
  });

  it('8. on 404 drops that trip\'s items and keeps other trips', async () => {
    const context = harness({
      items: [
        item({ id: 'a1', tripId: 1, clientEventId: 'evt-a1' }),
        item({ id: 'b1', tripId: 2, clientEventId: 'evt-b1' }),
      ],
      outcomes: [
        http(404, null, null, 'Trip not found.'),
        http(401, null, null, 'Driver authentication required.'),
      ],
    });

    await context.worker.drain('token');

    expect(context.store.items.map((entry) => entry.id)).toEqual(['b1']);
    expect(context.events.find((event) => event.type === 'notice')).toEqual({
      type: 'notice',
      code: 'missing',
    });
  });

  it('9. retries three 5xx responses then applies the same event exactly once', async () => {
    const context = harness({
      items: [item({ clientEventId: 'stable-event' })],
      outcomes: [http(500, null), http(502, null), http(503, null), ok(false, trip({ status: 'accepted' }))],
    });

    await context.worker.drain('token');

    expect(context.sent).toHaveLength(4);
    expect(context.sent.map((entry) => entry.clientEventId)).toEqual([
      'stable-event',
      'stable-event',
      'stable-event',
      'stable-event',
    ]);
    expect(context.sent.map((entry) => entry.expectedStatus)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
    expect(context.store.items).toHaveLength(0);
    expect(context.events.filter((event) => event.type === 'applied')).toHaveLength(1);
    expect(context.sleeps).toEqual([1000, 2000, 4000]);
  });

  it('11. a double tap enqueues exactly one item', async () => {
    const context = harness({ outcomes: [ok(false, trip())] });

    const first = await context.worker.enqueue(enqueueRequest(1, 'tap-one'));
    const second = await context.worker.enqueue(enqueueRequest(1, 'tap-two'));
    const repeated = await context.worker.enqueue(enqueueRequest(1, 'tap-one'));

    expect(first).toBe('queued');
    expect(second).toBe('duplicate');
    expect(repeated).toBe('duplicate');
    expect(context.store.items).toHaveLength(1);
  });

  it('12. persists through a fake storage and survives a cold start', async () => {
    const raw = new Map<string, string>();
    const port: OutboxStore = {
      async load() {
        const stored = raw.get('outbox');
        return stored === undefined ? [] : (JSON.parse(stored) as OutboxItem[]);
      },
      async save(items) {
        raw.set('outbox', JSON.stringify(items));
      },
    };
    const clock: OutboxClock = {
      now: () => BASE_TIME,
      sleep: async () => undefined,
      random: () => 0.5,
      newId: () => 'persisted-item',
    };
    const offlineTransport: OutboxTransport = {
      async send() {
        return { kind: 'network', error: 'offline' };
      },
      async fetchTrip() {
        return null;
      },
    };

    const before = createOutboxWorker({ store: port, transport: offlineTransport, clock });
    expect(await before.enqueue(enqueueRequest(7, 'evt-persisted'))).toBe('queued');

    const storedJson = raw.get('outbox');
    expect(storedJson).toBeDefined();
    expect(storedJson).toContain('evt-persisted');

    // Simulated cold start: a brand new worker over the same storage.
    const sentAfterRestart: string[] = [];
    const onlineTransport: OutboxTransport = {
      async send(_token, entry) {
        sentAfterRestart.push(entry.clientEventId);
        return ok(false, trip({ id: 7, status: 'accepted', status_label: 'Accepted' }));
      },
      async fetchTrip() {
        return null;
      },
    };
    const after = createOutboxWorker({ store: port, transport: onlineTransport, clock });
    await after.drain('token');

    expect(sentAfterRestart).toEqual(['evt-persisted']);
    expect(JSON.parse(raw.get('outbox') ?? 'null')).toEqual([]);
  });

  it('13. refuses a new item at the cap instead of dropping queued work', async () => {
    const context = harness({ outcomes: [ok(false, trip())] });

    for (let index = 0; index < QUEUE_LIMIT; index += 1) {
      const outcome = await context.worker.enqueue(enqueueRequest(index + 1, `evt-${index}`));
      expect(outcome).toBe('queued');
    }

    const overflow = await context.worker.enqueue(enqueueRequest(9_999, 'evt-overflow'));

    expect(overflow).toBe('full');
    expect(context.store.items).toHaveLength(QUEUE_LIMIT);
    expect(context.store.items[0]?.clientEventId).toBe('evt-0');
    expect(context.store.items.some((entry) => entry.clientEventId === 'evt-overflow')).toBe(false);
  });
});

describe('backoff', () => {
  it('10. follows 1/2/4/8/16/30 and holds at 30 seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoffDelay(attempt, 0.5))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it('10. jitters by at most 20 percent in either direction', () => {
    expect(backoffDelay(1, 0)).toBe(800);
    expect(backoffDelay(1, 1)).toBe(1200);
    expect(backoffDelay(6, 0)).toBe(24000);
    expect(backoffDelay(6, 1)).toBe(36000);

    for (const attempt of [1, 2, 3, 4, 5, 6, 9]) {
      const base = backoffDelay(attempt, 0.5);
      for (const random of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const delay = backoffDelay(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      }
    }
  });
});
