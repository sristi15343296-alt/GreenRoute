# Phase A — backend foundation, routing and the driver API

The first milestone turned a single-operator admin page into a system with a server
it talks to and a second client it serves. What it put in place is still the base
everything else stands on.

---

## 1. Server-side routing

Before Phase A the browser asked a public routing service directly and drew whatever
came back. Now the server resolves and stores:

- `routing.resolve_route(origin, destination)` calls OSRM over HTTP, normalises the
  answer to `{provider, geometry, distance_m, duration_s}` and never invents
  geometry. A provider failure is an exception, not an empty route.
- `route_cache` keys a provider answer by rounded endpoints, so the admin, the crew
  phone and a route preview share one call.
- `emergency_routes` keeps every route a response has had. The newest row with
  `superseded_by IS NULL` is active; older rows remain answerable, which is what makes
  "what was the path at 14:32" a query rather than a guess.
- `trips.route_json`, `route_provider`, `route_computed_at` and `route_distance_m`
  carry the current geometry so a screen never recomputes it.

One rule held from this milestone onward: a straight line between endpoints is not a
route. Where geometry is missing the interface says so instead of drawing a line and
calling it navigable.

## 2. Driver API

`blueprints/driver_api.py` is the crew phone's only interface. It was built around
three constraints:

1. **Identity from the credential.** `Authorization: Bearer token-<call sign>`; the
   vehicle is resolved by call sign on every request. No endpoint accepts a vehicle id
   from the client.
2. **Ownership on every read.** `db.get_trip_for_unit` scopes a response to the unit;
   another unit's response is `404`, not `403`, so the API does not confirm that an
   id exists.
3. **Idempotent actions.** `POST /trips/<id>/transition` carries a client-generated
   `client_event_id` and the status the phone believed it was in. A repeat returns
   `replayed: true` instead of applying twice; a stale `expected_status` returns `409`
   with the current trip so the phone can adopt it.

Endpoints: `/unit`, `/assignments`, `/trips/<id>`, `/trips/<id>/transition`,
`/trips/<id>/issue`, `/trips/<id>/backup`.

The trip projection is an allow-list. The phone receives exactly what it renders and
cannot accidentally start depending on a column that later changes meaning.

## 3. Route API for the admin

`blueprints/route_api.py` exposes `POST /api/route` (resolve, optionally store) and
`GET /api/route/<trip_id>` (active route). Both now require `route.resolve`; that
permission was added in Phase B, and it is the only breaking change Phase B made to
this milestone's surface.

## 4. Database work

Added `trips.route_*` columns, `route_cache`, `emergency_routes` and `client_events`,
all through the same guarded `init_db()` migration that later phases extended.
Idempotency is a primary key, not application logic: `client_events.client_event_id`
is unique, so two concurrent retries cannot both insert.

## 5. Mobile client changes

The phone stopped building URLs and guessing routes: it reads the stored geometry
from its assignment and renders that, with the same "no route yet" wording the admin
uses. The outbox (durable transition queue with bounded retries) also dates from this
milestone.

## 6. Demo seed

`seed_driver_demo.py --unit MEDIC-12` assigns one open response to a unit, resolves
and stores its route, and prints the token to type into the phone. It exists because
an empty Home screen looks like a broken integration rather than an empty queue.

## 7. Verification

`tests/test_routing.py` and `tests/test_driver_api.py` cover provider normalisation,
cache hits, ownership, idempotent replay, stale-state conflicts and the shape of the
driver projection. All of those tests still pass; Phase B extended them with actor
attribution and Phase C added telemetry without changing the contract.

## 8. What Phase A did not do

No authentication of any kind on the admin surface (Phase B), no emergency lifecycle
beyond `trips.status` (Phase B), no location (Phase C). The README at the time said so
explicitly, which is why it read as a single-operator portfolio project.
