# GREEN ROUTE — Phase C implementation report

Live GPS tracking and emergency vehicle telemetry.

Status: **implemented and verified in this workspace on 2026-11-15**, except where
explicitly marked untested. Companion documents:
`docs/architecture.md` (system design, Phase C section),
`docs/phase-b.md` (the security and lifecycle layer this builds on).

Everything below was verified with simulated coordinates on a development machine.
**No physical device, no real vehicle and no production deployment was used.**

---

## 1. Audit — what actually existed before this phase

Read, not assumed:

| Question | Finding |
|---|---|
| Does the phone collect location? | **No.** `package.json` had no `expo-location`, `expo-task-manager` or any GPS module; `app.json` requested no location permission. |
| How does the phone authenticate as a unit? | A bearer token of the form `token-<slug(call_sign)>` (`blueprints/driver_api.py::_token_unit`), resolved against the vehicle registry on every request. |
| How does it obtain its active assignment? | `GET /api/driver/unit` → `assignment` (an allow-listed trip projection), polled every 15 s while Home/Trip is on screen. |
| Where is routing? | `routing.py` (`resolve_route` via OSRM, `route_cache` in SQLite). Adapter-shaped, returns `provider`/`geometry`/`distance_m`/`duration_s`. |
| What did the map show? | `static/js/map.js` + `templates/fleet_map.html` (Leaflet + MapLibre, recorded endpoints and previews) and `static/js/trip_detail.js` for one response. No live layer. |
| Was there a location table? | No. `emergency_sessions` had `last_seen_at` and `activated_at`, written only at lifecycle changes. |
| What did the 120 s watchdog do? | `lifecycle.expire_stale()` **cancelled** every ACTIVE session whose `last_seen_at` was older than `EXPIRY_IDLE_SECONDS` (120 s), with reason "No telemetry received from the unit." |
| Tests | 121 backend tests, 78 Jest tests, `tsc` clean at the end of Phase B. |

Two defects were found and are the only lifecycle behaviour changed in Phase C
(both required by the brief):

1. **The watchdog ended genuine emergencies.** Once a telemetry writer existed, a
   phone in a tunnel (or with a flat battery) would have cancelled a live response
   after two minutes of silence. Fixed in C.11 below.
2. **Deviation had no state.** `trips` had no column recording whether the stored
   route was still trusted, so a failed recalculation would have had nowhere to say
   "this is degraded" without inventing a status.

---

## 2. What was built

| Deliverable | Files | State |
|---|---|---|
| GPS acquisition (phone) | `driver-app/src/location.ts`, `src/locationProvider.ts`, `src/telemetryStorage.ts`, `src/components/TelemetryBadge.tsx`, `src/screens/HomeScreen.tsx`, `app.json`, `package.json` | implemented, unit-tested; **not** run on a device |
| Ingestion API | `blueprints/driver_api.py` (`POST/GET /api/driver/telemetry`) | implemented, tested |
| Schema and migration | `db.py` (`telemetry_fixes`, `vehicle_positions`, three `trips` columns, `source` column), `tools/_phasec_db_patch.py` | implemented, applied to the real dev DB |
| Latest-position processing | `telemetry.py::ingest`, `db.upsert_latest_position` | implemented, tested |
| Quality and stale handling | `telemetry.py` (`parse_fix`, `health`, `quality_label`) | implemented, tested |
| Offline recovery | `location.ts` (bounded buffer, backoff, persisted sequence) | implemented, unit-tested |
| Route deviation and recalculation | `telemetry.py` (`distance_to_route_m`, `should_recalculate`, `recalculate_route`) | implemented, tested, exercised against live OSRM |
| Admin live monitoring | `static/js/emergency-live.js`, `templates/fleet_map.html`, `static/js/map.js` (map handle) | implemented, browser-verified |
| Watchdog correction | `lifecycle.py` (`telemetry_warnings`, `expire_overtime`, `expire_stale` alias), `app.py` sweep route | implemented, tested |
| Docs | this file + Phase C section in `docs/architecture.md` + rebuilt PDF | done |

---

## 3. C.1 — GPS acquisition on the phone

**API.** `expo-location` (`~58.0.22`, installed with `npx expo install`), foreground
only. `src/locationProvider.ts` is the only module that imports it.

- `requestLocationPermission()` asks once, reuses an existing grant, and returns
  `false` (rather than throwing) when the driver has permanently denied it.
- `watchLocation()` uses `Accuracy.High`, `timeInterval: 10_000` (10 s) and
  `distanceInterval: 25` (25 m). Both values are exported from `location.ts` so the
  server's 15 s "LIVE" band and the phone's cadence agree by construction.
- The app never asks for background location, and `app.json` sets
  `isAndroidBackgroundLocationEnabled: false`.

**No polling while stationary.** `acceptSample()` drops a reading when the vehicle
has moved less than `MIN_STEP_M` (8 m) *and* the previous accepted sample is younger
than 3 intervals (30 s). A parked vehicle with the app open still checks in every
~30 s, so it does not look lost to the admin, but 25 m of jitter does not produce a
fix.

**Accuracy.** Readings worse than `ACCURACY_CEILING_M` (100 m) are ignored on the
phone; the server independently accepts up to 1000 m and labels anything over
100 m `poor`.

**Driver-visible state.** `src/components/TelemetryBadge.tsx` renders one of:
`Location shared`, `Starting GPS…`, `Location paused`, `Location buffered`,
`Location blocked`, `Location stopped`, `Location off`, with the reason as a
sentence, the accuracy in metres when live, and the buffered count when offline. It
appears in the Home sheet banner (with a response) and above the standby content
(without one). It is an `accessibilityLiveRegion="polite"` text node with a full
`accessibilityLabel`.

**Platform limits — stated, not worked around.**

- **Foreground only.** `AppState` background → `tracker.pause()`; foreground →
  `tracker.resume()`. A driver who switches apps stops reporting until they return.
- **No tracking after force-quit.** Neither Android nor iOS restarts a killed app
  for location. The admin sees STALE/LOST; the emergency is not touched.
- **Android** throttles background and Doze-mode location; "while using the app" is
  the only permission requested.
- **iOS** shows the location indicator while in use; "Allow Once" ends sharing when
  the app closes.
- Battery: 10 s / 25 m with `Accuracy.High` is roughly a 4–6 %/hour drain on a
  mid-range Android phone in our experience, but **this was not measured** — see
  §13.

---

## 4. C.2 — Location API

### `POST /api/driver/telemetry`

Auth: `Authorization: Bearer token-<call-sign-slug>`. The body **never** carries a
vehicle or session id; identity comes from the token and the session from the trip
the unit owns.

```json
{
  "trip_id": 16,
  "fixes": [
    {
      "lat": 19.1170, "lng": 72.8680,
      "accuracy_m": 7.5, "heading_deg": 205, "speed_mps": 11.2,
      "device_time": "2026-11-15T09:13:34Z",
      "client_fix_id": "MEDIC-12:1",
      "sequence": 1,
      "source": "gps"
    }
  ]
}
```

`trip_id` is optional: without it the server uses the unit's own open response,
which is what the app sends. `source` defaults to `gps`; the allow-list is
`gps|network|manual|simulated`, so an import or replay can never look like a live
reading.

**Response 200** (at least one fix accepted or already stored):

```json
{"telemetry": {
  "trip_id": 16, "session_state": "ACTIVE",
  "accepted": 1, "duplicates": 0, "rejected": 0,
  "outcomes": [{"index": 0, "accepted": true, "duplicate": false, "fix_id": 1, "applied": true}],
  "latest": {"lat": 19.117, "lng": 72.868, "accuracy_m": 7.5, "heading_deg": 205,
             "speed_mps": 11.2, "device_time": "2026-11-15 09:13:34",
             "received_at": "2026-11-15 09:13:34", "quality": "good"},
  "health": {"status": "LIVE", "age_seconds": 0, "accuracy_m": 7.5,
             "quality": "good", "message": "Reporting normally.", "tracks": true},
  "recalculation": {"recalculated": true, "provider": "osrm", "distance_m": 3675.3},
  "route": {"provider": "osrm", "quality": "ok", "deviation_m": 196.7,
            "recalculated_at": "2026-11-15 09:13:35"}
}}
```

**Error structure.** `{"error": "<human sentence>", "error_code": "<stable code>"}`.
A batch where nothing was stored or already known is an error status so the phone
has one decision to make; per-fix detail is still returned under `telemetry`.

| Status | `error_code` | Meaning |
|---|---|---|
| 400 | `invalid_payload` | Not JSON, or no non-empty `fixes` array |
| 401 | `authentication_required` | Missing/unknown bearer token |
| 404 | `not_your_response` | `trip_id` belongs to another unit |
| 409 | `no_active_response` | This unit has no open response |
| 409 | `session_not_trackable` | The session is not ACTIVE (completed/cancelled/expired/on-scene) |
| 413 | `batch_too_large` | More than 60 fixes |
| 422 | `invalid_coordinates` | Outside the world, or the null point (0,0) |
| 422 | `accuracy_out_of_range` | `accuracy_m` < 0 or > 1000 |
| 422 | `future_timestamp` | More than 120 s ahead of the server |
| 422 | `stale_timestamp` | More than 300 s old |
| 422 | `invalid_field` / `missing_field` | Bad heading/speed/sequence/time/type |
| 422 | `out_of_order` | Older than the stored position (timestamp, then sequence) |
| 422 | `impossible_jump` | > 2 km in < 10 s, or implied speed > 200 km/h |

**Idempotency.** A repeated `client_fix_id` is answered
`{"duplicate": true}` with the original `fix_id`, before any ordering check. The
unique index makes this true even for two concurrent requests.

### `GET /api/driver/telemetry`

Returns `{tracking, reason, trip_id, session_state, health, retention_days}` for the
unit's open response — what the badge could show if it wanted a server opinion.
`health.status` is one of LIVE / DELAYED / STALE / LOST / UNKNOWN.

---

## 5. C.3 — Data model and migration

Two tables, on purpose: an append-only trail for history and one row per response
for the answer the dashboard asks for most often.

```sql
CREATE TABLE telemetry_fixes (            -- append-only audit trail
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- also the polling event id
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES emergency_sessions(id) ON DELETE SET NULL,
  vehicle_id INTEGER,
  client_fix_id TEXT UNIQUE,              -- idempotency key from the phone
  sequence INTEGER,                       -- device monotonic counter
  lat REAL NOT NULL, lng REAL NOT NULL,
  accuracy_m REAL, heading_deg REAL, speed_mps REAL,
  device_time TEXT NOT NULL,              -- when the phone measured it
  received_at TEXT NOT NULL,              -- when the server stored it
  quality TEXT NOT NULL DEFAULT 'good',
  source TEXT NOT NULL DEFAULT 'gps'
);

CREATE TABLE vehicle_positions (          -- latest trusted position, one row/trip
  trip_id INTEGER PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES emergency_sessions(id) ON DELETE SET NULL,
  vehicle_id INTEGER,
  last_fix_id INTEGER REFERENCES telemetry_fixes(id) ON DELETE SET NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  accuracy_m REAL, heading_deg REAL, speed_mps REAL,
  device_time TEXT NOT NULL, received_at TEXT NOT NULL,
  sequence INTEGER, client_fix_id TEXT,
  quality TEXT NOT NULL DEFAULT 'good', source TEXT NOT NULL DEFAULT 'gps',
  updated_at TEXT NOT NULL
);

ALTER TABLE trips ADD COLUMN route_quality TEXT;          -- 'ok' | 'degraded'
ALTER TABLE trips ADD COLUMN route_deviation_m REAL;
ALTER TABLE trips ADD COLUMN route_recalculated_at TEXT;
```

Indexes: `(trip_id, id)` and `(received_at)` on `telemetry_fixes`,
`(updated_at)` on `vehicle_positions`.

**Why two tables.** The dashboard needs "where is it now" for every active response
on every poll, and that must not scan a growing trail. The trail is needed for the
operator's breadcrumb and for `since=` change detection. A single table would make
one of the two queries expensive.

**Ordering is enforced in SQL**, not only in Python:

```sql
ON CONFLICT (trip_id) DO UPDATE SET ... 
WHERE excluded.device_time > vehicle_positions.device_time
   OR (excluded.device_time = vehicle_positions.device_time
       AND COALESCE(excluded.sequence, -1) > COALESCE(vehicle_positions.sequence, -1))
```

A slow request that arrives after a fast one updates no row (`rowcount == 0`), so an
older fix cannot overwrite a newer position even under concurrent uploads. An
`IntegrityError` on a duplicate `client_fix_id` is treated as "already stored".

**Migration.** `db.init_db()` creates the tables and adds missing columns behind
`PRAGMA table_info` checks, so it is repeatable and runs on every boot. It was
applied to the development database after a file copy to
`instance/backup-before-phase-c-<timestamp>.sqlite`:

```
before: trips 16, trip_events 58, emergency_sessions 16, emergency_routes 1,
        telemetry_fixes 0, vehicle_positions 0
after:  identical counts; trips gained route_quality, route_deviation_m,
        route_recalculated_at; telemetry_fixes gained source
```

**Retention.** `telemetry.prune_telemetry(cutoff)` deletes fixes older than
`GREENROUTE_TELEMETRY_RETENTION_DAYS` (default 14) and runs after every accepted
batch. `vehicle_positions` is one row per response and is removed by the existing
trip cascade.

---

## 6. C.4 — Validation and quality

- Coordinates: range and null-point rejection, server-side, always.
- Accuracy: > 1000 m rejected; 100–1000 m stored as `poor`; ≤ 100 m `good`.
- Clock: `device_time` is the phone's claim, `received_at` the server's. All
  freshness is computed from `received_at`, so a wrong phone clock cannot fake
  freshness.
- Future-dated > 120 s and older than 300 s are both rejected, the latter with a
  code that tells the phone to drop rather than retry.
- Impossible jumps: > 2 km within 10 s, or an implied speed above 200 km/h.
  Deliberately conservative — it catches artefacts and crude spoofing, not a fast
  vehicle. A tunnel exit is discarded; the next fix re-establishes position.
- Out-of-order: rejected with `out_of_order`; the stored position is unchanged.
- A rejected fix never replaces a valid one — that is the `WHERE` clause above.
- `quality` is exposed on every response, on the driver status, on the admin
  payload and in the popup ("±8 m").

**Health bands** (server clock, from `received_at`):

| Status | Age | Operator meaning |
|---|---|---|
| `LIVE` | ≤ 15 s | Reporting normally |
| `DELAYED` | ≤ 45 s | Last report a little old |
| `STALE` | ≤ 120 s | Treat this position as historical |
| `LOST` | > 120 s | Signal lost; the marker stays but says it is not current |
| `UNKNOWN` | never reported | No position for this response |

An old coordinate is never presented as current: the marker is greyed, the popup
carries a warning sentence, and the overlay strip names the unit.

---

## 7. C.5 — Network interruption and recovery

`src/location.ts` keeps a buffer with two limits and one ordering rule:

- At most `BUFFER_LIMIT` (12) fixes.
- Anything older than `BUFFER_TTL_MS` (120 s) is dropped rather than uploaded: a
  two-minute-old position does not describe where the vehicle is. The **newest** fix
  is always kept, because it is the only one an operator can still act on.
- The buffer is written to AsyncStorage **before** the first byte leaves the device
  (`src/telemetryStorage.ts`, key `greenroute.driver.telemetry.v1`), so an app kill
  mid-upload cannot lose it.
- Retries use `backoffDelay()` from the outbox — 1/2/4/8/16/30 s with ±20 % jitter —
  and give up after 4 attempts in one pass; the next fix tries again. The badge
  reads `Location buffered` with the count.
- On `401` the tracker stops, removes the watcher and says "Sign-in expired. Location
  sharing stopped — pair this unit again." It does not keep retrying a dead token.
- Duplicate uploads are safe in both directions: the server deduplicates on
  `client_fix_id`, and the id is derived from a **persisted** monotonic sequence
  (`CALLSIGN:sequence`), so a fix retried after an app restart has the same identity.
- Out-of-order flushes are harmless: the server keeps the newest position.

**Which buffered events are worth sending.** Anything inside 120 s and no newer than
the last accepted fix. Anything older is discarded by the phone and, if it arrives
anyway, by the server (`stale_timestamp`). Historical breadcrumb data is deliberately
not backfilled: the admin's trail shows where the vehicle *was reported*, and a
gap is the honest record of the gap.

---

## 8. C.6 — Server-side processing

`telemetry.ingest(unit, payload)` is the only writer, and its order is fixed:

1. Resolve the unit from the token (caller) and the trip from the body or the unit's
   open response, scoped by `get_trip_for_unit`.
2. Check the session state in `emergency_sessions` and require `lifecycle.can_track`
   (ACTIVE only) — so telemetry for COMPLETED, CANCELLED, EXPIRED or ON_SCENE is
   refused, not silently stored.
3. Validate each fix; compare against the stored latest position for ordering and
   plausibility.
4. Insert into `telemetry_fixes` (`ON CONFLICT (client_fix_id) DO NOTHING`).
5. Upsert `vehicle_positions` under the SQL ordering guard.
6. Touch `emergency_sessions.last_seen_at` **once per accepted batch** — the only
   writer of that column besides activation.
7. Prune expired fixes.
8. Evaluate deviation and possibly recalculate the route.
9. Return per-fix outcomes plus the resulting health and route state.

Concurrency: step 5 is a single conditional statement, so two uploads cannot make an
older position win. The session state remains server-authoritative throughout — the
phone cannot promote a session by reporting.

**Change notification.** Polling first (C.9). The event id is the
`telemetry_fixes.id`, monotonic and assigned by the same insert that stored the
position, so `GET /api/live/positions?since=<id>` is the whole contract.

---

## 9. C.7 — Route deviation and recalculation

- Distance from the latest trusted position to the active polyline, in metres, using
  a local equirectangular projection per segment (`point_to_segment_m`); at city
  scale it is well inside GPS accuracy and needs no geometry dependency.
- Threshold `GREENROUTE_DEVIATION_M`, default **150 m**.
- A position labelled `poor` (> 100 m accuracy) can never trigger a recalculation: a
  500 m accuracy circle cannot establish a 150 m deviation.
- Cooldown `GREENROUTE_RECALC_COOLDOWN_S`, default **90 s**, measured from
  `trips.route_recalculated_at`. A second off-route fix inside the cooldown returns
  `{"recalculated": false, "reason": "cooldown"}` and makes no provider call.
- On success: `db.save_route(..., reason="deviation")` inserts a **new**
  `emergency_routes` row, marks the previous active row `superseded_by = new_id`
  (so history answers "what was the path at 14:32"), sets `route_quality = 'ok'`,
  records `route_deviation_m` and writes a trip event.
- On failure (`routing.RoutingError`): no new route, `route_quality = 'degraded'`,
  the previous route stays active, and a trip event says the recalculation failed.
  A straight-line fallback is never stored as a route; the map draws a direct line
  only for a trip that has no route at all, and it is labelled as such.
- No traffic claim anywhere: OSRM here is a static road-graph router.

Verified live against the development server on TRP-1016: a 196.7 m deviation
produced one OSRM recalculation (3675.3 m route) and one new `emergency_routes` row.

---

## 10. C.8 — Admin live monitoring

`static/js/emergency-live.js` + a compact overlay in `templates/fleet_map.html`:

- Polls `GET /api/live/positions` every 5 s (`data-poll` to change), with the cursor
  from the previous answer; every sixth tick (30 s) does a full poll so a newly
  activated response that has not reported yet still appears.
- One marker per ACTIVE response, coloured by health (green / amber / orange / red /
  grey), rotated by heading, labelled with the call sign. A stale marker stays on the
  map, greyed, because "last known position" is operationally useful — deleting it
  would hide the vehicle.
- Popup: reference, unit, health + age, speed (km/h), compass direction, accuracy,
  off-route metres, route quality and provider, plus a "Show trail" button that draws
  `GET /api/live/sessions/<id>/track` (trail polyline + active route geometry).
- Overlay strip: tracked count, poll cadence, and a warning line naming STALE/LOST/
  UNKNOWN units with the sentence "Their positions are not current; the responses
  themselves are unchanged."
- Stops polling while the tab is hidden and catches up immediately on return.
- Network failure shows "reconnecting…" and keeps the last markers.
- RBAC: `/api/live/positions` and `/api/live/sessions/<id>/track` both require
  `trips.view` (VIEWER and above) through `app.ENDPOINT_PERMISSIONS`. Ordinary
  drivers have no administrative session and never see another unit's location;
  a driver's own location is only ever shown to itself via `/api/driver/telemetry`.
- No page reload: the overlay mutates Leaflet layers in place.

Browser-verified (headless Chromium, signed in as a temporary VIEWER against the real
dev database): overlay present, `1 tracked`, one marker labelled MEDIC-12, polling
`/api/live/positions?since=1` returning 200, no JavaScript errors. With the position
backdated 7 minutes the marker became `is-stale`, the strip read
`Telemetry warning: MEDIC-12 (lost). …`, and the session stayed ACTIVE. The two
console warnings present are MapLibre sprite warnings from the base style, not from
Phase C code.

---

## 11. C.9 — Real-time transport decision

| Option | Verdict for this stage |
|---|---|
| **Polling** | **Chosen.** One GET, no new dependency, works through any proxy, trivially debuggable, and `since=` makes it cheap. A 5 s cadence is well inside the 15 s LIVE band. |
| SSE | Better than polling for one-way push, but Flask's dev server holds a worker per stream, and nothing in this deployment terminates long-lived connections reliably. Revisit when there is a WSGI server with a thread budget for it. |
| WebSockets / Socket.IO | Justified only with bidirectional needs (operator chat, acknowledgements) or far more than ~100 concurrent vehicles. Socket.IO also needs sticky sessions and a message queue to scale past one process — infrastructure this project does not have. |
| MQTT | Right for a fleet telemetry backbone with devices on unreliable links and a broker already operated. Adding a broker now is infrastructure without a requirement. |

**Upgrade path without a rewrite.** Ingestion, storage and the event id do not
depend on the transport. A future SSE or Socket.IO publisher emits
`{event_id, positions[]}` — the exact payload `/api/live/positions` returns — and
`emergency-live.js` swaps its `poll()` for a subscription while `upsert()` and
`refreshSummary()` stay unchanged. Ordering is the fix id, so a push that arrives out
of order is discarded by the same rule the cursor uses. Duplicate delivery is
harmless because the client keys markers by `trip_id`.

---

## 12. C.10 — Privacy and security

- **Transport.** Cookies are `Secure` when the app is not in debug; deployment must
  terminate TLS in front of Flask. Nothing here weakens that.
- **Authorisation.** Ingestion is bearer-token scoped to one unit and one ACTIVE
  session. Live reads need `trips.view`. Tracking is refused for ON_SCENE, COMPLETED,
  CANCELLED and EXPIRED sessions, so a completed response stops producing location
  the moment it is closed.
- **Identity.** No endpoint accepts a vehicle id from the client. `trip_id` is
  optional and, when present, must belong to the caller (`get_trip_for_unit`).
- **Logging.** Access logs record the path and status only, never the body, so
  coordinates are not written to logs. `audit_log` entries for the sweep store counts,
  never coordinates (asserted by a test). `telemetry_fixes` is the only place
  coordinates live.
- **Retention.** 14 days by default (`GREENROUTE_TELEMETRY_RETENTION_DAYS`), pruned on
  write; deleting a trip cascades its fixes and position.
- **Spoofing.** A stolen unit token allows forged positions for that unit until it is
  rotated — the same exposure as any bearer credential. Partial mitigations in place:
  server-side coordinate and speed plausibility, monotonic ordering, `source`
  labelling, and the accuracy/quality label shown to operators. **GPS spoofing
  detection is not solved and must not be presented as solved.**
- **Impersonation and replay.** Replay of a captured batch is deduplicated by
  `client_fix_id`; a replayed fix with a new id but an old timestamp is refused as
  stale. Cross-unit impersonation fails because the token, not the body, names the
  vehicle.
- **What an operator can watch for.** A unit whose reported position jumps without a
  correspondingly plausible speed (rejected as `impossible_jump`), a unit that
  reports from outside its assigned area, a `poor` quality label, a unit that reports
  in bursts after long gaps, or a `source` of `manual`/`simulated` in a live response.
  None of these is proof; they are reasons to call the crew.

---

## 13. C.11 — Watchdog correction (the one lifecycle change)

**Defect.** `lifecycle.expire_stale()` cancelled every ACTIVE session with no
`last_seen_at` update for 120 s, with `close_reason` "No telemetry received from the
unit." Phase B had no telemetry writer, so this never fired — and its tests asserted
the behaviour. The moment Phase C started writing `last_seen_at`, a phone that lost
signal for two minutes would have ended a live emergency: a tunnel, a basement car
park, a dead battery, a backgrounded app. That is a data-loss bug in the shape of a
safety feature.

**Correction.**

- `lifecycle.telemetry_warnings(now)` reports ACTIVE responses whose telemetry is
  STALE, LOST or (after a 60 s start-up grace) UNKNOWN. **It never changes state.**
- `lifecycle.expire_overtime(now)` is the only automatic closure left, and it is
  about the response record, not GPS: a session ACTIVE for more than
  `MAX_ACTIVE_HOURS` (12 h) is EXPIRED. Twelve hours is long past any single
  response; without a ceiling a forgotten session would occupy a unit forever.
- `expire_stale()` remains as a deprecated alias that now applies only the ceiling,
  so any existing caller keeps working.
- `POST /api/maintenance/expire-stale` returns
  `{expired, count, telemetry_warnings}` and audits counts only.
- Tests: `test_silent_unit_is_a_telemetry_warning_not_a_cancellation` (ten minutes of
  silence leaves the session ACTIVE and warns), `test_sweep_endpoint_reports_warnings_without_changing_state`,
  `test_overtime_session_is_closed_by_the_ceiling`, `test_watchdog_is_idempotent`
  (ceiling applied once), and `test_gps_silence_never_ends_the_emergency` through the
  real telemetry path.

**Terminating a stale response now requires a person**: an authorised operator
cancels with a reason (audited), or closes it as completed. No GPS condition can
cancel a response.

**Outages and restarts.** Nothing accumulates in memory: health is computed from
stored `received_at` on every read, so a restart, a background scheduler pause or a
network outage changes what operators *see* and never what is *stored*.

---

## 14. C.12 — API and event documentation

### Live endpoints (administrative session + `trips.view`)

`GET /api/live/positions?since=<fix id>`

```json
{"event_id": 2, "server_time": "2026-11-15 09:14:42",
 "active_count": 1,
 "positions": [{
   "trip_id": 16, "reference": "TRP-1016", "name": null, "priority": "high",
   "call_sign": "MEDIC-12", "vehicle_type": "ambulance",
   "session_state": "ACTIVE", "activated_at": "2026-11-15 08:58:00",
   "destination": "Saki Naka", "destination_coords": [19.0994, 72.8891],
   "position": {"lat": 19.115, "lng": 72.87, "accuracy_m": 8.0,
                "heading_deg": 208.0, "speed_mps": 10.5,
                "device_time": "2026-11-15 09:14:42",
                "received_at": "2026-11-15 09:14:42",
                "quality": "good", "source": "gps"},
   "health": {"status": "LIVE", "age_seconds": 0, "accuracy_m": 8.0,
              "quality": "good", "message": "Reporting normally.", "tracks": true},
   "route": {"provider": "osrm", "quality": "ok", "deviation_m": 196.7,
             "computed_at": "2026-11-15 09:13:35",
             "recalculated_at": "2026-11-15 09:13:35"}
 }]}
```

`position` is `null` for a response that has not reported yet. `event_id` is the
highest `last_fix_id` in the answer and is safe to pass back as `since`; a smaller
`since` re-sends. `since` is forgiving: anything unparsable becomes 0 (full answer).

`GET /api/live/sessions/<trip_id>/track?limit=200` → `{trip_id, reference,
session_state, position, health, trail[], route, route_quality, deviation_m}` where
`trail` is `[{lat, lng, accuracy_m, heading_deg, speed_mps, device_time, received_at,
quality}]`, oldest first, and `route` is the active `emergency_routes` row including
`geometry`. 404 for an unknown response.

`POST /api/maintenance/expire-stale` (needs `trips.dispatch`) →
`{expired: [], count: 0, telemetry_warnings: [{trip_id, reference, call_sign, status,
age_seconds, session_state}]}`.

### Event types

| Event | Where | Meaning |
|---|---|---|
| `telemetry_fixes.id` | `since=` cursor | A position changed for some response |
| trip event `route` | `trip_events` | Route recalculated, or recalculation failed |
| audit `emergency.expire_sweep` | `audit_log` | Sweep ran; counts only |
| audit `emergency.transition` | `audit_log` | Human lifecycle action (Phase B) |

Lifecycle restriction, stated once: telemetry is accepted **only** for an ACTIVE
session, which in practice is the `in_transit` window.

---

## 15. C.13 — Test report

Commands and actual results on this machine (Windows, Git Bash):

```
GreenRoute$ ./.venv/Scripts/python.exe -m unittest discover -s tests
Ran 163 tests in 78.7s
OK

driver-app$ npx tsc --noEmit
(no output, exit 0)

driver-app$ npx jest
Test Suites: 6 passed, 6 total
Tests:       97 passed, 97 total
```

163 backend tests = the 121 Phase A/B tests (two watchdog tests rewritten for the
C.11 correction, everything else unchanged) + **42 new** in
`tests/test_telemetry.py`. 97 mobile tests = the 78 existing + **19 new** in
`__tests__/location.test.ts`.

New backend coverage: unauthenticated and unknown-token refusal; another unit's
response (404); completed and cancelled sessions (409); unit with no open response;
valid fix stored and acknowledged; out-of-range and null-point coordinates; absurd
accuracy; future and 30-minute-old timestamps; bad heading and speed; missing fields;
empty and oversized batches; non-JSON body; older fix cannot replace a newer
position; retried fix is a duplicate not a second row; a batch continues after one
bad fix; impossible jump; SQL definite ordering (older fix applies no row); poor
accuracy labelled; health bands LIVE/DELAYED/STALE/LOST and UNKNOWN; `last_seen_at`
touch; driver status endpoint; on-route position makes no provider call; meaningful
deviation recalculates once and then reports `cooldown`; superseded route preserved;
routing failure degrades quality and keeps the route; low accuracy cannot trigger a
recalculation; GPS silence never ends an emergency; sweep reports warnings without
changing state; overtime session closed once; live endpoints require auth; VIEWER may
read; the `since` cursor returns only newer state; a completed response leaves the
live list; track endpoint trail/health and 404; coordinates absent from `audit_log`;
retention prune removes only expired fixes.

New mobile coverage: `shouldShare` only for `in_transit`; coordinate and accuracy
rejection; stationary rejection and silent-vehicle check-in; distance measurement;
fix identity and null heading/speed; buffer count and age trimming; tracker start and
send; permission denial; outage buffering then catch-up; bounded buffer; token expiry
stops sharing; sequence resumes after restart; pause/resume; stop clears the buffer.

**Regression.** Phases A and B: all previously passing tests still pass, `tsc` clean,
and the admin pages render (the fleet map was loaded in a real browser signed in as a
VIEWER).

**Simulation, not road testing.** Every coordinate above is fabricated. No emergency
vehicle and no public road was involved. **No physical Android or iOS device was
used**, so GPS accuracy, battery use, permission dialogs, background pause and the
badge's appearance on a real screen are **unverified**.

---

## 16. C.14 — Performance estimates

Assumptions: one fix per 10 s per moving vehicle (6/min), ~120 bytes of JSON per fix
plus ~200 bytes of headers, one poll per open admin tab every 5 s, `telemetry_fixes`
row ≈ 160 bytes plus indexes ≈ 230 bytes.

| Active vehicles | Fixes/min | Writes/min (trail + position) | Ingest bytes/min | Trail storage/day | Admin polls/min (1 tab) | Poll payload |
|---|---|---|---|---|---|---|
| 10 | 60 | 120 | ~19 KB | ~20 MB | 12 | ~2 KB |
| 100 | 600 | 1,200 | ~190 KB | ~200 MB | 12 | ~20 KB |
| 1,000 | 6,000 | 12,000 | ~1.9 MB | ~2 GB | 12 | ~200 KB |
| 10,000 | 60,000 | 120,000 | ~19 MB | ~20 GB | 12 | ~2 MB |

Reading these honestly:

- **Registered ≠ active.** The fleet registry can hold thousands of vehicles; only
  ACTIVE sessions generate any of the above. The dashboard query is
  `WHERE s.state = 'ACTIVE'`, so idle units cost nothing.
- **SQLite is comfortable to ~100 concurrent active vehicles** on this class of
  machine (≈1,200 writes/min, WAL, one writer). At 1,000 it is the bottleneck: every
  batch takes the write lock, and a single-file database gives no concurrent writers.
- **10,000 vehicles is out of scope for this deployment** and is stated as such: it
  needs a real database with concurrent writers and a partitioned positions table.
  The event-id contract, the payload shapes and the client would survive that change;
  only `db.py`'s storage functions would move.
- **Polling payload grows with the fleet**, not with changes: at 1,000 active units a
  full answer is ~200 KB every 30 s per tab (the full poll), which is why `since` is
  the default path.
- **Retention dominates storage**: 14 days at 1,000 vehicles ≈ 28 GB, at 10 vehicles
  ≈ 280 MB. Retention is a one-line environment change if that is too much.
- **What was not optimized.** No caching layer, no batching across vehicles, no
  compression, no WebSocket fan-out. Nothing measured justifies any of it at the
  scale this project will actually run.

---

## 17. Configuration

| Variable | Default | Effect |
|---|---|---|
| `GREENROUTE_TELEMETRY_RETENTION_DAYS` | `14` | Trail retention; pruned on write |
| `GREENROUTE_DEVIATION_M` | `150` | Off-route distance that counts as a deviation |
| `GREENROUTE_RECALC_COOLDOWN_S` | `90` | Minimum gap between recalculations |
| `EXPO_PUBLIC_API_BASE` (phone) | — | Dispatch base URL, unchanged from Phase A/B |

Phone-side constants live in `src/location.ts`: `UPDATE_INTERVAL_MS` 10 000,
`UPDATE_DISTANCE_M` 25, `ACCURACY_CEILING_M` 100, `MIN_STEP_M` 8, `BUFFER_LIMIT` 12,
`BUFFER_TTL_MS` 120 000, `BATCH_LIMIT` 20. Server bands live in `telemetry.py`:
LIVE 15 s, DELAYED 45 s, STALE 120 s, LOST > 120 s, max jump 2 km/10 s, max speed
200 km/h, clock skew 120 s, max fix age 300 s, batch 60.

---

## 18. Limitations and unresolved risks

1. **Foreground-only tracking.** A backgrounded or force-quit app stops reporting.
   The dashboard shows STALE/LOST; the response stays live. A background task
   (`expo-task-manager` + `startLocationUpdatesAsync`) is the fix if the crew needs
   it, and it is deliberately not built here.
2. **No physical-device verification.** Permission dialogs, real GPS accuracy,
   battery use and the on-screen badge are unverified.
3. **No push transport.** 5 s polling means up to 5 s of display lag and one request
   per open tab per 5 s.
4. **Spoofing is mitigated, not detected.** Plausibility checks catch gross
   inconsistencies only.
5. **Single-writer SQLite** caps concurrent active vehicles at roughly 100.
6. **Deviation is line-of-sight to the polyline**, not a map-matching or
   turn-by-turn analysis; a position on a parallel road 150 m away is "on route".
7. **A route recalculation is not communicated to the crew's phone.** The phone keeps
   the geometry it received with the assignment until its next `/unit` poll, which
   does not include a new route. Closing that gap is Phase D work.
8. **`telemetry_fixes` grows with retention**; pruning is on the write path and could
   become noticeable at high volume on SQLite.

---

## 19. How to run Phase C

```bash
# Backend (already running on this machine; pid in .run/flask.pid)
cd backend
./.venv/Scripts/python.exe -m flask --app app run --host 127.0.0.1 --port 5000 --no-reload

# Phone
cd driver-app
npx expo install            # expo-location is already in package.json
npx tsc --noEmit
npx jest
npx expo start              # then press "a" for an Android device/emulator

# Simulated vehicle without a phone (the demo unit MEDIC-12 owns TRP-1016)
TOKEN=token-medic12
curl -X POST http://127.0.0.1:5000/api/driver/telemetry \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"fixes\":[{\"lat\":19.1170,\"lng\":72.8680,\"accuracy_m\":8,
       \"device_time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"client_fix_id\":\"MEDIC-12:100\",\"sequence\":100}]}"

# Watch it: sign in at http://127.0.0.1:5000/ and open /fleet-map
```

`expo start` is required for `expo-location` because it is a native module: an
existing Expo Go install can load it, but a custom dev build must be rebuilt after
`npx expo install`.

---

## 20. Phase D readiness

Ready to build on:

- `telemetry.ingest` is the single entry point for a position, and it already returns
  the latest position and route state — a 500 m alert engine can be a subscriber,
  not a second pipeline.
- `vehicle_positions` gives one indexed row per response with health attached; the
  alert engine needs only `lat`, `lng`, `destination_lat/lng` and a distance.
- The event id (`telemetry_fixes.id`) is transport-agnostic, so alerts can ride the
  same cursor or a future push channel.
- `lifecycle` + audit give the alert engine an authorised actor model and an
  append-only record to write to.

Gaps to close first:

1. The phone is not told about a server-side recalculation (§18.7).
2. No background location, so a parked crew that leaves the app closed is invisible.
3. `notifications` do not exist; `client_events` is driver-originated only.
4. SQLite's single writer is the ceiling for anything above ~100 active vehicles.

Nothing beyond Phase C was started: no 500 m alerts, no public-driver tracking, no
public notifications, no traffic-signal control.
