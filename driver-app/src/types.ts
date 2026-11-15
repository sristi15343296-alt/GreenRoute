/**
 * Wire types for the GreenRoute driver API.
 *
 * The trip projection is an allow-list on the server: exactly these twenty keys
 * leave `/api/driver/*`. Nothing here is derived locally except presentation
 * helpers that never change a value the server sent.
 */

import { copy } from './copy';

export const STATUSES = [
  'scheduled',
  'accepted',
  'in_transit',
  'on_scene',
  'completed',
  'cancelled',
] as const;

export type Status = (typeof STATUSES)[number];

export const ACTIONS = ['accept', 'depart', 'arrive', 'complete'] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * The raw status each forward action produces. This is the only place the app
 * maps an action to a target status; the action itself always comes from the
 * server's `next_actions`.
 */
export const ACTION_TARGETS: Record<Action, Status> = {
  accept: 'accepted',
  depart: 'in_transit',
  arrive: 'on_scene',
  complete: 'completed',
};

export const ACTION_LABELS: Record<Action, string> = {
  accept: copy.accept,
  depart: copy.depart,
  arrive: copy.arrive,
  complete: copy.complete,
};

export const PRIORITIES = ['critical', 'high', 'normal'] as const;

export type Priority = (typeof PRIORITIES)[number];

export const ISSUE_CATEGORIES = [
  { value: 'blocked_route', label: 'Blocked route', requiresNote: false },
  { value: 'scene_unsafe', label: 'Scene unsafe', requiresNote: false },
  { value: 'access_denied', label: 'Access denied', requiresNote: false },
  { value: 'vehicle_breakdown', label: 'Vehicle breakdown', requiresNote: false },
  { value: 'wrong_location', label: 'Wrong location', requiresNote: false },
  { value: 'other', label: 'Other', requiresNote: true },
] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]['value'];

export const NOTE_LIMIT = 300;

export interface TimelineEvent {
  kind: string;
  message: string;
  created_at: string;
  actor: 'driver' | null;
  source: 'driver' | null;
  client_at: string | null;
}

export interface Trip {
  id: number;
  reference: string;
  status: Status;
  status_label: string;
  priority: Priority;
  priority_label: string;
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
  timeline: TimelineEvent[];
  next_actions: Action[];
  /**
   * The road geometry dispatch resolved, as [lat, lng] pairs. Null until the
   * response has been routed, in which case the map draws a direct line rather
   * than pretending to know the road.
   */
  route?: Array<[number, number]> | null;
}

export interface UnitResponse {
  call_sign: string;
  vehicle_type: string;
  assignment: Trip | null;
  queue_count: number;
  server_time: string;
}

export interface AssignmentsResponse {
  assignments: Trip[];
  count: number;
}

export interface TransitionBody {
  to: Status;
  expected_status: Status;
  client_event_id: string;
  client_at: string;
}

export interface IssueEvent {
  kind: string;
  message: string;
  created_at: string;
}

export interface EventResponse {
  trip: Trip;
  event: IssueEvent;
}

/**
 * The action to offer the driver. Always the server's first next action; never
 * derived from `status`, so an unknown or empty list means no primary action.
 */
export function primaryAction(trip: Trip): Action | null {
  const [first] = trip.next_actions;
  return first ?? null;
}

/** Navigate is only possible when the server supplied both destination values. */
export function hasCoordinates(trip: Trip): boolean {
  return (
    typeof trip.destination_lat === 'number' &&
    Number.isFinite(trip.destination_lat) &&
    typeof trip.destination_lng === 'number' &&
    Number.isFinite(trip.destination_lng)
  );
}

/**
 * One queued forward transition. Written to AsyncStorage before the first send
 * and only removed when the server has given a definitive answer.
 */
export interface OutboxItem {
  id: string;
  tripId: number;
  to: Status;
  expectedStatus: Status;
  clientEventId: string;
  clientAt: string;
  attempts: number;
  createdAt: string;
  lastError: string | null;
}
