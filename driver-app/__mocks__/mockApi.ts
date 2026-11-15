/**
 * Stand-in dispatch server for development.
 *
 * Implements the driver protocol from the brief — including the 400, 401, 403,
 * 404 and 409 paths — so every failure state can be demonstrated without a
 * phone against a real server.
 *
 *   npm run mock        loopback only (device via adb reverse)
 *   npm run mock:lan    reachable from a phone on the same network
 *   EXPO_PUBLIC_API_BASE=http://<laptop-ip>:5055 npx expo start
 *
 * Tokens: token-med12 (MED-12, ambulance), token-med13 (MED-13, rescue unit).
 * Control endpoints live under /__control and are never used by the app.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

interface MockEvent {
  kind: string;
  message: string;
  created_at: string;
  actor: 'driver' | null;
  source: 'driver' | null;
  client_at: string | null;
  client_event_id: string | null;
}

interface MockTrip {
  id: number;
  reference: string;
  status: string;
  priority: string;
  emergency_type: string | null;
  origin: string;
  destination: string;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_lat: number | null;
  destination_lng: number | null;
  distance_km: number | null;
  duration_min: number | null;
  dispatch_at: string;
  instructions: string | null;
  incident_reference: string | null;
  vehicle: string;
  timeline: MockEvent[];
  /** Road geometry dispatch resolved, [lat, lng] pairs. */
  route: Array<[number, number]> | null;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  accepted: 'Accepted',
  in_transit: 'En route',
  on_scene: 'On scene',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
};

const NEXT_ACTIONS: Record<string, string[]> = {
  scheduled: ['accept'],
  accepted: ['depart'],
  in_transit: ['arrive'],
  on_scene: ['complete'],
  completed: [],
  cancelled: [],
};

const FORWARD: Record<string, string> = {
  scheduled: 'accepted',
  accepted: 'in_transit',
  in_transit: 'on_scene',
  on_scene: 'completed',
};

const EVENT_KIND: Record<string, string> = {
  accepted: 'accepted',
  in_transit: 'departed',
  on_scene: 'arrived',
  completed: 'completed',
};

const ISSUE_CATEGORIES: Record<string, string> = {
  blocked_route: 'Route is blocked.',
  scene_unsafe: 'Scene is unsafe to approach.',
  access_denied: 'Access was denied.',
  vehicle_breakdown: 'Vehicle has broken down.',
  wrong_location: 'Recorded location is wrong.',
  other: 'Other issue reported.',
};

const TOKENS: Record<string, string> = {
  'token-med12': 'MED-12',
  'token-med13': 'MED-13',
};

const VEHICLES: Record<string, string> = {
  'MED-12': 'ambulance',
  'MED-13': 'rescue_unit',
};

function now(): string {
  return `${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
}

function event(
  kind: string,
  message: string,
  extras: Partial<MockEvent> = {}
): MockEvent {
  return {
    kind,
    message,
    created_at: now(),
    actor: null,
    source: null,
    client_at: null,
    client_event_id: null,
    ...extras,
  };
}

function seed(): MockTrip[] {
  return [
    {
      id: 1,
      reference: 'GR-2024',
      status: 'scheduled',
      priority: 'high',
      emergency_type: 'medical',
      origin: 'Andheri Emergency Station, Mumbai',
      destination: 'Marol Fire Station, Mumbai',
      origin_lat: 19.1197,
      origin_lng: 72.8464,
      destination_lat: 19.1176,
      destination_lng: 72.8826,
      distance_km: 4.1,
      duration_min: 13,
      dispatch_at: `${new Date().toISOString().slice(0, 16)}`,
      instructions: null,
      incident_reference: null,
      vehicle: 'MED-12',
      route: [
        [19.1197, 72.8464],
        [19.1189, 72.8562],
        [19.1179, 72.8684],
        [19.1176, 72.8826],
      ],
      timeline: [
        event('created', 'Trip created and assigned to MED-12.'),
        event('note', 'Dispatch called the site supervisor.'),
      ],
    },
    {
      id: 2,
      reference: 'GR-2025',
      status: 'accepted',
      priority: 'critical',
      emergency_type: 'fire',
      origin: 'Marol Fire Station, Mumbai',
      destination: 'Saki Naka Industrial Estate, Mumbai',
      origin_lat: 19.1136,
      origin_lng: 72.8697,
      destination_lat: 19.0994,
      destination_lng: 72.8891,
      distance_km: 3.4,
      duration_min: 11,
      dispatch_at: `${new Date().toISOString().slice(0, 16)}`,
      instructions: 'Report to the gate on the north side. Ask for the site marshal.',
      incident_reference: 'INC-77120',
      vehicle: 'MED-12',
      route: [
        [19.1136, 72.8697],
        [19.1102, 72.8734],
        [19.1058, 72.8786],
        [19.1021, 72.8838],
        [19.0994, 72.8891],
      ],
      timeline: [event('created', 'Trip created and assigned to MED-12.')],
    },
    {
      id: 3,
      reference: 'GR-2026',
      status: 'scheduled',
      priority: 'normal',
      emergency_type: null,
      origin: 'Andheri Emergency Station, Mumbai',
      destination: 'Powai Depot, Mumbai',
      origin_lat: 19.1197,
      origin_lng: 72.8464,
      destination_lat: 19.1176,
      destination_lng: 72.906,
      distance_km: 5.8,
      duration_min: 16,
      dispatch_at: `${new Date().toISOString().slice(0, 16)}`,
      instructions: null,
      incident_reference: null,
      vehicle: 'MED-13',
      route: [
        [19.1197, 72.8464],
        [19.1188, 72.8712],
        [19.1176, 72.906],
      ],
      timeline: [event('created', 'Trip created and assigned to MED-13.')],
    },
  ];
}

const OPEN_STATUSES = ['scheduled', 'accepted', 'in_transit', 'on_scene'];

interface ForcedFailure {
  status: number;
  reason: string | null;
  message: string;
}

export interface MockServer {
  server: Server;
  close: () => Promise<void>;
}

export function createMockServer(): MockServer {
  let trips: MockTrip[] = seed();
  let forcedFailure: ForcedFailure | null = null;

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  const payload = (trip: MockTrip): Record<string, unknown> => ({
    id: trip.id,
    reference: trip.reference,
    status: trip.status,
    status_label: STATUS_LABELS[trip.status] ?? trip.status,
    priority: trip.priority,
    priority_label: PRIORITY_LABELS[trip.priority] ?? trip.priority,
    emergency_type: trip.emergency_type,
    origin: trip.origin,
    destination: trip.destination,
    origin_lat: trip.origin_lat,
    origin_lng: trip.origin_lng,
    destination_lat: trip.destination_lat,
    destination_lng: trip.destination_lng,
    distance_km: trip.distance_km,
    duration_min: trip.duration_min,
    dispatch_at: trip.dispatch_at,
    instructions: trip.instructions,
    incident_reference: trip.incident_reference,
    timeline: trip.timeline.map((entry) => ({
      kind: entry.kind,
      message: entry.message,
      created_at: entry.created_at,
      actor: entry.actor,
      source: entry.source,
      client_at: entry.client_at,
    })),
    next_actions: NEXT_ACTIONS[trip.status] ?? [],
    route: trip.route,
  });

  const unitTrips = (callSign: string): MockTrip[] =>
    trips
      .filter((trip) => trip.vehicle === callSign && OPEN_STATUSES.includes(trip.status))
      .sort((left, right) => right.id - left.id);

  const currentTrip = (callSign: string): MockTrip | null => {
    const order: Record<string, number> = { on_scene: 0, in_transit: 1, accepted: 2, scheduled: 3 };
    const open = unitTrips(callSign);
    if (open.length === 0) {
      return null;
    }
    return [...open].sort(
      (left, right) => (order[left.status] ?? 4) - (order[right.status] ?? 4)
    )[0] ?? null;
  };

  const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    if (chunks.length === 0) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/';
      const path = url.split('?')[0] ?? '/';
      const method = request.method ?? 'GET';

      // ---- control endpoints (development only) ----
      if (path === '/__control/state') {
        send(response, 200, {
          trips: trips.map((trip) => ({
            id: trip.id,
            reference: trip.reference,
            status: trip.status,
            vehicle: trip.vehicle,
            events: trip.timeline.map((entry) => ({
              kind: entry.kind,
              source: entry.source,
              actor: entry.actor,
              client_at: entry.client_at,
              created_at: entry.created_at,
            })),
          })),
        });
        return;
      }
      if (path === '/__control/reset') {
        trips = seed();
        forcedFailure = null;
        send(response, 200, { ok: true });
        return;
      }
      if (path === '/__control/fail') {
        const body = await readJson(request);
        const status = typeof body.status === 'number' ? body.status : 500;
        forcedFailure = {
          status,
          reason: typeof body.reason === 'string' ? body.reason : null,
          message:
            typeof body.error === 'string' ? body.error : 'Forced failure for testing.',
        };
        send(response, 200, { ok: true, forced: forcedFailure });
        return;
      }
      if (path === '/__control/cancel') {
        const body = await readJson(request);
        const tripId = typeof body.tripId === 'number' ? body.tripId : 0;
        const trip = trips.find((entry) => entry.id === tripId);
        if (trip === undefined) {
          send(response, 404, { error: 'Trip not found.' });
          return;
        }
        trip.status = 'cancelled';
        trip.timeline.push(event('cancelled', 'Trip cancelled by dispatch.'));
        send(response, 200, { ok: true, trip: payload(trip) });
        return;
      }

      if (!path.startsWith('/api/driver/')) {
        send(response, 404, { error: 'Not found.' });
        return;
      }

      const header = request.headers.authorization ?? '';
      const [scheme, rawToken] = header.split(' ');
      const token = scheme !== undefined && scheme.toLowerCase() === 'bearer' ? (rawToken ?? '') : '';
      const callSign = TOKENS[token];
      if (callSign === undefined) {
        send(response, 401, { error: 'Driver authentication required.' });
        return;
      }

      if (method === 'GET' && path === '/api/driver/unit') {
        const current = currentTrip(callSign);
        send(response, 200, {
          call_sign: callSign,
          vehicle_type: VEHICLES[callSign] ?? 'ambulance',
          assignment: current === null ? null : payload(current),
          queue_count: unitTrips(callSign).length,
          server_time: now(),
        });
        return;
      }

      if (method === 'GET' && path === '/api/driver/assignments') {
        const list = unitTrips(callSign);
        send(response, 200, {
          assignments: list.map((trip) => payload(trip)),
          count: list.length,
        });
        return;
      }

      const tripMatch = /^\/api\/driver\/trips\/(\d+)(\/(transition|issue|backup))?$/.exec(path);
      if (tripMatch === null) {
        send(response, 404, { error: 'Not found.' });
        return;
      }

      const tripId = Number(tripMatch[1]);
      const action = tripMatch[3] ?? null;
      const trip = trips.find((entry) => entry.id === tripId);
      if (trip === undefined) {
        send(response, 404, { error: 'Trip not found.' });
        return;
      }
      if (trip.vehicle !== callSign) {
        send(response, 403, { error: 'This response is assigned to another unit.' });
        return;
      }

      if (method === 'GET' && action === null) {
        send(response, 200, { trip: payload(trip) });
        return;
      }

      if (method !== 'POST' || action === null) {
        send(response, 405, { error: 'Method not allowed.' });
        return;
      }

      const body = await readJson(request);

      if (action === 'transition') {
        const to = asString(body.to);
        const expected = asString(body.expected_status);
        const clientEventId = asString(body.client_event_id);
        const clientAt = asString(body.client_at).slice(0, 40);

        if (to === '' || expected === '' || clientEventId === '') {
          send(response, 400, { error: 'Provide to, expected_status and client_event_id.' });
          return;
        }

        if (FORWARD[expected] !== to) {
          send(response, 400, { error: 'That action is not allowed from this state.' });
          return;
        }

        const kind = EVENT_KIND[to] ?? to;
        const stored = trip.timeline.find((entry) => entry.client_event_id === clientEventId);
        if (stored !== undefined) {
          if (stored.kind === kind) {
            send(response, 200, { ok: true, replayed: true, trip: payload(trip) });
            return;
          }
          send(response, 409, {
            error: 'That event id was already used for a different action.',
            reason: 'event_id_reused',
            trip: payload(trip),
          });
          return;
        }

        if (forcedFailure !== null) {
          const failure = forcedFailure;
          forcedFailure = null;
          send(response, failure.status, {
            error: failure.message,
            ...(failure.reason === null ? {} : { reason: failure.reason }),
            trip: payload(trip),
          });
          return;
        }

        if (trip.status !== expected) {
          send(response, 409, {
            error: 'The response changed on the server. Reload before retrying.',
            reason: 'conflict',
            trip: payload(trip),
          });
          return;
        }

        trip.status = to;
        trip.timeline.push(
          event(kind, `Driver ${to.replace('_', ' ')} this response.`, {
            actor: 'driver',
            source: 'driver',
            client_at: clientAt === '' ? null : clientAt,
            client_event_id: clientEventId,
          })
        );
        send(response, 200, { ok: true, replayed: false, trip: payload(trip) });
        return;
      }

      if (action === 'issue') {
        const category = asString(body.category);
        const note = asString(body.note).slice(0, 300);
        if (ISSUE_CATEGORIES[category] === undefined) {
          send(response, 400, { error: 'Choose a supported issue category.' });
          return;
        }
        if (category === 'other' && note === '') {
          send(response, 400, { error: 'Describe the issue when choosing other.' });
          return;
        }
        let message = ISSUE_CATEGORIES[category] ?? 'Issue reported.';
        if (note !== '') {
          message = `${message} ${note}`;
        }
        const created = event('issue', message, { actor: 'driver', source: 'driver' });
        trip.timeline.push(created);
        send(response, 200, {
          ok: true,
          trip: payload(trip),
          event: {
            kind: created.kind,
            message: created.message,
            created_at: created.created_at,
          },
        });
        return;
      }

      const note = asString(body.note).slice(0, 300);
      let message = 'Driver requested backup.';
      if (note !== '') {
        message = `${message} ${note}`;
      }
      const created = event('backup_requested', message, { actor: 'driver', source: 'driver' });
      trip.timeline.push(created);
      send(response, 200, {
        ok: true,
        trip: payload(trip),
        event: {
          kind: created.kind,
          message: created.message,
          created_at: created.created_at,
        },
      });
    })().catch(() => {
      if (!response.headersSent) {
        send(response, 500, { error: 'Mock server failure.' });
      } else {
        response.end();
      }
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/__mocks__/mockApi.ts') === true;

if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? '5055');
  // Loopback by default (matches the real server). `--lan` binds every
  // interface so a phone on the same network can reach it; MOCK_HOST overrides.
  const lan = process.argv.includes('--lan');
  const host = process.env.MOCK_HOST ?? (lan ? '0.0.0.0' : '127.0.0.1');
  const { server } = createMockServer();
  server.listen(port, host, () => {
    const addresses =
      host === '0.0.0.0'
        ? Object.values(networkInterfaces())
            .flatMap((entries) => entries ?? [])
            .filter((entry) => entry.family === 'IPv4' && !entry.internal)
            .map((entry) => entry.address)
        : [host];
    for (const address of addresses) {
      process.stdout.write(`GreenRoute mock dispatch listening on http://${address}:${port}\n`);
    }
    process.stdout.write('Tokens: token-med12 (MED-12), token-med13 (MED-13)\n');
  });
}
