/** Shared fixtures for the render tests. Mirrors the wire shape in `types.ts`. */

import type { TimelineEvent, Trip } from '../../src/types';

export function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 1,
    reference: 'GR-1001',
    status: 'scheduled',
    status_label: 'Scheduled',
    priority: 'critical',
    priority_label: 'Critical',
    emergency_type: 'cardiac',
    origin: 'Andheri Station',
    destination: 'Marol Fire Station',
    origin_lat: 19.1197,
    origin_lng: 72.8464,
    destination_lat: 19.1136,
    destination_lng: 72.8697,
    distance_km: 8.4,
    duration_min: 21,
    dispatch_at: '2026-11-13T08:40:00Z',
    instructions: 'Enter from the north gate. Call on arrival.',
    incident_reference: 'INC-4412',
    timeline: [event('dispatched', 'Dispatch assigned this response.')],
    next_actions: ['accept'],
    ...overrides,
  };
}

export function event(kind: string, message: string): TimelineEvent {
  return {
    kind,
    message,
    created_at: '2026-11-13T08:41:00Z',
    actor: null,
    source: 'driver',
    client_at: null,
  };
}
