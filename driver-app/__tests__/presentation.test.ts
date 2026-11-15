import { formatDispatchAt, formatDistance, formatDuration } from '../src/format';
import { priorityTint, statusTint } from '../src/theme';
import { hasCoordinates, primaryAction, type Trip } from '../src/types';

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 1,
    reference: 'GR-1001',
    status: 'scheduled',
    status_label: 'Scheduled',
    priority: 'high',
    priority_label: 'High',
    emergency_type: null,
    origin: 'Andheri Station',
    destination: 'Marol Fire Station',
    origin_lat: null,
    origin_lng: null,
    destination_lat: null,
    destination_lng: null,
    distance_km: null,
    duration_min: null,
    dispatch_at: '',
    instructions: null,
    incident_reference: null,
    timeline: [],
    next_actions: ['accept'],
    ...overrides,
  };
}

describe('primaryAction', () => {
  it('takes the first server action verbatim', () => {
    expect(primaryAction(trip({ next_actions: ['accept'] }))).toBe('accept');
    expect(primaryAction(trip({ next_actions: ['depart'] }))).toBe('depart');
    expect(primaryAction(trip({ next_actions: ['arrive'] }))).toBe('arrive');
    expect(primaryAction(trip({ next_actions: ['complete'] }))).toBe('complete');
  });

  it('offers nothing when the server offers nothing', () => {
    expect(primaryAction(trip({ status: 'completed', next_actions: [] }))).toBeNull();
    expect(primaryAction(trip({ status: 'cancelled', next_actions: [] }))).toBeNull();
  });

  it('never derives an action from the status itself', () => {
    // An `accepted` trip is not "departed" by the client: only the server decides.
    expect(primaryAction(trip({ status: 'accepted', next_actions: [] }))).toBeNull();
    expect(primaryAction(trip({ status: 'scheduled', next_actions: ['complete'] }))).toBe('complete');
  });
});

describe('statusTint', () => {
  it('maps every status to its tint', () => {
    expect(statusTint('scheduled')).toBe('#8d938a');
    expect(statusTint('accepted')).toBe('#5ea8e6');
    expect(statusTint('in_transit')).toBe('#e3b04b');
    expect(statusTint('on_scene')).toBe('#a98bf5');
    expect(statusTint('completed')).toBe('#6fd08c');
    expect(statusTint('cancelled')).toBe('#e5674f');
  });

  it('keeps scheduled and accepted visually distinct', () => {
    expect(statusTint('scheduled')).not.toBe(statusTint('accepted'));
  });
});

describe('priorityTint', () => {
  it('maps every priority to its tint', () => {
    expect(priorityTint('critical')).toBe('#e5674f');
    expect(priorityTint('high')).toBe('#e3b04b');
    expect(priorityTint('normal')).toBe('#8d938a');
  });
});

describe('hasCoordinates', () => {
  it('gates Navigate on both destination values', () => {
    expect(hasCoordinates(trip())).toBe(false);
    expect(hasCoordinates(trip({ destination_lat: 19.12 }))).toBe(false);
    expect(hasCoordinates(trip({ destination_lng: 72.88 }))).toBe(false);
    expect(hasCoordinates(trip({ destination_lat: 19.12, destination_lng: 72.88 }))).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    expect(hasCoordinates(trip({ destination_lat: Number.NaN, destination_lng: 72.88 }))).toBe(
      false
    );
    expect(
      hasCoordinates(trip({ destination_lat: 19.12, destination_lng: Number.POSITIVE_INFINITY }))
    ).toBe(false);
  });
});

describe('nullable trip fields', () => {
  it('renders nothing at all for missing numbers instead of NaN', () => {
    expect(formatDistance(null)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatDistance(0)).toBe('0 km');
    expect(formatDistance(12.34)).toBe('12.3 km');
    expect(formatDuration(18)).toBe('18 min');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(120)).toBe('2 h');
  });

  it('renders nothing for an unusable dispatch time', () => {
    expect(formatDispatchAt('')).toBeNull();
    expect(formatDispatchAt(null)).toBeNull();
    expect(formatDispatchAt('not a date')).toBeNull();
  });

  it('omits the date when the dispatch time is today', () => {
    const now = new Date(2026, 10, 12, 18, 0, 0);
    expect(formatDispatchAt('2026-11-12T14:30', now)).toBe('14:30');
    expect(formatDispatchAt('2026-11-10T14:30', now)).toBe('10 Nov · 14:30');
  });
});
