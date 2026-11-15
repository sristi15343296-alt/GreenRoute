# Testing

Everything here runs against temporary SQLite databases and simulated coordinates. No
test touches `instance/greenroute.sqlite`, and no test contacts a real emergency
vehicle.

---

## 1. Commands

### Backend

```bash
cd backend
# Windows (virtual environment in the repository)
.venv/Scripts/python.exe -m unittest discover -s tests
# macOS / Linux
python -m unittest discover -s tests
```

Result on 2026-11-15: **163 tests, OK** (about 80 seconds).

Single module or single test:

```bash
python -m unittest discover -s tests -p "test_telemetry.py"
python -m unittest tests.test_telemetry.TelemetryTestCase.test_older_fix_cannot_replace_a_newer_position -v
```

`tests/support.py` holds the shared helpers: `signed_in_client(app, role=...)` creates
an administrator, performs the real sign-in flow and attaches the CSRF header, so
tests exercise the actual guard stack rather than bypassing it.

### Driver application

```bash
cd driver-app
npx tsc --noEmit      # types, no emit
npx jest              # 97 tests in 6 suites
npm run verify        # typecheck + tests + mock-backend contract check
```

Result on 2026-11-15: `tsc` exit 0, **97 tests passed**.

### Frontend syntax

The admin pages have no build step, so a syntax check is the cheapest guard:

```bash
for file in static/js/*.js; do node --check "$file"; done
```

### Mock backend contract

```bash
cd driver-app
npm run mock          # serves the driver API on 127.0.0.1:5055
npm run verify:mock   # drives the real client code against it
```

This is how the phone app is verified without Flask or a device: the mock implements
the same endpoints, and `verify:mock` exercises pairing, refresh, transitions and
telemetry upload through the app's own modules.

---

## 2. What the tests cover

| Area | File | Examples |
|---|---|---|
| Routing | `tests/test_routing.py` | Provider normalisation, cache hit, failure surfaces as an error |
| Geocoding | `tests/test_geocoding.py` | Nominatim/Photon parsing, rate limiting, cache persistence |
| Driver API | `tests/test_driver_api.py` | Ownership, idempotent replay, stale state, projection shape |
| Trip status | `tests/test_trip_status.py` | Status vocabulary and transitions in the admin |
| Authentication | `tests/test_auth.py` | Sign-in, hashing, session expiry, revocation, CSRF, throttling, cookie flags |
| RBAC | `tests/test_rbac.py` | Every endpoint against every role; unregistered endpoints fail |
| Lifecycle | `tests/test_lifecycle.py` | Legal edges, actor rules, atomicity, audit, telemetry health vs. cancellation |
| Telemetry | `tests/test_telemetry.py` | Validation, ownership, duplicates, ordering, jumps, health bands, deviation, recalculation, live API, retention |
| Phone logic | `__tests__/*.test.ts(x)` | Outbox decisions, location tracker, presentation, component and screen rendering |

The phone tests never render a native module: `jest-expo` provides the environment,
and the tracker takes its watcher, transport, storage and clock by injection.

---

## 3. What is not tested

- **No physical-device testing.** GPS accuracy, battery use, permission dialogs,
  background behaviour and the on-screen badge have not been exercised on a real
  Android or iOS device.
- **No automated browser test suite.** The admin live overlay was checked by hand in
  headless Chromium (overlay present, one tracked unit, polling returns 200, stale
  state rendered, no JavaScript errors). There is no Playwright/Cypress suite in the
  repository.
- **No load or concurrency testing.** The concurrency guarantees are asserted at the
  SQL level (a late older fix updates no row) rather than with parallel clients.
- **No security scanning in CI.** No SAST, dependency audit or secret scanner is
  wired up.
- **No OSRM coverage beyond the adapter.** The public provider is not contacted by
  tests; routing is stubbed where the behaviour under test is not the provider.

---

## 4. A manual end-to-end pass

1. Start the backend and sign in.
2. Create a response, assign a unit, mark it en route.
3. From the phone (or the `curl` snippet in `docs/setup-guide.md`), post a telemetry
   fix for that unit.
4. Open `/fleet-map`: the unit appears with a LIVE badge and its call sign.
5. Stop posting fixes; after two minutes the marker greys and the warning strip names
   the unit as lost. The response stays `in_transit`.
6. Post a position far off the stored route; within 90 seconds the route is
   recalculated and a new `emergency_routes` row exists with the previous one
   superseded.
7. Complete the response; the unit disappears from the live list.

---

## 5. Reproducing the numbers in the documentation

The performance estimates in `docs/phase-c.md` are arithmetic from stated
assumptions (fixes per minute, payload size, row size), not measurements. Re-read
that section before quoting them as capacity.
