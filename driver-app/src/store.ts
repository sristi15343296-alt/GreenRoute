/**
 * Application state: token, unit, current assignment, outbox mirror and route.
 *
 * React state only. The server is the single source of truth for every status;
 * the outbox contributes a "Sending…" overlay and nothing else.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import * as api from './api';
import { copy } from './copy';
import { createTracker, shouldShare, type ShareView, type Tracker } from './location';
import { requestLocationPermission, watchLocation } from './locationProvider';
import { createOutboxWorker, type NoticeCode, type OutboxEvent } from './outbox';
import {
  clearActivity,
  clearPin,
  clearShift,
  clearToken,
  hasPin,
  loadQueue,
  makeId,
  readActivity,
  readCheck,
  readShift,
  readToken,
  saveQueue,
  verifyPin,
  writeActivity,
  writeCheck,
  writePin,
  writeShift,
  writeToken,
  type ActivityEntry,
  type CheckRecord,
  type ShiftRecord,
} from './storage';
import { loadTelemetry, saveTelemetry } from './telemetryStorage';
import { motion } from './theme';
import {
  ACTION_TARGETS,
  NOTE_LIMIT,
  primaryAction,
  type IssueCategory,
  type OutboxItem,
  type Trip,
  type UnitResponse,
} from './types';

export type Route =
  | { name: 'home' }
  | { name: 'queue' }
  | { name: 'history' }
  | { name: 'profile' }
  | { name: 'duty' }
  | { name: 'checklist' }
  | { name: 'trip'; tripId: number };

export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

export type { ActivityEntry, CheckRecord, ShiftRecord };

/** What the identity bar reports, derived from the shift. */
export type Availability = 'available' | 'break' | 'off';

interface State {
  ready: boolean;
  /** True once dispatch has answered with a unit payload for this session. */
  loaded: boolean;
  token: string | null;
  callSign: string | null;
  vehicleType: string | null;
  assignment: Trip | null;
  queueCount: number;
  trips: Record<number, Trip>;
  assignments: Trip[] | null;
  outbox: OutboxItem[];
  offline: boolean;
  serverTime: string | null;
  stack: Route[];
  notice: Notice | null;
  pairNotice: string | null;
  /** True when a PIN was stored for this unit and has not been entered yet. */
  locked: boolean;
  /** Open shift, created at sign-in and cleared by End shift. */
  shift: ShiftRecord | null;
  /** Last kit or handover check completed on this device. */
  lastCheck: CheckRecord | null;
  activity: ActivityEntry[];
  /** Ticks once a second while a unit is signed in. */
  nowMs: number;
  /** What the phone is doing about location sharing, and why. */
  telemetry: ShareView;
}

type StoreAction =
  | { type: 'boot/anonymous'; outbox: OutboxItem[]; pairNotice: string | null }
  | { type: 'boot/token'; token: string; outbox: OutboxItem[]; locked: boolean }
  | { type: 'unlocked' }
  | { type: 'paired'; token: string; unit: UnitResponse; outbox: OutboxItem[] }
  | { type: 'unit'; unit: UnitResponse }
  | { type: 'unit/failed' }
  | { type: 'trip'; trip: Trip }
  | { type: 'assignments'; assignments: Trip[] }
  | { type: 'outbox'; items: OutboxItem[] }
  | { type: 'notice'; notice: Notice }
  | { type: 'notice/clear' }
  | { type: 'auth/halt'; text: string }
  | { type: 'unpaired' }
  | { type: 'push'; route: Route }
  | { type: 'pop' }
  | { type: 'tab'; route: Route }
  | { type: 'shift'; shift: ShiftRecord | null }
  | { type: 'check'; check: CheckRecord }
  | { type: 'activity/add'; entry: ActivityEntry }
  | { type: 'activity'; entries: ActivityEntry[] }
  | { type: 'tick'; now: number }
  | { type: 'telemetry'; view: ShareView };

const NOTICE_COPY: Record<NoticeCode, string> = {
  conflict: copy.updatedByDispatch,
  illegal: copy.illegalTransition,
  rejected: copy.internalError,
  reassigned: copy.reassigned,
  missing: copy.noLongerExists,
};

const initialState: State = {
  ready: false,
  loaded: false,
  token: null,
  callSign: null,
  vehicleType: null,
  assignment: null,
  queueCount: 0,
  trips: {},
  assignments: null,
  outbox: [],
  offline: false,
  serverTime: null,
  stack: [{ name: 'home' }],
  notice: null,
  pairNotice: null,
  locked: false,
  shift: null,
  lastCheck: null,
  activity: [],
  nowMs: Date.now(),
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
};

function withTrip(state: State, trip: Trip): State {
  return {
    ...state,
    trips: { ...state.trips, [trip.id]: trip },
    assignment:
      state.assignment !== null && state.assignment.id === trip.id ? trip : state.assignment,
    assignments:
      state.assignments === null
        ? null
        : state.assignments.map((entry) => (entry.id === trip.id ? trip : entry)),
  };
}

function reducer(state: State, action: StoreAction): State {
  switch (action.type) {
    case 'boot/anonymous':
      return {
        ...state,
        ready: true,
        loaded: true,
        token: null,
        outbox: action.outbox,
        pairNotice: action.pairNotice,
        locked: false,
      };
    case 'boot/token':
      return {
        ...state,
        ready: true,
        token: action.token,
        outbox: action.outbox,
        locked: action.locked,
      };
    case 'unlocked':
      return { ...state, locked: false };
    case 'paired':
      return {
        ...state,
        ready: true,
        loaded: true,
        token: action.token,
        callSign: action.unit.call_sign,
        vehicleType: action.unit.vehicle_type,
        assignment: action.unit.assignment,
        queueCount: action.unit.queue_count,
        serverTime: action.unit.server_time,
        offline: false,
        outbox: action.outbox,
        pairNotice: null,
        locked: false,
        // The stored check was dispatched just before this, when boot read it.
        lastCheck: state.lastCheck,
        stack: [{ name: 'home' }],
      };
    case 'unit':
      return {
        ...state,
        loaded: true,
        callSign: action.unit.call_sign,
        vehicleType: action.unit.vehicle_type,
        assignment: action.unit.assignment,
        queueCount: action.unit.queue_count,
        serverTime: action.unit.server_time,
        offline: false,
        trips:
          action.unit.assignment === null
            ? state.trips
            : { ...state.trips, [action.unit.assignment.id]: action.unit.assignment },
      };
    case 'unit/failed':
      return { ...state, offline: true };
    case 'trip':
      return withTrip(state, action.trip);
    case 'assignments':
      return {
        ...state,
        assignments: action.assignments,
        trips: action.assignments.reduce<Record<number, Trip>>(
          (accumulator, trip) => ({ ...accumulator, [trip.id]: trip }),
          state.trips
        ),
      };
    case 'outbox':
      return { ...state, outbox: action.items };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'notice/clear':
      return { ...state, notice: null };
    case 'auth/halt':
      return {
        ...state,
        loaded: false,
        token: null,
        callSign: null,
        vehicleType: null,
        assignment: null,
        queueCount: 0,
        trips: {},
        assignments: null,
        offline: false,
        stack: [{ name: 'home' }],
        notice: null,
        pairNotice: action.text,
        locked: false,
      };
    case 'unpaired':
      return {
        ...initialState,
        ready: true,
        stack: [{ name: 'home' }],
      };
    case 'push':
      return { ...state, stack: [...state.stack, action.route] };
    case 'pop':
      return state.stack.length <= 1 ? state : { ...state, stack: state.stack.slice(0, -1) };
    case 'shift':
      return { ...state, shift: action.shift };
    case 'check':
      return { ...state, lastCheck: action.check };
    case 'activity/add':
      return { ...state, activity: [action.entry, ...state.activity].slice(0, 60) };
    case 'activity':
      return { ...state, activity: action.entries };
    case 'tick':
      return { ...state, nowMs: action.now };
    case 'telemetry':
      return { ...state, telemetry: action.view };
    case 'tab':
      // Tabs are siblings, not history: switching one resets the stack to Home
      // plus that tab, so Back always walks out to Home rather than replaying
      // every tab the driver visited.
      return {
        ...state,
        stack: action.route.name === 'home' ? [{ name: 'home' }] : [{ name: 'home' }, action.route],
      };
    default:
      return state;
  }
}

export interface PairResult {
  ok: boolean;
  message: string | null;
}

export interface StoreValue extends State {
  route: Route;
  pendingCount: number;
  unconfirmedCount: number;
  pendingTripIds: number[];
  isPending: (tripId: number) => boolean;
  pair: (code: string) => Promise<PairResult>;
  unpair: () => Promise<void>;
  refresh: () => Promise<void>;
  loadTrip: (tripId: number) => Promise<Trip | null>;
  loadAssignments: () => Promise<void>;
  act: (trip: Trip) => Promise<void>;
  reportIssue: (trip: Trip, category: IssueCategory, note: string) => Promise<string | null>;
  requestBackup: (trip: Trip, note: string) => Promise<string | null>;
  push: (route: Route) => void;
  pop: () => void;
  switchTab: (route: Route) => void;
  /** Clears the local unlock code. Returns false when it does not match. */
  unlock: (pin: string) => Promise<boolean>;
  /** Opens the app after the OS has already verified the driver. */
  unlockWithBiometrics: () => void;
  /** Stores the unlock code beside the unit token. */
  setPin: (pin: string) => Promise<void>;
  /** Milliseconds on shift, with breaks removed. Ticks once a second. */
  elapsedMs: number;
  onBreak: boolean;
  availability: Availability;
  toggleBreak: () => Promise<void>;
  endShift: () => Promise<void>;
  /** Drains the queue now instead of waiting for the next backoff step. */
  flushOutbox: () => Promise<void>;
  /** Uploads buffered positions now, e.g. after the driver taps "retry". */
  flushTelemetry: () => Promise<void>;
  recordCheck: (
    trip: Trip,
    count: number,
    kind: 'equipment' | 'handover',
    note?: string
  ) => Promise<void>;
  showNotice: (text: string, tone?: Notice['tone']) => void;
  clearNotice: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const tokenRef = useRef<string | null>(null);
  const eventHandlerRef = useRef<(event: OutboxEvent) => void>(() => undefined);

  useEffect(() => {
    tokenRef.current = state.token;
  }, [state.token]);

  const worker = useMemo(
    () =>
      createOutboxWorker({
        store: { load: loadQueue, save: saveQueue },
        transport: {
          send: (token, item) => api.sendTransition(token, item),
          fetchTrip: async (token, tripId) => {
            const result = await api.fetchTrip(token, tripId);
            return result.kind === 'ok' ? result.data : null;
          },
        },
        clock: {
          now: () => Date.now(),
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            }),
          random: () => Math.random(),
          newId: () => makeId(),
        },
        onEvent: (event) => {
          eventHandlerRef.current(event);
        },
      }),
    []
  );

  /**
   * One tracker for the app's lifetime. It is created once so a re-render can
   * never start a second GPS watcher, and it reports through a ref so a state
   * update does not re-create it.
   */
  const telemetryRef = useRef<(view: ShareView) => void>(() => undefined);
  telemetryRef.current = (view: ShareView) => dispatch({ type: 'telemetry', view });

  const tracker: Tracker = useMemo(
    () =>
      createTracker({
        requestPermission: requestLocationPermission,
        watch: watchLocation,
        send: (token, fixes) => api.postTelemetry(token, fixes),
        load: loadTelemetry,
        save: saveTelemetry,
        onChange: (view) => telemetryRef.current(view),
      }),
    []
  );

  // Share only while the response is actually en route: the server accepts
  // telemetry for an ACTIVE emergency session and nothing else.
  const shareable =
    state.token !== null && state.callSign !== null && shouldShare(state.assignment?.status ?? null);

  useEffect(() => {
    if (state.token === null) {
      void tracker.stop();
      return;
    }
    if (shareable && state.callSign !== null) {
      void tracker.start(state.token, state.callSign);
      return;
    }
    void tracker.pause('Location sharing is off: this unit has no active response.');
  }, [shareable, state.token, state.callSign, tracker]);

  // Foreground-only by design: the OS pauses a backgrounded app's GPS anyway, so
  // the badge tells the truth instead of pretending to keep reporting.
  useEffect(() => {
    if (state.token === null) {
      return;
    }
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void tracker.resume();
      } else if (next === 'background') {
        void tracker.pause();
      }
    });
    return () => subscription.remove();
  }, [state.token, tracker]);

  const activityRef = useRef<ActivityEntry[]>([]);
  const shiftRef = useRef<ShiftRecord | null>(null);

  useEffect(() => {
    activityRef.current = state.activity;
    shiftRef.current = state.shift;
  }, [state.activity, state.shift]);

  /** One line in the activity log, persisted so a restart does not lose it. */
  const pushActivity = useCallback(
    (entry: Omit<ActivityEntry, 'id' | 'at'> & { at?: string }) => {
      const next: ActivityEntry = {
        id: makeId(),
        at: entry.at ?? new Date().toISOString(),
        title: entry.title,
        detail: entry.detail ?? null,
        tone: entry.tone,
        kind: entry.kind ?? 'note',
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
      };
      const list = [next, ...activityRef.current].slice(0, 60);
      activityRef.current = list;
      dispatch({ type: 'activity', entries: list });
      void writeActivity(list);
    },
    []
  );

  const haltForAuth = useCallback(async () => {
    await clearToken();
    tokenRef.current = null;
    dispatch({ type: 'auth/halt', text: copy.unitCodeExpired });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    const result = await api.fetchUnit(token);
    if (result.kind === 'ok') {
      dispatch({ type: 'unit', unit: result.data });
      const items = await loadQueue();
      dispatch({ type: 'outbox', items });
      return;
    }
    if (api.isUnauthorized(result)) {
      await haltForAuth();
      return;
    }
    dispatch({ type: 'unit/failed' });
  }, [haltForAuth]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    eventHandlerRef.current = (event: OutboxEvent) => {
      if (event.type === 'halt') {
        void haltForAuth();
        return;
      }
      if (event.type === 'trip') {
        dispatch({ type: 'trip', trip: event.trip });
        // A completed response is the unit of work the shift summary counts.
        if (event.trip.status === 'completed') {
          pushActivity({
            title: copy.responseCompleted,
            detail: event.trip.reference,
            tone: 'accent',
            kind: 'action',
            ref: event.trip.id,
          });
        }
        void loadQueue().then((items) => dispatch({ type: 'outbox', items }));
        return;
      }
      // Every other event means the queue changed, so mirror it before anything else.
      void loadQueue().then((items) => dispatch({ type: 'outbox', items }));
      if (event.type === 'notice') {
        const text = NOTICE_COPY[event.code];
        dispatch({ type: 'notice', notice: { text, tone: 'error' } });
        // The toast disappears; the activity log is what survives it.
        pushActivity({ title: text, detail: 'From dispatch', tone: 'warning' });
        return;
      }
      if (event.type === 'retry') {
        // The last request failed: Home shows the offline banner with the count.
        dispatch({ type: 'unit/failed' });
        pushActivity({
          title: copy.retryNotice,
          detail: 'Waiting for the next attempt',
          tone: 'warning',
        });
        return;
      }
      void refreshRef.current();
    };
  }, [haltForAuth, pushActivity]);

  // Boot: load the token and the queue, then drain immediately.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [token, outbox, pinStored, storedShift, storedCheck, storedActivity] =
        await Promise.all([
          readToken(),
          loadQueue(),
          hasPin(),
          readShift(),
          readCheck(),
          readActivity(),
        ]);
      if (cancelled) {
        return;
      }
      dispatch({ type: 'activity', entries: storedActivity });
      if (storedCheck !== null) {
        dispatch({ type: 'check', check: storedCheck });
      }
      if (token === null) {
        dispatch({ type: 'boot/anonymous', outbox, pairNotice: null });
        return;
      }
      tokenRef.current = token;
      // Restoring a signed-in unit also resumes its shift; a device that has the
      // token but no shift record starts one now, at open.app time.
      const shift: ShiftRecord =
        storedShift ?? { startedAt: new Date().toISOString(), breakStartedAt: null };
      if (storedShift === null) {
        await writeShift(shift);
        pushActivity({ title: copy.shiftStartedNotice, detail: 'Shift clock running', tone: 'accent' });
      }
      dispatch({ type: 'shift', shift });
      dispatch({ type: 'boot/token', token, outbox, locked: pinStored });
      const result = await api.fetchUnit(token);
      if (cancelled) {
        return;
      }
      if (result.kind === 'ok') {
        dispatch({ type: 'paired', token, unit: result.data, outbox });
      } else if (api.isUnauthorized(result)) {
        await haltForAuth();
        return;
      } else {
        dispatch({ type: 'unit/failed' });
      }
      void worker.drain(token);
    })();
    return () => {
      cancelled = true;
    };
  }, [haltForAuth, worker, pushActivity]);

  // One clock for the whole app: the shift timer, the per-response timer and the
  // Duty screen all read the same number.
  useEffect(() => {
    if (state.token === null) {
      return;
    }
    const timer = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, [state.token]);

  const route: Route = state.stack[state.stack.length - 1] ?? { name: 'home' };
  const onHomeOrTrip = route.name === 'home' || route.name === 'trip';

  // Poll /unit every 15 seconds while Home or Trip is on screen and the app is
  // in the foreground. There is no push channel on this server.
  useEffect(() => {
    if (state.token === null || !onHomeOrTrip) {
      return;
    }
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') {
        void refresh();
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [state.token, onHomeOrTrip, refresh]);

  useEffect(() => {
    if (state.token === null) {
      return;
    }
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refresh();
      }
    });
    return () => subscription.remove();
  }, [state.token, refresh]);

  useEffect(() => {
    if (state.notice === null) {
      return;
    }
    const timer = setTimeout(() => dispatch({ type: 'notice/clear' }), motion.toast);
    return () => clearTimeout(timer);
  }, [state.notice]);

  const pair = useCallback(
    async (code: string): Promise<PairResult> => {
      const candidate = code.trim();
      if (candidate.length === 0) {
        return { ok: false, message: 'Enter the unit code dispatch gave you.' };
      }
      const result = await api.fetchUnit(candidate);
      if (result.kind === 'ok') {
        try {
          await writeToken(candidate);
        } catch {
          return { ok: false, message: 'This device could not store the unit code.' };
        }
        tokenRef.current = candidate;
        worker.reset();
        const items = await loadQueue();
        dispatch({ type: 'paired', token: candidate, unit: result.data, outbox: items });
        // Signing in starts the shift; the clock is what the Duty screen shows.
        const shift: ShiftRecord = {
          startedAt: new Date().toISOString(),
          breakStartedAt: null,
        };
        await writeShift(shift);
        dispatch({ type: 'shift', shift });
        pushActivity({
          title: copy.shiftStartedNotice,
          detail: `${result.data.call_sign} · signed in on this device`,
          tone: 'accent',
        });
        void worker.drain(candidate);
        return { ok: true, message: null };
      }
      if (api.isUnauthorized(result)) {
        return { ok: false, message: copy.invalidUnitCode };
      }
      if (result.kind === 'network') {
        return { ok: false, message: copy.networkError };
      }
      return { ok: false, message: api.failureText(result) };
    },
    [worker, pushActivity]
  );

  const unpair = useCallback(async (): Promise<void> => {
    await clearToken();
    await clearPin();
    await clearShift();
    await clearActivity();
    tokenRef.current = null;
    shiftRef.current = null;
    activityRef.current = [];
    await worker.clear();
    dispatch({ type: 'unpaired' });
  }, [worker]);

  const unlock = useCallback(async (pin: string): Promise<boolean> => {
    if (!(await verifyPin(pin))) {
      return false;
    }
    dispatch({ type: 'unlocked' });
    return true;
  }, []);

  const setPin = useCallback(async (pin: string): Promise<void> => {
    await writePin(pin);
  }, []);

  const unlockWithBiometrics = useCallback((): void => {
    dispatch({ type: 'unlocked' });
  }, []);

  const toggleBreak = useCallback(async (): Promise<void> => {
    const current = shiftRef.current;
    if (current === null) {
      return;
    }
    const now = Date.now();
    // Resuming banks the break that just ended. Without this, the clock jumps
    // forward by the whole break the moment the driver comes back.
    const next: ShiftRecord =
      current.breakStartedAt === null
        ? { ...current, breakStartedAt: new Date(now).toISOString() }
        : {
            ...current,
            breakStartedAt: null,
            breakMs:
              (current.breakMs ?? 0) +
              Math.max(0, now - Date.parse(current.breakStartedAt)),
          };
    shiftRef.current = next;
    dispatch({ type: 'shift', shift: next });
    await writeShift(next);
    pushActivity({
      title: next.breakStartedAt === null ? copy.breakEndedNotice : copy.breakStartedNotice,
      detail: next.breakStartedAt === null ? 'Shift clock resumed' : 'Shift clock paused',
      tone: 'grey',
    });
  }, [pushActivity]);

  const endShift = useCallback(async (): Promise<void> => {
    if (shiftRef.current === null) {
      return;
    }
    shiftRef.current = null;
    await clearShift();
    dispatch({ type: 'shift', shift: null });
    pushActivity({ title: copy.shiftEndedNotice, detail: 'Unit is off shift', tone: 'grey' });
  }, [pushActivity]);

  const flushOutbox = useCallback(async (): Promise<void> => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    worker.reset();
    await worker.drain(token);
    const items = await loadQueue();
    dispatch({ type: 'outbox', items });
  }, [worker]);

  const recordCheck = useCallback(
    async (
      trip: Trip,
      count: number,
      kind: 'equipment' | 'handover',
      note?: string
    ): Promise<void> => {
      const record: CheckRecord = {
        at: new Date().toISOString(),
        tripId: trip.id,
        reference: trip.reference,
        count,
        kind,
      };
      dispatch({ type: 'check', check: record });
      await writeCheck(record);
      pushActivity({
        title: kind === 'equipment' ? copy.checkPassed : copy.handoverPassed,
        detail: [
          `${count} items · ${trip.reference}`,
          note === undefined || note.length === 0 ? null : note,
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
        tone: 'accent',
      });
    },
    [pushActivity]
  );

  const loadTrip = useCallback(
    async (tripId: number): Promise<Trip | null> => {
      const token = tokenRef.current;
      if (token === null) {
        return null;
      }
      const result = await api.fetchTrip(token, tripId);
      if (result.kind === 'ok') {
        dispatch({ type: 'trip', trip: result.data });
        return result.data;
      }
      if (api.isUnauthorized(result)) {
        await haltForAuth();
        return null;
      }
      if (result.kind === 'http' && (result.status === 403 || result.status === 404)) {
        const text = result.status === 403 ? copy.reassigned : copy.noLongerExists;
        dispatch({ type: 'notice', notice: { text, tone: 'error' } });
        dispatch({ type: 'pop' });
        return null;
      }
      dispatch({
        type: 'notice',
        notice: { text: api.failureText(result), tone: 'error' },
      });
      return null;
    },
    [haltForAuth]
  );

  const loadAssignments = useCallback(async (): Promise<void> => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    const result = await api.fetchAssignments(token);
    if (result.kind === 'ok') {
      dispatch({ type: 'assignments', assignments: result.data.assignments });
      return;
    }
    if (api.isUnauthorized(result)) {
      await haltForAuth();
      return;
    }
    dispatch({ type: 'unit/failed' });
    dispatch({
      type: 'notice',
      notice: { text: api.failureText(result), tone: 'error' },
    });
  }, [haltForAuth]);

  const act = useCallback(
    async (trip: Trip): Promise<void> => {
      const action = primaryAction(trip);
      const token = tokenRef.current;
      if (action === null || token === null) {
        return;
      }
      const outcome = await worker.enqueue({
        tripId: trip.id,
        to: ACTION_TARGETS[action],
        expectedStatus: trip.status,
        clientEventId: makeId(),
        clientAt: new Date().toISOString(),
      });
      if (outcome === 'full') {
        dispatch({
          type: 'notice',
          notice: {
            text: copy.queueFull,
            tone: 'error',
          },
        });
        return;
      }
      if (outcome === 'duplicate') {
        return;
      }
      const items = await loadQueue();
      dispatch({ type: 'outbox', items });
      void worker.drain(token);
    },
    [worker]
  );

  const reportIssue = useCallback(
    async (trip: Trip, category: IssueCategory, note: string): Promise<string | null> => {
      const token = tokenRef.current;
      if (token === null) {
        return copy.unitCodeExpired;
      }
      const trimmed = note.trim().slice(0, NOTE_LIMIT);
      const result = await api.postIssue(
        token,
        trip.id,
        category,
        trimmed.length > 0 ? trimmed : null
      );
      if (result.kind === 'ok') {
        dispatch({ type: 'trip', trip: result.data.trip });
        return null;
      }
      if (api.isUnauthorized(result)) {
        await haltForAuth();
        return 'This unit code is no longer valid.';
      }
      return api.failureText(result);
    },
    [haltForAuth]
  );

  const requestBackup = useCallback(
    async (trip: Trip, note: string): Promise<string | null> => {
      const token = tokenRef.current;
      if (token === null) {
        return copy.unitCodeExpired;
      }
      const trimmed = note.trim().slice(0, NOTE_LIMIT);
      const result = await api.postBackup(token, trip.id, trimmed.length > 0 ? trimmed : null);
      if (result.kind === 'ok') {
        dispatch({ type: 'trip', trip: result.data.trip });
        return null;
      }
      if (api.isUnauthorized(result)) {
        await haltForAuth();
        return copy.unitCodeExpired;
      }
      return api.failureText(result);
    },
    [haltForAuth]
  );

  const pendingTripIds = useMemo(
    () => Array.from(new Set(state.outbox.map((item) => item.tripId))),
    [state.outbox]
  );

  const unconfirmedCount = useMemo(
    () => state.outbox.filter((item) => item.attempts > 0).length,
    [state.outbox]
  );

  const shift = state.shift;
  const onBreak = shift !== null && shift.breakStartedAt !== null;
  const elapsedMs =
    shift === null
      ? 0
      : Math.max(
          0,
          state.nowMs -
            Date.parse(shift.startedAt) -
            (shift.breakMs ?? 0) -
            (shift.breakStartedAt === null ? 0 : state.nowMs - Date.parse(shift.breakStartedAt))
        );
  const availability: Availability =
    shift === null ? 'off' : onBreak ? 'break' : 'available';

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      route,
      elapsedMs,
      onBreak,
      availability,
      toggleBreak,
      endShift,
      flushOutbox,
      flushTelemetry: () => tracker.flush(),
      recordCheck,
      pendingCount: state.outbox.length,
      unconfirmedCount,
      pendingTripIds,
      isPending: (tripId: number) => pendingTripIds.includes(tripId),
      pair,
      unpair,
      refresh,
      loadTrip,
      loadAssignments,
      act,
      reportIssue,
      requestBackup,
      push: (next: Route) => dispatch({ type: 'push', route: next }),
      pop: () => dispatch({ type: 'pop' }),
      switchTab: (next: Route) => dispatch({ type: 'tab', route: next }),
      unlock,
      setPin,
      unlockWithBiometrics,
      showNotice: (text: string, tone: Notice['tone'] = 'info') =>
        dispatch({ type: 'notice', notice: { text, tone } }),
      clearNotice: () => dispatch({ type: 'notice/clear' }),
    }),
    [
      state,
      route,
      unconfirmedCount,
      pendingTripIds,
      pair,
      unpair,
      refresh,
      loadTrip,
      loadAssignments,
      act,
      reportIssue,
      requestBackup,
      unlock,
      setPin,
      unlockWithBiometrics,
      elapsedMs,
      onBreak,
      availability,
      toggleBreak,
      endShift,
      flushOutbox,
      recordCheck,
      tracker,
    ]
  );

  // This module is `.ts` by contract, so the provider element is built without JSX.
  return React.createElement(StoreContext.Provider, { value }, children);
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (value === null) {
    throw new Error('useStore must be used inside StoreProvider.');
  }
  return value;
}
