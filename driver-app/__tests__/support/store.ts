/**
 * Test-only stand-in for the store module.
 *
 * The real store boots on mount (SecureStore, AsyncStorage, a transport worker),
 * which has nothing to do with the presentation layer these render tests cover.
 * The fixture is typed as `StoreValue`, so it cannot drift from the real shape
 * while leaving `store.ts` itself untouched.
 */

import type { PairResult, Route, StoreValue } from '../../src/store';
import type { Trip } from '../../src/types';

let current: StoreValue = makeStore();

export function makeStore(overrides: Partial<StoreValue> = {}): StoreValue {
  const base: StoreValue = {
    ready: true,
    loaded: true,
    token: 'token-med12',
    callSign: 'MED-12',
    vehicleType: 'als_ambulance',
    assignment: null,
    queueCount: 0,
    trips: {},
    assignments: null,
    outbox: [],
    offline: false,
    serverTime: '2026-11-13T09:04:00Z',
    stack: [{ name: 'home' }],
    notice: null,
    pairNotice: null,
    locked: false,
    shift: { startedAt: '2026-11-13T07:42:00Z', breakStartedAt: null },
    lastCheck: null,
    activity: [],
    nowMs: Date.parse('2026-11-13T09:04:00Z'),
    elapsedMs: 0,
    onBreak: false,
    availability: 'available',
    toggleBreak: jest.fn(async (): Promise<void> => undefined),
    endShift: jest.fn(async (): Promise<void> => undefined),
    flushOutbox: jest.fn(async (): Promise<void> => undefined),
    flushTelemetry: jest.fn(async (): Promise<void> => undefined),
    telemetry: {
      state: 'off',
      message: 'Location sharing is off.',
      lastFixAt: null,
      lastSentAt: null,
      buffered: 0,
      sent: 0,
      accuracyM: null,
      degraded: false,
    },
    recordCheck: jest.fn(async (): Promise<void> => undefined),
    route: { name: 'home' } as Route,
    pendingCount: 0,
    unconfirmedCount: 0,
    pendingTripIds: [],
    isPending: (): boolean => false,
    pair: jest.fn(async (): Promise<PairResult> => ({ ok: true, message: null })),
    unpair: jest.fn(async (): Promise<void> => undefined),
    refresh: jest.fn(async (): Promise<void> => undefined),
    loadTrip: jest.fn(async (): Promise<Trip | null> => null),
    loadAssignments: jest.fn(async (): Promise<void> => undefined),
    act: jest.fn(async (): Promise<void> => undefined),
    reportIssue: jest.fn(async (): Promise<string | null> => null),
    requestBackup: jest.fn(async (): Promise<string | null> => null),
    push: jest.fn(),
    pop: jest.fn(),
    switchTab: jest.fn(),
    unlock: jest.fn(async (): Promise<boolean> => true),
    unlockWithBiometrics: jest.fn(),
    setPin: jest.fn(async (): Promise<void> => undefined),
    showNotice: jest.fn(),
    clearNotice: jest.fn(),
  };
  return { ...base, ...overrides };
}

export function setStore(next: StoreValue): void {
  current = next;
}

export function useStore(): StoreValue {
  return current;
}
