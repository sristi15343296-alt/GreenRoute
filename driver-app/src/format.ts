/**
 * Timestamp handling without a date library.
 *
 * The server writes two different shapes:
 * - `server_time`, `timeline[].created_at` and `client_at` come from
 *   `iso_now()`: UTC wall-clock with no zone marker ("2026-11-12 20:28:00").
 * - `dispatch_at` is stored as the dispatcher's local wall-clock time with no
 *   zone marker ("2026-11-12T14:30") because it is typed into a
 *   `datetime-local` field.
 *
 * Both are rendered in the device's local time. A value that already carries a
 * zone ("...Z" or "+05:30") is honoured as is.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function toDate(value: string, assumeUtc: boolean): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let candidate = trimmed.replace(' ', 'T');
  if (!HAS_ZONE.test(candidate)) {
    candidate = assumeUtc ? `${candidate}Z` : candidate;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parse a UTC timestamp the server produced with `iso_now()`. */
export function parseServerTime(value: string | null | undefined): Date | null {
  return value ? toDate(value, true) : null;
}

/** Parse a dispatch timestamp, which is stored as local wall-clock time. */
export function parseDispatchAt(value: string | null | undefined): Date | null {
  return value ? toDate(value, false) : null;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local clock, e.g. "14:02". */
export function formatClock(date: Date | null): string | null {
  if (!date) {
    return null;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local clock for a UTC server timestamp, e.g. "14:02". */
export function formatServerClock(value: string | null | undefined): string | null {
  return formatClock(parseServerTime(value));
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

const EMERGENCY_LABELS: Record<string, string> = {
  medical: 'Medical emergency',
  fire: 'Fire or smoke',
  collision: 'Road collision',
  rescue: 'Rescue or extraction',
  hazard: 'Hazardous materials',
  welfare: 'Public welfare check',
};

const VEHICLE_LABELS: Record<string, string> = {
  ambulance: 'Ambulance',
  fire_engine: 'Fire engine',
  rescue_unit: 'Rescue unit',
  hazmat_unit: 'Hazmat unit',
  supervisor: 'Command vehicle',
};

/** Emergency category label; the raw value is shown if the server adds a new one. */
export function formatEmergencyType(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return EMERGENCY_LABELS[trimmed] ?? trimmed.replace(/_/g, ' ');
}

/** Vehicle type label for the top bar and settings panel. */
export function vehicleTypeLabel(value: string | null): string {
  if (value === null) {
    return 'Unit';
  }
  return VEHICLE_LABELS[value] ?? value.replace(/_/g, ' ');
}

/** Distance in kilometres, or nothing when the server has none. */
export function formatDistance(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} km`;
}

/** Estimated duration, or nothing when the server has none. */
export function formatDuration(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Dispatch time in local time: "14:02" today, "12 Nov · 14:02" otherwise.
 */
export function formatDispatchAt(
  value: string | null | undefined,
  now: Date = new Date()
): string | null {
  const date = parseDispatchAt(value);
  if (!date) {
    return null;
  }
  const clock = formatClock(date);
  if (!clock) {
    return null;
  }
  if (isSameLocalDay(date, now)) {
    return clock;
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()]} · ${clock}`;
}
