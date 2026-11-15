# GREEN ROUTE — crew app

The phone in the vehicle. It shows the crew their current response, moves it through
the lifecycle, reports problems and backup requests, and shares GPS while the vehicle is
en route.

Built with Expo SDK 58 and React Native 0.88 in TypeScript. It talks only to the
GREEN ROUTE driver API; there is no direct database access and no stored credential
beyond the unit token in the OS keychain.

---

## What it does

- **Pairing.** The crew types a unit token (`token-medic12` for call sign `MEDIC-12`).
  It is stored in `expo-secure-store` and every request carries it as a bearer token.
- **Assignment.** The unit's open response: reference, priority, endpoints, distance and
  duration, instructions, the stored road geometry, the timeline, and the action buttons
  the server says are legal right now.
- **Transitions.** Accept, depart, arrive, complete — written to a durable outbox before
  the first byte is sent, retried with backoff, and reconciled when the server reports a
  conflict. The app never predicts a status; it displays what the server returned.
- **Issues and backup.** Report a blocked route, unsafe scene, breakdown and similar, or
  ask for backup. Neither changes the status.
- **Location.** While the response is `in_transit`, a fix every 10 seconds or 25 metres,
  buffered when dispatch is unreachable and sent in bounded batches.
- **Driver-visible location state.** A badge on Home reads *Location shared*,
  *Starting GPS…*, *Location paused*, *Location buffered*, *Location blocked*,
  *Location stopped* or *Location off*, with the reason and the current accuracy.

## Location behaviour and its limits

| Property | Value |
|---|---|
| Permission | Foreground ("while using the app") only; no background permission is requested |
| Cadence | 10 s or 25 m of movement |
| Stationary behaviour | No fix while the vehicle has moved less than 8 m, except a check-in every ~30 s |
| Accuracy floor | Readings worse than 100 m are ignored on the device |
| Buffer | At most 12 fixes, nothing older than 2 minutes |
| Retry | 1, 2, 4, 8, 16, 30 s with ±20 % jitter, then the next fix tries again |

Tracking stops when the app is backgrounded or force-quit, and iOS/Android will not
restart a killed app for location. The operations map shows the unit as STALE or LOST in
that case; the response itself is unaffected. This is deliberate, and the badge says so
rather than implying otherwise.

## Structure

```text
App.tsx                 Navigation shell
src/api.ts              The only module that performs HTTP
src/store.ts            Application state, outbox worker, location tracker wiring
src/location.ts         Pure location rules and the tracker (dependency-injected)
src/locationProvider.ts The only module that imports expo-location
src/telemetryStorage.ts Durable, bounded position buffer
src/outbox.ts           Queue decisions and one serial worker
src/screens/            Home, trip, queue, history, duty, profile, checklist, login
src/components/         Badge, sheet, map stage, timeline, buttons
__mocks__/              Mock driver API and a contract check against the real client
__tests__/              Jest suite
```

The rule the code follows: rules live in plain modules (`outbox.ts`, `location.ts`) that
take storage, transport and a clock by injection; React components and native modules
sit at the edges. That is why most of the behaviour is testable in Node.

## Setup

```bash
npm install
cp .env.example .env
```

`EXPO_PUBLIC_API_BASE` must point at the driver API, with no trailing slash. The value
is inlined at bundle time, so restart `expo start` after changing it.

```bash
# Android emulator (forward the backend port, then use loopback)
adb reverse tcp:5000 tcp:5000
# .env
EXPO_PUBLIC_API_BASE=http://127.0.0.1:5000

# Physical phone on the same Wi-Fi: the backend must listen beyond loopback
# .env
EXPO_PUBLIC_API_BASE=http://192.168.1.23:5000
```

Run it:

```bash
npx expo start        # press "a" for Android, "i" for iOS Simulator
```

`expo-location` is a native module. Expo Go can load it; a custom development build must
be rebuilt after `npm install` (`npx expo run:android`).

## Working without the backend

```bash
npm run mock        # mock driver API on 127.0.0.1:5055
npm run mock:lan    # bound to the LAN for a physical phone
npm run verify:mock # drives the client modules against the mock
```

## Tests

```bash
npx tsc --noEmit
npx jest
npm run verify      # typecheck + tests + mock contract check
```

97 tests in six suites: queue decisions and backoff, location acceptance and buffering,
presentation helpers, component rendering and screen rendering. Everything runs in Node;
no device is used and none is required.

## Driver API used

| Method | Path |
|---|---|
| GET | `/api/driver/unit` |
| GET | `/api/driver/assignments` |
| GET | `/api/driver/trips/<id>` |
| POST | `/api/driver/trips/<id>/transition` |
| POST | `/api/driver/trips/<id>/issue` |
| POST | `/api/driver/trips/<id>/backup` |
| POST | `/api/driver/telemetry` |
| GET | `/api/driver/telemetry` |

Shapes and error codes: `../docs/api-reference.md`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Dispatch address is not configured" | `EXPO_PUBLIC_API_BASE` is empty; edit `.env` and restart `expo start`. |
| "Invalid unit code" | The token does not match a call sign on the server. |
| Everything works except location | Permission denied, or the response is not `in_transit`. The badge names which. |
| Stuck on "Sending…" | Dispatch is unreachable; the outbox keeps the action and retries with backoff. |
| App cannot reach the backend on a phone | The server is bound to `127.0.0.1`; see setup above. |
