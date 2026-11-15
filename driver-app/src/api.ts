/**
 * The only module that talks to dispatch.
 *
 * Every request carries the bearer token and `Accept: application/json`, has a
 * 10 second abort budget, and returns a typed result instead of throwing. No
 * response is ever cached: there is no cache layer above `fetch`, and the server
 * marks every driver response `private, no-store`.
 */

import {
  ACTIONS,
  PRIORITIES,
  STATUSES,
  type Action,
  type AssignmentsResponse,
  type EventResponse,
  type IssueEvent,
  type OutboxItem,
  type Priority,
  type Status,
  type TimelineEvent,
  type TransitionBody,
  type Trip,
  type UnitResponse,
} from './types';

export const REQUEST_TIMEOUT_MS = 10_000;

export type ApiFailure =
  | { kind: 'network'; error: string }
  | {
      kind: 'http';
      status: number;
      error: string;
      reason: string | null;
      trip: Trip | null;
    }
  | { kind: 'invalid'; error: string };

export type ApiResult<T> = { kind: 'ok'; data: T } | ApiFailure;

export type TransitionOutcome =
  | { kind: 'ok'; replayed: boolean; trip: Trip }
  | ApiFailure;

export function apiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE;
  if (typeof configured !== 'string') {
    return '';
  }
  return configured.trim().replace(/\/+$/, '');
}

/** Host and optional port, for the read-only settings panel. */
export function apiBaseHost(): string {
  const base = apiBaseUrl();
  if (base.length === 0) {
    return 'Not configured';
  }
  return base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
}

export function failureText(failure: ApiFailure): string {
  return failure.error;
}

export function isUnauthorized(result: ApiResult<unknown> | ApiFailure): boolean {
  return result.kind === 'http' && result.status === 401;
}

type Method = 'GET' | 'POST';

interface RequestSpec {
  method: Method;
  path: string;
  token: string;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asStatus(value: unknown): Status | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as Status)
    : null;
}

function asPriority(value: unknown): Priority | null {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
    ? (value as Priority)
    : null;
}

function parseActions(value: unknown): Action[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const actions: Action[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && (ACTIONS as readonly string[]).includes(entry)) {
      actions.push(entry as Action);
    }
  }
  return actions;
}

function parseTimelineEvent(value: unknown): TimelineEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = asString(value.kind);
  const message = asString(value.message);
  const createdAt = asString(value.created_at);
  if (kind === null || message === null || createdAt === null) {
    return null;
  }
  return {
    kind,
    message,
    created_at: createdAt,
    actor: value.actor === 'driver' ? 'driver' : null,
    source: value.source === 'driver' ? 'driver' : null,
    client_at: asString(value.client_at),
  };
}

function parseTimeline(value: unknown): TimelineEvent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const events: TimelineEvent[] = [];
  for (const entry of value) {
    const event = parseTimelineEvent(entry);
    if (event === null) {
      return null;
    }
    events.push(event);
  }
  return events;
}

/** Parse the allow-listed trip projection; `null` means the body was unusable. */
export function parseTrip(value: unknown): Trip | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asInteger(value.id);
  const reference = asString(value.reference);
  const status = asStatus(value.status);
  const statusLabel = asString(value.status_label);
  const priority = asPriority(value.priority);
  const priorityLabel = asString(value.priority_label);
  const origin = asString(value.origin);
  const destination = asString(value.destination);
  const dispatchAt = asString(value.dispatch_at);
  const timeline = parseTimeline(value.timeline);
  const nextActions = parseActions(value.next_actions);

  if (
    id === null ||
    reference === null ||
    status === null ||
    statusLabel === null ||
    priority === null ||
    priorityLabel === null ||
    origin === null ||
    destination === null ||
    dispatchAt === null ||
    timeline === null ||
    nextActions === null
  ) {
    return null;
  }

  return {
    id,
    reference,
    status,
    status_label: statusLabel,
    priority,
    priority_label: priorityLabel,
    emergency_type: asString(value.emergency_type),
    origin,
    destination,
    origin_lat: asNumber(value.origin_lat),
    origin_lng: asNumber(value.origin_lng),
    destination_lat: asNumber(value.destination_lat),
    destination_lng: asNumber(value.destination_lng),
    distance_km: asNumber(value.distance_km),
    duration_min: asNumber(value.duration_min),
    dispatch_at: dispatchAt,
    instructions: asString(value.instructions),
    incident_reference: asString(value.incident_reference),
    timeline,
    next_actions: nextActions,
    route: parseRoute(value.route),
  };
}

/**
 * Geometry from dispatch, or null.
 *
 * A malformed route is not worth rejecting the whole trip over: a crew still
 * needs the address, the clock and the actions even if the shape is unusable.
 */
function parseRoute(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const points: Array<[number, number]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const lat = asNumber(entry[0]);
    const lng = asNumber(entry[1]);
    if (lat === null || lng === null) {
      return null;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    points.push([lat, lng]);
  }
  return points;
}

function parseUnit(value: unknown): UnitResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const callSign = asString(value.call_sign);
  const vehicleType = asString(value.vehicle_type);
  const queueCount = asInteger(value.queue_count);
  const serverTime = asString(value.server_time);
  if (callSign === null || vehicleType === null || queueCount === null || serverTime === null) {
    return null;
  }
  const assignment =
    value.assignment === null ? null : parseTrip(value.assignment);
  if (value.assignment !== null && assignment === null) {
    return null;
  }
  return {
    call_sign: callSign,
    vehicle_type: vehicleType,
    assignment,
    queue_count: queueCount,
    server_time: serverTime,
  };
}

function parseAssignments(value: unknown): AssignmentsResponse | null {
  if (!isRecord(value) || !Array.isArray(value.assignments)) {
    return null;
  }
  const assignments: Trip[] = [];
  for (const entry of value.assignments) {
    const trip = parseTrip(entry);
    if (trip === null) {
      return null;
    }
    assignments.push(trip);
  }
  return { assignments, count: asInteger(value.count) ?? assignments.length };
}

function parseTripEnvelope(value: unknown): Trip | null {
  if (!isRecord(value)) {
    return null;
  }
  return parseTrip(value.trip);
}

function parseTransitionEnvelope(value: unknown): { replayed: boolean; trip: Trip } | null {
  if (!isRecord(value) || value.ok !== true) {
    return null;
  }
  const trip = parseTrip(value.trip);
  if (trip === null) {
    return null;
  }
  return { replayed: value.replayed === true, trip };
}

function parseIssueEvent(value: unknown): IssueEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = asString(value.kind);
  const message = asString(value.message);
  const createdAt = asString(value.created_at);
  if (kind === null || message === null || createdAt === null) {
    return null;
  }
  return { kind, message, created_at: createdAt };
}

function parseEventEnvelope(value: unknown): EventResponse | null {
  if (!isRecord(value) || value.ok !== true) {
    return null;
  }
  const trip = parseTrip(value.trip);
  const event = parseIssueEvent(value.event);
  if (trip === null || event === null) {
    return null;
  }
  return { trip, event };
}

async function call<T>(
  spec: RequestSpec,
  parse: (value: unknown) => T | null
): Promise<ApiResult<T>> {
  const base = apiBaseUrl();
  if (base.length === 0) {
    return { kind: 'network', error: 'Dispatch address is not configured.' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${spec.token}`,
    Accept: 'application/json',
  };
  const init: RequestInit = {
    method: spec.method,
    headers,
    signal: controller.signal,
    cache: 'no-store',
  };
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(spec.body);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${spec.path}`, init);
  } catch {
    return {
      kind: 'network',
      error: timedOut
        ? 'Dispatch did not respond in time. Check the connection.'
        : 'Can’t reach dispatch. Check the connection.',
    };
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const body = isRecord(json) ? json : {};
    return {
      kind: 'http',
      status: response.status,
      error: asString(body.error) ?? `Dispatch returned ${response.status}.`,
      reason: asString(body.reason),
      trip: parseTrip(body.trip),
    };
  }

  const parsed = parse(json);
  if (parsed === null) {
    return { kind: 'invalid', error: 'Dispatch sent a response this app cannot read.' };
  }
  return { kind: 'ok', data: parsed };
}

export function fetchUnit(token: string): Promise<ApiResult<UnitResponse>> {
  return call({ method: 'GET', path: '/api/driver/unit', token }, parseUnit);
}

export function fetchAssignments(token: string): Promise<ApiResult<AssignmentsResponse>> {
  return call({ method: 'GET', path: '/api/driver/assignments', token }, parseAssignments);
}

export function fetchTrip(token: string, tripId: number): Promise<ApiResult<Trip>> {
  return call({ method: 'GET', path: `/api/driver/trips/${tripId}`, token }, parseTripEnvelope);
}

export async function postTransition(
  token: string,
  tripId: number,
  body: TransitionBody
): Promise<TransitionOutcome> {
  const result = await call(
    { method: 'POST', path: `/api/driver/trips/${tripId}/transition`, token, body },
    parseTransitionEnvelope
  );
  if (result.kind !== 'ok') {
    return result;
  }
  return { kind: 'ok', replayed: result.data.replayed, trip: result.data.trip };
}

export function postIssue(
  token: string,
  tripId: number,
  category: string,
  note: string | null
): Promise<ApiResult<EventResponse>> {
  const body: Record<string, string> = { category };
  if (note !== null && note.length > 0) {
    body.note = note;
  }
  return call(
    { method: 'POST', path: `/api/driver/trips/${tripId}/issue`, token, body },
    parseEventEnvelope
  );
}

/** What the tracker does with an upload result. */
export type TelemetryVerdict = 'ok' | 'network' | 'refused' | 'unauthorized';

/**
 * Upload a batch of fixes for this unit's active response.
 *
 * The body carries no unit id: the server derives the vehicle from the token.
 * A batch is all-or-nothing at the transport level but per-fix at the server, so
 * a `refused` answer means "these will never be accepted" and the tracker drops
 * them instead of retrying forever.
 */
export async function postTelemetry(
  token: string,
  fixes: Array<{
    lat: number;
    lng: number;
    accuracy_m: number;
    heading_deg: number | null;
    speed_mps: number | null;
    device_time: string;
    client_fix_id: string;
    sequence: number;
  }>
): Promise<TelemetryVerdict> {
  const base = apiBaseUrl();
  if (base.length === 0) {
    return 'network';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/api/driver/telemetry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fixes }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch {
    return 'network';
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    return 'ok';
  }
  if (response.status === 401) {
    return 'unauthorized';
  }
  if (response.status >= 500 || response.status === 429) {
    // Server trouble is temporary from the phone's point of view: keep the fix.
    return 'network';
  }
  return 'refused';
}

export function postBackup(
  token: string,
  tripId: number,
  note: string | null
): Promise<ApiResult<EventResponse>> {
  const body: Record<string, string> = {};
  if (note !== null && note.length > 0) {
    body.note = note;
  }
  return call(
    { method: 'POST', path: `/api/driver/trips/${tripId}/backup`, token, body },
    parseEventEnvelope
  );
}

/** Transport adapter used by the outbox worker. */
export async function sendTransition(
  token: string,
  item: OutboxItem
): Promise<TransitionOutcome> {
  return postTransition(token, item.tripId, {
    to: item.to,
    expected_status: item.expectedStatus,
    client_event_id: item.clientEventId,
    client_at: item.clientAt,
  });
}
