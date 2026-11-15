"""Emergency vehicle telemetry: validation, quality, and route deviation.

This module is the boundary between a GPS fix and everything downstream. A fix
arrives from an authenticated unit, is validated and quality-labelled here, is
persisted by `db`, and only then may affect the latest-position row, the session's
`last_seen_at` or the active route.

Design rules (Phase C)
----------------------
* **The client never names its vehicle or session.** Identity comes from the
  bearer token, the session from the trip it owns.
* **Coordinates are validated server-side.** A client can lie about anything;
  the server decides what is physically possible.
* **Time is two facts.** `device_time` is when the phone measured the fix;
  `received_at` is when the server stored it. Both are kept, and staleness is
  computed from the server's clock so a wrong phone clock cannot fake freshness.
* **An older fix never overwrites a newer one.** Ordering is enforced in SQL
  (`db.upsert_latest_position`) as well as here.
* **Telemetry loss is not an emergency.** Health degrades to STALE or LOST and
  the operator is told; the lifecycle state stays exactly as it was.
* **Degraded is not degraded silently.** A straight-line fallback is labelled
  `straight-line` and never presented as a navigable road route.
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone

import db as store
import geocoding
import lifecycle
import routing

# ---------------------------------------------------------------------------
# Policy constants (all overridable by environment where it matters)
# ---------------------------------------------------------------------------

#: A fix more accurate than this is trusted for map display and deviation tests.
TRUSTED_ACCURACY_M = 100.0
#: A fix worse than this is stored but marked `poor`, and never used to decide a
#: route recalculation.
MAX_ACCEPTED_ACCURACY_M = 1000.0

#: 200 km/h. Above this between two consecutive fixes, something is wrong.
MAX_SPEED_MPS = 55.6
#: A jump larger than this between two fixes closer than JUMP_MIN_SECONDS apart
#: is treated as an artefact rather than travel.
MAX_JUMP_M = 2000.0
JUMP_MIN_SECONDS = 10.0

#: A fix dated further in the future than this is rejected outright.
MAX_FUTURE_SKEW_SECONDS = 120
#: A buffered fix older than this is discarded client- and server-side: it no
#: longer describes where the vehicle is.
MAX_FIX_AGE_SECONDS = 300
#: Fixes accepted in one request.
MAX_BATCH = 60
#: Payload size ceiling for the whole batch (the app trims to this).
MAX_BATCH_BYTES = 64 * 1024

#: Route deviation: more than this from the active polyline is meaningful.
DEVIATION_THRESHOLD_M = 150.0
#: Never recompute more often than this, however far the vehicle wanders.
RECALC_COOLDOWN_SECONDS = 90
#: Two consecutive off-route fixes must agree before a recalculation is spent.
DEVIATION_STRIKES = 2

#: Health bands, measured from the server's clock against `received_at`.
LIVE_AFTER_SECONDS = 15
DELAYED_AFTER_SECONDS = 45
STALE_AFTER_SECONDS = 120
LOST_AFTER_SECONDS = 300

HEALTH_STATES = ["LIVE", "DELAYED", "STALE", "LOST", "UNKNOWN"]

#: Where a fix came from. Kept explicit so an import or a replay is never
#: mistaken for a live GPS reading.
SOURCES = {"gps", "network", "manual", "simulated"}


def retention_days() -> int:
    try:
        return max(1, int(os.environ.get("GREENROUTE_TELEMETRY_RETENTION_DAYS", "14")))
    except ValueError:
        return 14


def deviation_threshold_m() -> float:
    try:
        return max(20.0, float(os.environ.get("GREENROUTE_DEVIATION_M", DEVIATION_THRESHOLD_M)))
    except ValueError:
        return DEVIATION_THRESHOLD_M


def recalc_cooldown_seconds() -> int:
    try:
        return max(
            10, int(os.environ.get("GREENROUTE_RECALC_COOLDOWN_S", RECALC_COOLDOWN_SECONDS))
        )
    except ValueError:
        return RECALC_COOLDOWN_SECONDS


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FixRejected(Exception):
    """A fix that must not be stored. `code` is stable for the client."""

    def __init__(self, code, message, index=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.index = index


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _as_float(value, field, *, allow_none=True):
    if value is None:
        if allow_none:
            return None
        raise FixRejected("missing_field", f"{field} is required.")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FixRejected("invalid_field", f"{field} must be a number.")
    number = float(value)
    if not math.isfinite(number):
        raise FixRejected("invalid_field", f"{field} must be a finite number.")
    return number


def _parse_time(value, field):
    if not isinstance(value, str) or not value.strip():
        raise FixRejected("missing_field", f"{field} is required.")
    raw = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as error:
        raise FixRejected("invalid_field", f"{field} must be an ISO-8601 timestamp.") from error
    if parsed.tzinfo is None:
        # Permissive on purpose: the project's own storage format is naive UTC,
        # and a device that sends a local time without an offset is treated the
        # same way `db.parse_dt` treats it everywhere else. Clients are told to
        # send ISO-8601 with an offset; this avoids rejecting a whole batch over
        # a formatting slip.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_fix(raw, now=None):
    """Validate one fix from the phone. Returns a normalised dict.

    Raises `FixRejected` with a stable code: `invalid_coordinates`,
    `missing_field`, `invalid_field`, `future_timestamp`, `stale_timestamp`.
    """
    if not isinstance(raw, dict):
        raise FixRejected("invalid_fix", "Each fix must be an object.")

    lat = _as_float(raw.get("lat"), "lat", allow_none=False)
    lng = _as_float(raw.get("lng"), "lng", allow_none=False)
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        raise FixRejected("invalid_coordinates", "Coordinates are outside the world.")
    if lat == 0.0 and lng == 0.0:
        # Null island: the classic "GPS not ready" placeholder.
        raise FixRejected("invalid_coordinates", "Coordinates are the null point.")

    accuracy = _as_float(raw.get("accuracy_m"), "accuracy_m")
    if accuracy is not None and (accuracy < 0 or accuracy > MAX_ACCEPTED_ACCURACY_M):
        raise FixRejected(
            "accuracy_out_of_range",
            f"accuracy_m must be between 0 and {MAX_ACCEPTED_ACCURACY_M:.0f}.",
        )

    heading = _as_float(raw.get("heading_deg"), "heading_deg")
    if heading is not None and not (0.0 <= heading < 360.0):
        raise FixRejected("invalid_field", "heading_deg must be in [0, 360).")

    speed = _as_float(raw.get("speed_mps"), "speed_mps")
    if speed is not None and speed < 0:
        raise FixRejected("invalid_field", "speed_mps cannot be negative.")

    device_time = _parse_time(raw.get("device_time"), "device_time")
    now = now or store.utcnow()
    if (device_time - now).total_seconds() > MAX_FUTURE_SKEW_SECONDS:
        raise FixRejected("future_timestamp", "The fix is dated in the future.")

    received = now
    age = (received - device_time).total_seconds()
    if age > MAX_FIX_AGE_SECONDS:
        raise FixRejected("stale_timestamp", "The fix is too old to be useful.")

    sequence = raw.get("sequence")
    if sequence is not None:
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
            raise FixRejected("invalid_field", "sequence must be a non-negative integer.")

    client_fix_id = raw.get("client_fix_id")
    if client_fix_id is not None and (
        not isinstance(client_fix_id, str) or not client_fix_id.strip() or len(client_fix_id) > 80
    ):
        raise FixRejected("invalid_field", "client_fix_id must be a short string.")

    source = (raw.get("source") or "gps").strip().lower()
    if source not in SOURCES:
        raise FixRejected("invalid_field", "source is not recognised.")

    return {
        "lat": lat,
        "lng": lng,
        "accuracy_m": accuracy,
        "heading_deg": heading,
        "speed_mps": speed,
        "device_time": store.stamp(device_time),
        "device_time_dt": device_time,
        "received_at": store.stamp(received),
        "sequence": sequence,
        "client_fix_id": (client_fix_id.strip() if client_fix_id else None),
        "source": source,
    }


def _is_older_than_latest(previous, fix) -> bool:
    """Ordering with a tie-break.

    Fixes routinely arrive inside the same second; a strictly-greater timestamp
    rule would throw away the second half of every burst. Ties are broken by the
    device's monotonic sequence, and only then rejected.
    """
    previous_time = store.parse_dt(previous["device_time"])
    if fix["device_time_dt"] < previous_time:
        return True
    if fix["device_time_dt"] > previous_time:
        return False
    previous_sequence = previous["sequence"] if previous["sequence"] is not None else -1
    sequence = fix["sequence"] if fix["sequence"] is not None else -1
    return sequence <= previous_sequence


def quality_label(fix) -> str:
    accuracy = fix.get("accuracy_m")
    if accuracy is None:
        return "unknown-accuracy"
    if accuracy <= TRUSTED_ACCURACY_M:
        return "good"
    if accuracy <= MAX_ACCEPTED_ACCURACY_M:
        return "poor"
    return "unusable"


# ---------------------------------------------------------------------------
# Physical plausibility
# ---------------------------------------------------------------------------


def distance_m(a, b) -> float:
    return geocoding.haversine_km((a[0], a[1]), (b[0], b[1])) * 1000.0


def implied_speed_mps(previous, fix) -> float | None:
    """Speed implied by two fixes, or None when the times are too close."""
    if previous is None:
        return None
    seconds = (
        fix["device_time_dt"] - store.parse_dt(previous["device_time"])
    ).total_seconds()
    if seconds <= 0:
        return None
    travelled = distance_m(
        (previous["lat"], previous["lng"]), (fix["lat"], fix["lng"])
    )
    return travelled / seconds


def is_impossible_jump(previous, fix) -> bool:
    """A teleport that no road vehicle could make in the elapsed time.

    Deliberately conservative: it catches GPS artefacts and obvious spoofing,
    not a vehicle that is genuinely fast. A tunnel exit can produce a jump and
    will be discarded — the next fix re-establishes the position.
    """
    if previous is None:
        return False
    seconds = (
        fix["device_time_dt"] - store.parse_dt(previous["device_time"])
    ).total_seconds()
    if seconds <= 0:
        return False
    travelled = distance_m(
        (previous["lat"], previous["lng"]), (fix["lat"], fix["lng"])
    )
    if travelled > MAX_JUMP_M and seconds < JUMP_MIN_SECONDS:
        return True
    return (travelled / seconds) > MAX_SPEED_MPS and seconds >= JUMP_MIN_SECONDS


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def health(position, session_state=None, now=None):
    """Telemetry health for one latest-position row.

    `status` is about *data freshness*, never about the emergency: an operator
    must be able to see "the vehicle is fine, the phone stopped reporting".
    """
    now = now or store.utcnow()
    if position is None:
        return {
            "status": "UNKNOWN",
            "age_seconds": None,
            "accuracy_m": None,
            "quality": None,
            "message": "No position has been reported for this response.",
            "tracks": session_state == lifecycle.ACTIVE if session_state else False,
        }

    received = store.parse_dt(position["received_at"])
    age = max(0, int((now - received).total_seconds()))
    if age <= LIVE_AFTER_SECONDS:
        status = "LIVE"
    elif age <= DELAYED_AFTER_SECONDS:
        status = "DELAYED"
    elif age <= STALE_AFTER_SECONDS:
        status = "STALE"
    elif age <= LOST_AFTER_SECONDS:
        status = "LOST"
    else:
        status = "LOST"

    accuracy = position["accuracy_m"]
    quality = (
        "unknown"
        if accuracy is None
        else "good"
        if accuracy <= TRUSTED_ACCURACY_M
        else "poor"
    )

    if status == "LIVE":
        message = "Reporting normally."
    elif status == "DELAYED":
        message = "Last report is a little old."
    elif status == "STALE":
        message = "No recent report. Treat this position as historical."
    else:
        message = "Signal lost. The position shown is not current."

    return {
        "status": status,
        "age_seconds": age,
        "accuracy_m": accuracy,
        "quality": quality,
        "message": message,
        "tracks": bool(session_state == lifecycle.ACTIVE),
    }


# ---------------------------------------------------------------------------
# Route deviation
# ---------------------------------------------------------------------------


def point_to_segment_m(point, start, end) -> float:
    """Distance from a point to a segment, in metres, on a local flat projection.

    At city scale the equirectangular approximation is well inside GPS accuracy,
    and it avoids pulling in a geometry dependency for one calculation.
    """
    lat0 = math.radians(point[0])
    kx = math.cos(lat0) * 111_320.0
    ky = 110_540.0

    px, py = point[1] * kx, point[0] * ky
    ax, ay = start[1] * kx, start[0] * ky
    bx, by = end[1] * kx, end[0] * ky

    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def distance_to_route_m(position, geometry) -> float | None:
    """Shortest distance from a position to a polyline, or None without one."""
    if not geometry or len(geometry) < 2:
        return None
    point = (float(position["lat"]), float(position["lng"]))
    best = None
    for index in range(len(geometry) - 1):
        start = geometry[index]
        end = geometry[index + 1]
        try:
            metres = point_to_segment_m(point, (start[0], start[1]), (end[0], end[1]))
        except (TypeError, ValueError, IndexError):
            continue
        if best is None or metres < best:
            best = metres
    return best


def route_state(trip_id):
    """The stored route plus how far the latest trusted position is from it."""
    route = store.active_route(trip_id)
    position = store.latest_position(trip_id)
    geometry = (route or {}).get("geometry") if route else None
    distance = distance_to_route_m(position, geometry) if position and geometry else None
    return route, position, distance


def should_recalculate(trip, position, distance, now=None):
    """Is a recalculation justified right now? Returns (bool, reason)."""
    if position is None or distance is None:
        return False, "no_position_or_route"
    if position["quality"] == "poor":
        # A 500 m accuracy circle cannot establish a 150 m deviation.
        return False, "low_accuracy"
    if distance <= deviation_threshold_m():
        return False, "on_route"

    last = store.parse_dt(trip["route_recalculated_at"]) if trip["route_recalculated_at"] else None
    if last is not None:
        now = now or store.utcnow()
        elapsed = (now - last).total_seconds()
        if elapsed < recalc_cooldown_seconds():
            return False, "cooldown"
    return True, "off_route"


def recalculate_route(trip, position):
    """Recompute the route from the vehicle to the destination.

    Returns a dict describing the outcome. A failure keeps the previous route and
    marks it `degraded`; it never replaces a road route with a straight line
    presented as navigable.
    """
    if trip["destination_lat"] is None or trip["destination_lng"] is None:
        return {"recalculated": False, "reason": "no_destination"}

    origin = (position["lat"], position["lng"])
    destination = (trip["destination_lat"], trip["destination_lng"])
    try:
        resolved = routing.resolve_route(origin, destination)
    except routing.RoutingError as error:
        store.mark_route_quality(trip["id"], "degraded")
        store.add_manual_event(
            trip["id"],
            "route",
            f"Route recalculation failed ({error}). The previous route is still shown.",
        )
        return {"recalculated": False, "reason": "provider_failed", "error": str(error)}

    store.save_route(trip["id"], resolved, reason="deviation")
    store.mark_route_quality(trip["id"], "ok")
    store.add_manual_event(
        trip["id"],
        "route",
        "Route recalculated from the vehicle's current position.",
    )
    return {
        "recalculated": True,
        "provider": resolved.get("provider"),
        "distance_m": resolved.get("distance_m"),
    }


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------


def ingest(unit, payload, now=None):
    """Validate and store a telemetry batch for one unit.

    Returns a dict with per-fix outcomes plus the resulting state, so the phone
    can show exactly what the server accepted and the operator's view can be
    reconstructed from the same numbers.
    """
    if not isinstance(payload, dict):
        raise FixRejected("invalid_payload", "The body must be a JSON object.")

    fixes = payload.get("fixes")
    if fixes is None and ("lat" in payload or "lng" in payload):
        fixes = [payload]
    if not isinstance(fixes, list) or not fixes:
        raise FixRejected("invalid_payload", "Send a non-empty `fixes` array.")
    if len(fixes) > MAX_BATCH:
        raise FixRejected("batch_too_large", f"Send at most {MAX_BATCH} fixes per request.")

    trip_id = payload.get("trip_id")
    trip = None
    if trip_id is not None:
        try:
            trip = store.get_trip_for_unit(int(trip_id), unit["id"])
        except (TypeError, ValueError):
            trip = None
        if trip is None:
            raise FixRejected(
                "not_your_response", "That response is not assigned to this unit."
            )
    else:
        open_trips = store.unit_open_trips(unit["id"])
        trip = open_trips[0] if open_trips else None

    if trip is None:
        raise FixRejected("no_active_response", "This unit has no response to report for.")

    session_row = store.emergency_session_for_trip(trip["id"])
    state = session_row["state"] if session_row else lifecycle.state_for_status(trip["status"])
    if not lifecycle.can_track(state):
        raise FixRejected(
            "session_not_trackable",
            f"Location is not accepted while the response is {state.lower()}.",
            index=None,
        )

    now = now or store.utcnow()
    previous = store.latest_position(trip["id"])
    outcomes = []
    accepted = 0
    duplicates = 0
    latest_row = previous

    for index, raw in enumerate(fixes):
        # A retried fix is answered as "already applied" before any ordering
        # check: the work it describes has happened, and calling it stale would
        # make an outbox retry look like a data error.
        retried = store.telemetry_fix_by_client_id(
            (raw.get("client_fix_id") or "").strip() if isinstance(raw, dict) else None
        )
        if retried is not None and retried["trip_id"] == trip["id"]:
            duplicates += 1
            outcomes.append(
                {"index": index, "accepted": True, "duplicate": True, "fix_id": retried["id"]}
            )
            continue

        try:
            fix = parse_fix(raw, now=now)
            if is_impossible_jump(previous, fix):
                raise FixRejected(
                    "impossible_jump",
                    "That position is too far from the previous fix to be real.",
                    index=index,
                )
            if previous is not None and _is_older_than_latest(previous, fix):
                raise FixRejected(
                    "out_of_order",
                    "An older fix cannot replace a newer position.",
                    index=index,
                )
        except FixRejected as rejection:
            rejection.index = index
            outcomes.append(
                {
                    "index": index,
                    "accepted": False,
                    "code": rejection.code,
                    "message": rejection.message,
                }
            )
            continue

        recorded = store.record_telemetry_fix(
            trip_id=trip["id"],
            session_id=session_row["id"] if session_row else None,
            vehicle_id=unit["id"],
            fix=fix,
            quality=quality_label(fix),
        )
        if recorded["duplicate"]:
            duplicates += 1
            outcomes.append(
                {"index": index, "accepted": True, "duplicate": True, "fix_id": recorded["id"]}
            )
            continue

        replaced = store.upsert_latest_position(
            trip_id=trip["id"],
            session_id=session_row["id"] if session_row else None,
            vehicle_id=unit["id"],
            fix=fix,
            quality=quality_label(fix),
            fix_id=recorded["id"],
        )
        accepted += 1
        if replaced:
            latest_row = store.latest_position(trip["id"])
        outcomes.append(
            {
                "index": index,
                "accepted": True,
                "duplicate": False,
                "fix_id": recorded["id"],
                "applied": bool(replaced),
            }
        )

    if accepted:
        # The session is alive: this is the only writer of `last_seen_at`.
        store.touch_session_last_seen(trip["id"], store.iso_now())
        store.prune_telemetry(
            store.stamp(now - timedelta(days=retention_days()))
        )

    trip = store.get_trip(trip["id"])
    result = {
        "trip_id": trip["id"],
        "session_state": state,
        "accepted": accepted,
        "duplicates": duplicates,
        # Duplicates were already stored, so they are not rejections.
        "rejected": len(fixes) - accepted - duplicates,
        "outcomes": outcomes,
        "latest": None,
        "route": None,
    }

    if latest_row is not None:
        result["latest"] = {
            "lat": latest_row["lat"],
            "lng": latest_row["lng"],
            "accuracy_m": latest_row["accuracy_m"],
            "heading_deg": latest_row["heading_deg"],
            "speed_mps": latest_row["speed_mps"],
            "device_time": latest_row["device_time"],
            "received_at": latest_row["received_at"],
            "quality": latest_row["quality"],
        }
        result["health"] = health(latest_row, state, now=now)

        route, _, deviation = route_state(trip["id"])
        recalc, reason = should_recalculate(trip, latest_row, deviation, now=now)
        if recalc:
            outcome = recalculate_route(trip, latest_row)
            if outcome.get("recalculated"):
                store.mark_route_deviation(trip["id"], deviation)
            trip = store.get_trip(trip["id"])
            route = store.active_route(trip["id"])
            result["recalculation"] = outcome
        else:
            result["recalculation"] = {"recalculated": False, "reason": reason}

        result["route"] = {
            "provider": (route or {}).get("provider"),
            "quality": trip["route_quality"] or ("ok" if route else "none"),
            "deviation_m": deviation,
            "recalculated_at": trip["route_recalculated_at"],
        }
    else:
        result["health"] = health(None, state, now=now)

    return result


def status_for_unit(unit):
    """What the phone shows: am I tracked, and how fresh is the server's copy?"""
    open_trips = store.unit_open_trips(unit["id"])
    if not open_trips:
        return {
            "tracking": False,
            "reason": "no_active_response",
            "session_state": None,
            "health": health(None),
        }

    trip = open_trips[0]
    session_row = store.emergency_session_for_trip(trip["id"])
    state = session_row["state"] if session_row else lifecycle.state_for_status(trip["status"])
    position = store.latest_position(trip["id"])
    return {
        "tracking": lifecycle.can_track(state),
        "reason": "ok" if lifecycle.can_track(state) else "session_not_trackable",
        "trip_id": trip["id"],
        "session_state": state,
        "health": health(position, state),
        "retention_days": retention_days(),
    }
