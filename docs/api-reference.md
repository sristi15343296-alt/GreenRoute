# API reference

Two APIs share one Flask process and one database:

- **Administrative API** — cookie session, CSRF header, permission per endpoint.
- **Driver API** — bearer unit token, scoped to one vehicle.

All responses are JSON. Timestamps are UTC strings in the project's storage format
(`YYYY-MM-DD HH:MM:SS`) unless a field name says otherwise; the phone sends ISO-8601
with an offset and the server normalises it.

---

## 1. Authentication

### Administrative session

1. `GET /login` returns the form with a CSRF token.
2. `POST /login` with `email`, `password`, `csrf_token` sets an `HttpOnly` session
   cookie and redirects.
3. `GET /api/admin/session` returns the signed-in identity and the per-session CSRF
   token used by the browser JavaScript.
4. Every state-changing request must send that token in `X-CSRF-Token`.

Sessions expire after 8 hours absolute or 45 minutes idle. Five failed sign-ins in
fifteen minutes pause sign-in for that e-mail and address. A request without a valid
session gets `302` for a page and `401` for an API path.

### Driver unit token

```
Authorization: Bearer token-<call sign, lowercased, punctuation removed>
```

`MEDIC-12` → `token-medic12`. The token is resolved against the vehicle registry on
every request; a vehicle removed from the registry stops authenticating immediately.
The driver API ignores cookies and CSRF entirely.

### Error envelope

```json
{ "error": "Human-readable sentence.", "code": "machine_code" }
```

`code` is present where the client needs to branch. Validation failures on forms
return `{"errors": {"field": "message"}}` with `400`.

---

## 2. Driver API

Base path `/api/driver`. Every endpoint requires the unit token and is scoped to that
unit's own responses.

| Method | Path | Purpose |
|---|---|---|
| GET | `/unit` | Unit identity, current assignment, queue count, server time |
| GET | `/assignments` | All open responses for this unit |
| GET | `/trips/<id>` | One response, with timeline and allowed actions |
| POST | `/trips/<id>/transition` | Advance the lifecycle, idempotent |
| POST | `/trips/<id>/issue` | Report a problem; no status change |
| POST | `/trips/<id>/backup` | Request backup; no status change |
| POST | `/telemetry` | Upload a batch of GPS fixes |
| GET | `/telemetry` | Whether this unit is being tracked, and how fresh |

### `GET /api/driver/unit`

```json
{
  "call_sign": "MEDIC-12",
  "vehicle_type": "ambulance",
  "assignment": { "id": 16, "reference": "TRP-1016", "status": "in_transit", "...": "..." },
  "queue_count": 0,
  "server_time": "2026-11-15 09:14:42"
}
```

`assignment` is `null` when the unit has nothing open. The trip projection is an
allow-list: identity, status and labels, priority, endpoints and coordinates, distance
and duration, dispatch time, instructions, incident reference, stored route geometry,
`timeline`, and `next_actions` (the actions the server will accept right now).

### `POST /api/driver/trips/<id>/transition`

```json
{ "to": "accepted", "expected_status": "scheduled",
  "client_event_id": "6f1c9a2e-…", "client_at": "2026-11-15T09:12:03Z" }
```

| Status | Meaning |
|---|---|
| 200 | `{"trip": {...}, "replayed": false}` — applied, or `replayed: true` for a repeated `client_event_id` |
| 400 | Illegal edge, or a missing field |
| 401 | Missing or unknown token |
| 403 | The response belongs to another unit |
| 404 | No such response |
| 409 | Someone else moved it first; the body carries `current_status` and the current `trip` |

### `POST /api/driver/telemetry`

```json
{
  "trip_id": 16,
  "fixes": [
    { "lat": 19.1170, "lng": 72.8680, "accuracy_m": 7.5,
      "heading_deg": 205, "speed_mps": 11.2,
      "device_time": "2026-11-15T09:13:34Z",
      "client_fix_id": "MEDIC-12:1", "sequence": 1, "source": "gps" }
  ]
}
```

`trip_id` is optional; without it the unit's own open response is used. `source` is
one of `gps`, `network`, `manual`, `simulated` and defaults to `gps`.

**200** — at least one fix was stored or already known:

```json
{ "telemetry": {
    "trip_id": 16, "session_state": "ACTIVE",
    "accepted": 1, "duplicates": 0, "rejected": 0,
    "outcomes": [{ "index": 0, "accepted": true, "duplicate": false, "fix_id": 1, "applied": true }],
    "latest": { "lat": 19.117, "lng": 72.868, "accuracy_m": 7.5, "heading_deg": 205,
                "speed_mps": 11.2, "device_time": "2026-11-15 09:13:34",
                "received_at": "2026-11-15 09:13:34", "quality": "good" },
    "health": { "status": "LIVE", "age_seconds": 0, "accuracy_m": 7.5,
                "quality": "good", "message": "Reporting normally.", "tracks": true },
    "recalculation": { "recalculated": true, "provider": "osrm", "distance_m": 3675.3 },
    "route": { "provider": "osrm", "quality": "ok", "deviation_m": 196.7,
               "recalculated_at": "2026-11-15 09:13:35" } } }
```

A batch in which nothing was stored or already known is an error status, with the
per-fix detail still present under `telemetry`.

| Status | `error_code` | Meaning |
|---|---|---|
| 400 | `invalid_payload` | Not JSON, or no non-empty `fixes` array |
| 401 | `authentication_required` | Missing or unknown token |
| 404 | `not_your_response` | `trip_id` belongs to another unit |
| 409 | `no_active_response` | This unit has no open response |
| 409 | `session_not_trackable` | The session is not ACTIVE |
| 413 | `batch_too_large` | More than 60 fixes |
| 422 | `invalid_coordinates` | Outside the world, or the null point |
| 422 | `accuracy_out_of_range` | `accuracy_m` < 0 or > 1000 |
| 422 | `future_timestamp` | More than 120 s ahead of the server |
| 422 | `stale_timestamp` | More than 300 s old |
| 422 | `invalid_field`, `missing_field` | Bad heading, speed, sequence, time or type |
| 422 | `out_of_order` | Older than the stored position |
| 422 | `impossible_jump` | > 2 km in < 10 s, or implied speed > 200 km/h |

A repeated `client_fix_id` is answered `{"duplicate": true}` with the original
`fix_id`, before any ordering check.

### `GET /api/driver/telemetry`

```json
{ "telemetry": { "tracking": true, "reason": "ok", "trip_id": 16,
                 "session_state": "ACTIVE",
                 "health": { "status": "LIVE", "age_seconds": 1, "...": "..." },
                 "retention_days": 14 } }
```

---

## 3. Administrative API

Every endpoint below needs a session and the permission shown. `X-CSRF-Token` is
required for `POST`, `PATCH` and `DELETE`.

### Responses

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/trips` | `trips.view` | List, filtered by `status`, `priority`, `q`; returns `trips`, `counts`, `generated_at` |
| GET | `/api/trips/<id>` | `trips.view` | One response with assignment and events |
| POST | `/api/trips` | `trips.create` | Create a response |
| PATCH | `/api/trips/<id>` | `trips.dispatch` | Apply a lifecycle action: `{"action": "depart", "expected_state": "VERIFIED", "reason": "..."}` |
| POST | `/api/trips/bulk` | `trips.dispatch` | Apply one action to several responses |
| PATCH | `/api/trips/<id>/location` | `trips.dispatch` | Correct endpoint coordinates |
| POST | `/api/trips/<id>/geocode` | `trips.dispatch` | Resolve endpoints from the recorded addresses |
| GET | `/api/resources/availability` | `trips.view` | Vehicles and personnel with availability reasons |

`PATCH /api/trips/<id>` returns `{"trip": {...}}`, or an error with `code` and
`status` from the lifecycle (`illegal_transition`, `stale_state`, `reason_required`,
`forbidden`, `not_found`).

### Routing and addresses

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/route` | `route.resolve` | Resolve a route between two points; optionally store it on a response |
| GET | `/api/route/<trip_id>` | `route.resolve` | The active stored route for a response |
| GET | `/api/geocode` | `trips.dispatch` | Single-address lookup (Nominatim) |
| GET | `/api/locations/suggest` | `trips.dispatch` | Address suggestions (Photon) |

### Live telemetry

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/live/positions?since=<fix id>` | `trips.view` | Active responses with latest position, health and route state |
| GET | `/api/live/sessions/<trip_id>/track?limit=200` | `trips.view` | Trail, active route geometry and health for one response |
| POST | `/api/maintenance/expire-stale` | `trips.dispatch` | Report telemetry warnings and apply the 12-hour activation ceiling |

`/api/live/positions` returns `{event_id, server_time, active_count, positions[]}`.
`event_id` is the highest fix id in the answer and is safe to pass back as `since`;
an unparsable `since` becomes 0 (full answer). Each entry carries `trip_id`,
`reference`, `call_sign`, `session_state`, `destination_coords`, `position` (or
`null`), `health` and `route`.

`/api/live/sessions/<id>/track` returns `{trip_id, reference, session_state, position,
health, trail[], route, route_quality, deviation_m}`; `404` for an unknown response.

### Administrators and audit

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/administrators` | `admins.manage` | Account list |
| POST | `/administrators` | `admins.manage` | Create an account |
| POST | `/administrators/<id>/role` | `admins.manage` | Change role |
| POST | `/administrators/<id>/status` | `admins.manage` | Activate or disable |
| POST | `/administrators/<id>/password` | `admins.manage` | Reset a password |
| GET | `/administrators/audit` | `audit.view` | Audit log, filterable |

### Exports

| Method | Path | Permission |
|---|---|---|
| GET | `/trips/export.csv` | `trips.export` |
| GET | `/trips/<id>/export.csv` | `trips.export` |
| GET | `/analytics/export.csv` | `trips.export` |
| GET | `/analytics/export.json` | `trips.export` |

### Screens

`/`, `/fleet-map`, `/trips`, `/trips/new`, `/trips/<id>`, `/resources`, `/analytics`,
`/settings` are server-rendered pages behind the same permission map. They are not
part of the JSON contract and are documented in `docs/architecture.md`.

---

## 4. Status and lifecycle vocabulary

Trip statuses: `scheduled`, `accepted`, `in_transit`, `on_scene`, `completed`,
`cancelled`.

Lifecycle actions: `verify`, `activate`, `depart`, `arrive`, `complete`, `cancel`,
`expire`. The admin UI's action names are aliased onto these; the phone's
`next_actions` come from the same table, so the two cannot disagree.

Emergency session states: `CREATED`, `VERIFIED`, `ACTIVE`, `ON_SCENE`, `COMPLETED`,
`CANCELLED`, `EXPIRED`. Only `ACTIVE` accepts telemetry.
