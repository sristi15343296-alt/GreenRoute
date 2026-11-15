/**
 * Durable, bounded telemetry buffer.
 *
 * Separate key from the outbox: a queued *action* is a decision the driver made,
 * while a queued *fix* is a position that stops being useful within minutes.
 * They have different lifetimes and different failure rules, so they never share
 * a row.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { BUFFER_LIMIT, type BufferedState, type Fix } from './location';

export const TELEMETRY_KEY = 'greenroute.driver.telemetry.v1';

function parseFix(value: unknown): Fix | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const lat = entry.lat;
  const lng = entry.lng;
  const accuracy = entry.accuracy_m;
  const deviceTime = entry.device_time;
  const clientFixId = entry.client_fix_id;
  const sequence = entry.sequence;
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    typeof accuracy !== 'number' ||
    typeof deviceTime !== 'string' ||
    typeof clientFixId !== 'string' ||
    typeof sequence !== 'number'
  ) {
    return null;
  }
  const heading = entry.heading_deg;
  const speed = entry.speed_mps;
  return {
    lat,
    lng,
    accuracy_m: accuracy,
    heading_deg: typeof heading === 'number' ? heading : null,
    speed_mps: typeof speed === 'number' ? speed : null,
    device_time: deviceTime,
    client_fix_id: clientFixId,
    sequence,
  };
}

export async function loadTelemetry(): Promise<BufferedState> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(TELEMETRY_KEY);
  } catch {
    return { sequence: 0, fixes: [] };
  }
  if (raw === null || raw.length === 0) {
    return { sequence: 0, fixes: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { sequence: 0, fixes: [] };
    }
    const record = parsed as Record<string, unknown>;
    const sequence = typeof record.sequence === 'number' ? record.sequence : 0;
    const fixes: Fix[] = [];
    if (Array.isArray(record.fixes)) {
      for (const entry of record.fixes) {
        const fix = parseFix(entry);
        if (fix !== null) {
          fixes.push(fix);
        }
      }
    }
    return { sequence, fixes: fixes.slice(-BUFFER_LIMIT) };
  } catch {
    return { sequence: 0, fixes: [] };
  }
}

export async function saveTelemetry(state: BufferedState): Promise<void> {
  try {
    await AsyncStorage.setItem(
      TELEMETRY_KEY,
      JSON.stringify({ sequence: state.sequence, fixes: state.fixes.slice(-BUFFER_LIMIT) })
    );
  } catch {
    // Losing a buffered fix is survivable; failing the caller is not.
  }
}

export async function clearTelemetry(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TELEMETRY_KEY);
  } catch {
    // Nothing to do: the next save overwrites it.
  }
}
