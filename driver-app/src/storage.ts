/**
 * Device storage.
 *
 * The unit token lives in SecureStore and nowhere else — never AsyncStorage,
 * never logs, never a URL. AsyncStorage holds the outbox queue and nothing else,
 * so no assignment data is ever persisted.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { STATUSES, type OutboxItem, type Status } from './types';

const TOKEN_KEY = 'greenroute.driver.unit_token';
const PIN_KEY = 'greenroute.driver.lock_pin';
const SHIFT_KEY = 'greenroute.driver.shift.v1';
const CHECK_KEY = 'greenroute.driver.check.v1';
const ACTIVITY_KEY = 'greenroute.driver.activity.v1';
export const OUTBOX_KEY = 'greenroute.driver.outbox.v1';

/** A shift opens at sign-in and closes on End shift. Breaks pause the clock. */
export interface ShiftRecord {
  startedAt: string;
  breakStartedAt: string | null;
  /** Break time already banked, so resuming never re-counts it. */
  breakMs?: number;
}

/** The last kit or handover check this device completed. */
export interface CheckRecord {
  at: string;
  tripId: number;
  reference: string;
  count: number;
  kind: 'equipment' | 'handover';
}

/** One line in the activity log: what the app told the driver, kept. */
export interface ActivityEntry {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  tone: 'accent' | 'warning' | 'grey';
  /** 'action' marks a response this unit closed, so Duty can count them. */
  kind?: 'note' | 'action';
  /** The trip the action belongs to, used to count each response once. */
  ref?: number;
}

const ACTIVITY_LIMIT = 60;

export async function readToken(): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(TOKEN_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export async function writeToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Nothing stored, or the keychain refused the delete; the caller still
    // drops the in-memory token and returns to the pair screen.
  }
}

export function makeId(): string {
  return Crypto.randomUUID();
}

/**
 * The PIN is a local unlock code, not a dispatch credential: it is checked on
 * this device only, and only its digest is stored. SecureStore keeps it beside
 * the unit token, so unpairing clears both.
 */
async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `greenroute:${pin}`);
}

export async function writePin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(PIN_KEY, await hashPin(pin));
}

export async function hasPin(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(PIN_KEY);
    return stored !== null && stored.length > 0;
  } catch {
    return false;
  }
}

export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(PIN_KEY);
    return stored !== null && stored === (await hashPin(pin));
  } catch {
    return false;
  }
}

export async function clearPin(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PIN_KEY);
  } catch {
    // No lock was stored; nothing else to do.
  }
}

function asStatus(value: unknown): Status | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as Status)
    : null;
}

function parseItem(value: unknown): OutboxItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const to = asStatus(record.to);
  const expectedStatus = asStatus(record.expectedStatus);
  const id = typeof record.id === 'string' ? record.id : null;
  const clientEventId =
    typeof record.clientEventId === 'string' ? record.clientEventId : null;
  const clientAt = typeof record.clientAt === 'string' ? record.clientAt : null;
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : null;
  const tripId = typeof record.tripId === 'number' ? record.tripId : null;
  const attempts = typeof record.attempts === 'number' ? record.attempts : 0;
  const lastError = typeof record.lastError === 'string' ? record.lastError : null;

  if (
    id === null ||
    clientEventId === null ||
    clientAt === null ||
    createdAt === null ||
    tripId === null ||
    to === null ||
    expectedStatus === null
  ) {
    return null;
  }

  return {
    id,
    tripId,
    to,
    expectedStatus,
    clientEventId,
    clientAt,
    attempts,
    createdAt,
    lastError,
  };
}

export async function loadQueue(): Promise<OutboxItem[]> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(OUTBOX_KEY);
  } catch {
    return [];
  }
  if (raw === null || raw.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: OutboxItem[] = [];
    for (const entry of parsed) {
      const item = parseItem(entry);
      if (item !== null) {
        items.push(item);
      }
    }
    return items;
  } catch {
    return [];
  }
}

export async function saveQueue(items: OutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
}

function asIso(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

async function readJson(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused the write; the in-memory state is still correct for this
    // session, and nothing here is authoritative for dispatch.
  }
}

export async function readShift(): Promise<ShiftRecord | null> {
  const parsed = await readJson(SHIFT_KEY);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const startedAt = asIso(record.startedAt);
  if (startedAt === null) {
    return null;
  }
  const breakStartedAt = record.breakStartedAt === null ? null : asIso(record.breakStartedAt);
  const breakMs = typeof record.breakMs === 'number' && record.breakMs > 0 ? record.breakMs : 0;
  return { startedAt, breakStartedAt, breakMs };
}

export async function writeShift(shift: ShiftRecord): Promise<void> {
  await writeJson(SHIFT_KEY, shift);
}

export async function clearShift(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SHIFT_KEY);
  } catch {
    // Nothing stored.
  }
}

export async function readCheck(): Promise<CheckRecord | null> {
  const parsed = await readJson(CHECK_KEY);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const at = asIso(record.at);
  const reference = typeof record.reference === 'string' ? record.reference : null;
  const count = typeof record.count === 'number' ? record.count : null;
  const tripId = typeof record.tripId === 'number' ? record.tripId : null;
  const kind = record.kind === 'handover' ? 'handover' : 'equipment';
  if (at === null || reference === null || count === null || tripId === null) {
    return null;
  }
  return { at, tripId, reference, count, kind };
}

export async function writeCheck(check: CheckRecord): Promise<void> {
  await writeJson(CHECK_KEY, check);
}

export async function readActivity(): Promise<ActivityEntry[]> {
  const parsed = await readJson(ACTIVITY_KEY);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: ActivityEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    const at = asIso(record.at);
    const title = typeof record.title === 'string' ? record.title : null;
    const tone =
      record.tone === 'warning' ? 'warning' : record.tone === 'grey' ? 'grey' : 'accent';
    if (id === null || at === null || title === null) {
      continue;
    }
    entries.push({
      id,
      at,
      title,
      detail: typeof record.detail === 'string' ? record.detail : null,
      tone,
      kind: record.kind === 'action' ? 'action' : 'note',
      ...(typeof record.ref === 'number' ? { ref: record.ref } : {}),
    });
  }
  return entries.slice(0, ACTIVITY_LIMIT);
}

export async function writeActivity(entries: ActivityEntry[]): Promise<void> {
  await writeJson(ACTIVITY_KEY, entries.slice(0, ACTIVITY_LIMIT));
}

export async function clearActivity(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ACTIVITY_KEY);
    await AsyncStorage.removeItem(CHECK_KEY);
  } catch {
    // Nothing stored.
  }
}
