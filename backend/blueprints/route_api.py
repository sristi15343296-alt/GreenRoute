"""Route resolution endpoint.

One URL for every caller: the admin pages and the crew phones. It replaces two
copies of an OSRM URL that lived in `static/js/app.js` and
`static/js/trip_create.js`, which meant the route an operator saw and the route
a crew drew could come from different code paths.

Deliberate behaviour:

* The provider is never trusted. A failure returns a straight-line fallback with
  `provider: "straight-line"` rather than pretending a road route exists.
* If `trip_id` is given, the geometry is stored on the trip and recorded in
  `emergency_routes`, so the corridor a crew drove is auditable afterwards.
* No traffic data is available on the free provider. `duration_s` is a
  free-flow estimate and is labelled as such in the response.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

import db as store
import routing
import geocoding

route_api = Blueprint("route_api", __name__, url_prefix="/api")

MAX_POINTS = 5000


def _parse_point(value):
    if isinstance(value, dict):
        value = [value.get("lat"), value.get("lng")]
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        lat, lng = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        return None
    return (lat, lng)


@route_api.post("/route")
def resolve():
    body = request.get_json(silent=True) or {}

    origin = _parse_point(body.get("origin"))
    destination = _parse_point(body.get("destination"))
    if origin is None or destination is None:
        return (
            jsonify({"error": "origin and destination must be [lat, lng] pairs."}),
            422,
        )

    trip_id = body.get("trip_id")
    if trip_id is not None:
        try:
            trip_id = int(trip_id)
        except (TypeError, ValueError):
            return jsonify({"error": "trip_id must be an integer."}), 422

    reason = str(body.get("reason") or "manual")[:32]

    raw_waypoints = body.get("waypoints") or []
    if not isinstance(raw_waypoints, list):
        return jsonify({"error": "waypoints must be a list of [lat, lng] pairs."}), 422
    waypoints = [point for point in (_parse_point(item) for item in raw_waypoints) if point]

    degraded = False
    try:
        resolved = routing.resolve_route(origin, destination, waypoints=waypoints)
    except routing.RoutingError as error:
        resolved = routing.straight_line(origin, destination)
        resolved["notice"] = str(error)
        degraded = True

    geometry = resolved.get("geometry") or []
    if len(geometry) > MAX_POINTS:
        step = max(1, len(geometry) // MAX_POINTS)
        geometry = geometry[::step] + [geometry[-1]]

    stored = False
    if trip_id is not None:
        try:
            store.save_route(
                trip_id,
                {
                    "geometry": geometry,
                    "distance_m": resolved.get("distance_m"),
                    "duration_s": resolved.get("duration_s"),
                    "provider": resolved.get("provider"),
                },
                reason=reason,
            )
            stored = True
        except LookupError:
            return jsonify({"error": "Trip not found."}), 404
        except ValueError as error:
            return jsonify({"error": str(error)}), 422

    distance_m = resolved.get("distance_m")
    duration_s = resolved.get("duration_s")

    return jsonify(
        {
            "route": {
                "geometry": geometry,
                "distance_m": distance_m,
                "distance_km": None if distance_m is None else round(distance_m / 1000, 2),
                "duration_s": duration_s,
                "duration_min": None if duration_s is None else round(duration_s / 60, 1),
                "provider": resolved.get("provider"),
                # Stated in the payload itself so no screen has to remember it.
                "traffic": "free-flow (no live traffic data)",
                "degraded": degraded,
                "stored": stored,
                "notice": resolved.get("notice"),
            },
            # Kept for callers that only want the number.
            "direct_km": round(geocoding.haversine_km(origin, destination), 2),
        }
    )


@route_api.get("/route/<int:trip_id>")
def active(trip_id):
    """The route currently in force for a trip, straight from the audit trail."""
    trip = store.get_trip(trip_id)
    if trip is None:
        return jsonify({"error": "Trip not found."}), 404

    stored = store.active_route(trip_id)
    if stored is None:
        return jsonify({"error": "This response has no stored route."}), 404
    return jsonify({"route": stored})
