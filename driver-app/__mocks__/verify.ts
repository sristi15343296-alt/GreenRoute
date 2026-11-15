/**
 * Protocol probe against the mock dispatch server.
 *
 *   npm run verify:mock
 *
 * Exercises the replay path and every failure branch in §4.4 with real HTTP,
 * then prints the outbox decision the app would take for each response.
 */

import { createMockServer } from './mockApi.ts';
import { decide } from '../src/outbox.ts';
import type { OutboxItem } from '../src/types.ts';

const PORT = Number(process.env.MOCK_VERIFY_PORT ?? '5099');
const BASE = `http://127.0.0.1:${PORT}`;
const MED12 = 'token-med12';

interface ResponseBody {
  [key: string]: unknown;
}

interface ProbeResponse {
  status: number;
  body: ResponseBody;
}

const out: string[] = [];

function line(text: string): void {
  out.push(text);
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  token: string | null,
  body?: Record<string, unknown>
): Promise<ProbeResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  return {
    status: response.status,
    body: typeof parsed === 'object' && parsed !== null ? (parsed as ResponseBody) : {},
  };
}

function transitionBody(to: string, expected: string, eventId: string): Record<string, unknown> {
  return {
    to,
    expected_status: expected,
    client_event_id: eventId,
    client_at: new Date().toISOString(),
  };
}

function outboxItem(tripId: number, to: OutboxItem['to'], expected: OutboxItem['expectedStatus']): OutboxItem {
  return {
    id: `probe-${tripId}-${to}`,
    tripId,
    to,
    expectedStatus: expected,
    clientEventId: 'probe',
    clientAt: new Date().toISOString(),
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastError: null,
  };
}

function verdictOf(response: ProbeResponse, item: OutboxItem): string {
  const reason = typeof response.body.reason === 'string' ? response.body.reason : null;
  const error = typeof response.body.error === 'string' ? response.body.error : 'error';
  return decide(item, {
    kind: 'http',
    status: response.status,
    error,
    reason,
    trip: null,
  });
}

function eventsOfKind(state: ResponseBody, kind: string): number {
  const trips = state.trips;
  if (!Array.isArray(trips)) {
    return 0;
  }
  let count = 0;
  for (const entry of trips) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as ResponseBody;
    const events = record.events;
    if (!Array.isArray(events)) {
      continue;
    }
    count += events.filter(
      (event) => typeof event === 'object' && event !== null && (event as ResponseBody).kind === kind
    ).length;
  }
  return count;
}

async function main(): Promise<void> {
  const { server, close } = createMockServer();
  await new Promise<void>((resolve) => {
    server.listen(PORT, '127.0.0.1', resolve);
  });

  try {
    // 4. Replay the same client_event_id twice.
    await call('POST', '/__control/reset', null);
    const first = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('accepted', 'scheduled', 'verify-replay-1')
    );
    const second = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('accepted', 'scheduled', 'verify-replay-1')
    );
    const state = await call('GET', '/__control/state', null);
    line(
      `[replay] first=${first.status} replayed=${String(first.body.replayed)} · second=${second.status} replayed=${String(second.body.replayed)} · stored accepted events=${eventsOfKind(state.body, 'accepted')}`
    );

    // 5a. 409 conflict after dispatch cancels while the phone was away.
    await call('POST', '/__control/reset', null);
    await call('POST', '/__control/cancel', null, { tripId: 1 });
    const conflict = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('accepted', 'scheduled', 'verify-conflict-1')
    );
    line(
      `[409 conflict] status=${conflict.status} reason=${String(conflict.body.reason)} server_status=${String((conflict.body.trip as ResponseBody | undefined)?.status)} decision=${verdictOf(conflict, outboxItem(1, 'accepted', 'scheduled'))}`
    );

    // 5b. 401 with a revoked token.
    const unauthorised = await call('GET', '/api/driver/unit', 'revoked-token');
    line(
      `[401] status=${unauthorised.status} error="${String(unauthorised.body.error)}" decision=${decide(outboxItem(1, 'accepted', 'scheduled'), { kind: 'http', status: unauthorised.status, error: String(unauthorised.body.error), reason: null, trip: null })}`
    );

    // 5c. 403 for another unit's response.
    const forbidden = await call(
      'POST',
      '/api/driver/trips/3/transition',
      MED12,
      transitionBody('accepted', 'scheduled', 'verify-forbidden-1')
    );
    line(
      `[403] status=${forbidden.status} error="${String(forbidden.body.error)}" decision=${verdictOf(forbidden, outboxItem(3, 'accepted', 'scheduled'))}`
    );

    // 5d. 404 for a deleted response.
    const missing = await call('GET', '/api/driver/trips/9999', MED12);
    line(`[404] status=${missing.status} error="${String(missing.body.error)}" decision=${verdictOf(missing, outboxItem(9999, 'accepted', 'scheduled'))}`);

    // 5e. 400 for an illegal edge (complete from scheduled).
    await call('POST', '/__control/reset', null);
    const illegal = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('completed', 'scheduled', 'verify-illegal-1')
    );
    line(
      `[400] status=${illegal.status} error="${String(illegal.body.error)}" decision=${verdictOf(illegal, outboxItem(1, 'completed', 'scheduled'))}`
    );

    // 5f. 400 for an issue category the server does not accept.
    const badCategory = await call('POST', '/api/driver/trips/1/issue', MED12, {
      category: 'not_a_category',
    });
    const otherWithoutNote = await call('POST', '/api/driver/trips/1/issue', MED12, {
      category: 'other',
    });
    line(
      `[400 issue] category status=${badCategory.status} error="${String(badCategory.body.error)}" · other-without-note status=${otherWithoutNote.status} error="${String(otherWithoutNote.body.error)}"`
    );

    // Issue and backup never change status.
    await call('POST', '/__control/reset', null);
    const issue = await call('POST', '/api/driver/trips/1/issue', MED12, {
      category: 'blocked_route',
    });
    const backup = await call('POST', '/api/driver/trips/1/backup', MED12, {});
    const afterEvents = await call('GET', '/__control/state', null);
    line(
      `[issue+backup] issue_status=${String((issue.body.trip as ResponseBody | undefined)?.status)} backup_status=${String((backup.body.trip as ResponseBody | undefined)?.status)} issue_events=${eventsOfKind(afterEvents.body, 'issue')} backup_events=${eventsOfKind(afterEvents.body, 'backup_requested')}`
    );

    // 409 event_id_reused: the same id used for a different action.
    await call('POST', '/__control/reset', null);
    const reuseFirst = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('accepted', 'scheduled', 'verify-reuse-1')
    );
    const reuseSecond = await call(
      'POST',
      '/api/driver/trips/1/transition',
      MED12,
      transitionBody('in_transit', 'accepted', 'verify-reuse-1')
    );
    line(
      `[409 reused] first=${reuseFirst.status} second=${reuseSecond.status} reason=${String(reuseSecond.body.reason)} decision=${verdictOf(reuseSecond, outboxItem(1, 'in_transit', 'accepted'))}`
    );

    // The full forward sequence against a fresh trip.
    await call('POST', '/__control/reset', null);
    const steps: Array<[string, string, string]> = [
      ['accept', 'accepted', 'scheduled'],
      ['depart', 'in_transit', 'accepted'],
      ['arrive', 'on_scene', 'in_transit'],
      ['complete', 'completed', 'on_scene'],
    ];
    let cursor = 0;
    for (const [, to, expected] of steps) {
      cursor += 1;
      const result = await call(
        'POST',
        '/api/driver/trips/1/transition',
        MED12,
        transitionBody(to, expected, `verify-sequence-${cursor}`)
      );
      line(
        `[sequence] ${to} status=${result.status} trip_status=${String((result.body.trip as ResponseBody | undefined)?.status)} next_actions=${JSON.stringify((result.body.trip as ResponseBody | undefined)?.next_actions)}`
      );
    }
    const finalState = await call('GET', '/__control/state', null);
    line(
      `[sequence] driver-sourced accepted/departed/arrived/completed events=${eventsOfKind(finalState.body, 'accepted') + eventsOfKind(finalState.body, 'departed') + eventsOfKind(finalState.body, 'arrived') + eventsOfKind(finalState.body, 'completed')}`
    );
  } finally {
    await close();
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

void main();
