"""The crew phone's API.

Contract note: these endpoints are shaped for the mobile client that already
exists (`src/api.ts`, `parseTrip`). Field names and the action vocabulary are
the phone's, not the admin templates', so nothing has to be rewritten on the
device to start using a real backend.

Authentication: `Authorization: Bearer <unit code>`. A code is a random secret
issued per vehicle from the Resources screen (`unit_tokens.issue`), stored only
as a SHA-256 digest and rotatable or revocable at any time. A code maps to one
vehicle, and a vehicle only ever sees its own responses.

Development fleets whose phones still type a call sign can set
`GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS=1`, which additionally accepts the old
`token-<call sign slug>` form. It is off by default.

Telemetry ingestion is rate limited per unit (`ratelimit`), because a credential
is shared by a crew and travels over the open internet.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

import db as store
import lifecycle
import ratelimit
import telemetry
import unit_tokens

driver_api = Blueprint("driver_api", __name__, url_prefix="/api/driver")

#: The phone's action name for each target status.
ACTION_FOR_STATUS = {
    "accepted": "accept",
    "in_transit": "depart",
    "on_scene": "arrive",
    "completed": "complete",
}

NOTE_LIMIT = 500


def _error(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status


def _token_unit():
    """Resolve the bearer credential to a vehicle row, or None.

    The digest lookup is the whole check: a revoked unit has no digest, a rotated
    unit only has the new one, and a vehicle that leaves the registry stops
    authenticating because its row is gone.
    """
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    return unit_tokens.resolve(header[7:].strip())


def _require_unit():
    unit = _token_unit()
    if unit is None:
        return None, _error("Unknown unit code.", 401)
    return unit, None


def _driver_payload(row, *, with_timeline=True):
    """The phone's projection of a trip.

    `serialise_trip` already carries status_label, priority_label and the stored
    route; this adds the two fields only the phone needs: its timeline and the
    actions it may offer, derived from one shared table so the client and server
    cannot disagree about what is legal.
    """
    payload = store.serialise_trip(row)
    if payload is None:
        return None
    if with_timeline:
        payload["timeline"] = store.timeline_for(row["id"])
    payload["next_actions"] = store.DRIVER_NEXT_ACTIONS.get(row["status"], [])
    payload.pop("url", None)
    return payload


def _parse_coordinates(value):
    """Accept [lat, lng] or {"lat":…, "lng":…}; reject anything else."""
    if isinstance(value, dict):
        value = [value.get("lat"), value.get("lng")]
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        lat, lng = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    if lat == 0 and lng == 0:
        return None
    return (lat, lng)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@driver_api.get("/unit")
def unit():
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    trips = store.unit_open_trips(unit_row["id"])
    assignment = _driver_payload(trips[0]) if trips else None
    # `queue_count` and `server_time` are part of the phone's contract
    # (`parseUnit` rejects a body without them), so they are always sent.
    return jsonify(
        {
            "call_sign": unit_row["call_sign"],
            "vehicle_type": unit_row["vehicle_type"],
            "assignment": assignment,
            "queue_count": len(trips),
            "server_time": store.iso_now(),
        }
    )


@driver_api.get("/assignments")
def assignments():
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    rows = store.unit_open_trips(unit_row["id"])
    payloads = [_driver_payload(row) for row in rows]
    return jsonify({"assignments": payloads, "count": len(payloads)})


@driver_api.get("/trips/<int:trip_id>")
def trip(trip_id):
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    row = store.get_trip_for_unit(trip_id, unit_row["id"])
    if row is None:
        return _error("That response is not assigned to this unit.", 404)
    return jsonify({"trip": _driver_payload(row)})


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


@driver_api.post("/trips/<int:trip_id>/transition")
def transition(trip_id):
    """Advance a response one step, idempotently.

    The phone retries aggressively (its outbox drains on a backoff), so the same
    `client_event_id` must never apply twice, and a stale `expected_status` must
    be reported as a conflict rather than silently overwritten.
    """
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    row = store.get_trip_for_unit(trip_id, unit_row["id"])
    if row is None:
        return _error("That response is not assigned to this unit.", 404)

    body = request.get_json(silent=True) or {}
    target = body.get("to")
    expected = body.get("expected_status")
    client_event_id = body.get("client_event_id")
    client_at = body.get("client_at")

    if not isinstance(client_event_id, str) or not client_event_id.strip():
        return _error("client_event_id is required.", 422)

    seen = store.client_event_seen(client_event_id)
    if seen is not None:
        current = store.get_trip_for_unit(trip_id, unit_row["id"])
        return jsonify({"trip": _driver_payload(current), "replayed": True})

    action = ACTION_FOR_STATUS.get(str(target))
    if action is None:
        return _error("Unsupported transition.", 422, allowed=list(ACTION_FOR_STATUS))

    if expected is not None and row["status"] != expected:
        return _error(
            "That response moved on before this update arrived.",
            409,
            current_status=row["status"],
            trip=_driver_payload(row),
        )

    if action not in store.DRIVER_NEXT_ACTIONS.get(row["status"], []):
        return _error(
            "That action is not available from the current status.",
            409,
            current_status=row["status"],
            trip=_driver_payload(row),
        )

    try:
        store.update_status(
            trip_id,
            action,
            actor_kind="unit",
            actor_id=unit_row["id"],
            actor_role="UNIT",
        )
    except ValueError as error:
        return _error(str(error), 409, current_status=row["status"])

    store.record_client_event(client_event_id, trip_id, action, target)

    if isinstance(client_at, str) and client_at.strip():
        store.note_client_time(trip_id, action, client_at.strip())

    current = store.get_trip_for_unit(trip_id, unit_row["id"])
    return jsonify({"trip": _driver_payload(current), "replayed": False})


@driver_api.post("/trips/<int:trip_id>/issue")
def issue(trip_id):
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    row = store.get_trip_for_unit(trip_id, unit_row["id"])
    if row is None:
        return _error("That response is not assigned to this unit.", 404)

    body = request.get_json(silent=True) or {}
    category = str(body.get("category") or "issue").strip()[:64]
    note = str(body.get("note") or "").strip()[:NOTE_LIMIT]

    store.add_manual_event(
        trip_id,
        "issue",
        f"Issue reported by crew ({category}): {note or 'no note'}",
    )
    current = store.get_trip_for_unit(trip_id, unit_row["id"])
    return jsonify({"trip": _driver_payload(current)})


@driver_api.post("/trips/<int:trip_id>/backup")
def backup(trip_id):
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    row = store.get_trip_for_unit(trip_id, unit_row["id"])
    if row is None:
        return _error("That response is not assigned to this unit.", 404)

    body = request.get_json(silent=True) or {}
    reason = str(body.get("reason") or body.get("note") or "").strip()[:NOTE_LIMIT]

    store.add_manual_event(
        trip_id,
        "backup",
        f"Backup requested by crew: {reason or 'no reason given'}",
    )
    current = store.get_trip_for_unit(trip_id, unit_row["id"])
    return jsonify({"trip": _driver_payload(current)})


# ---------------------------------------------------------------------------
# Telemetry (Phase C)
#
# Identity comes from the bearer token, never from the body. `trip_id` is
# optional: without it the unit's own open response is used.
# ---------------------------------------------------------------------------

#: Rejection code -> HTTP status, chosen so the phone can decide what to do.
_TELEMETRY_STATUS = {
    "not_your_response": 404,
    "no_active_response": 409,
    "session_not_trackable": 409,
    "batch_too_large": 413,
    "invalid_payload": 400,
    "invalid_fix": 422,
    "invalid_coordinates": 422,
    "accuracy_out_of_range": 422,
    "future_timestamp": 422,
    "stale_timestamp": 422,
    "missing_field": 422,
    "invalid_field": 422,
}


@driver_api.post("/telemetry")
def telemetry_upload():
    """Accept a batch of GPS fixes for this unit's active response.

    Idempotent: a retried `client_fix_id` is answered as a duplicate, not stored
    twice. A batch may mix accepted and rejected fixes; each gets its own outcome
    so the phone can drop exactly what the server refused.
    """
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure

    # Read raw request body – Flask respects MAX_CONTENT_LENGTH if set
    raw_body = request.get_data()
    # Enforce byte‑size limit before consuming quota
    if len(raw_body) > telemetry.MAX_BATCH_BYTES:
        return _error(
            f"Payload exceeds {telemetry.MAX_BATCH_BYTES} bytes",
            413,
            error_code="batch_too_large",
        )
    payload = request.get_json(silent=True)
    if payload is None:
        return _error("Send a JSON body.", 400, error_code="invalid_payload")
    # Payload must be a JSON object (dict)
    if not isinstance(payload, dict):
        return _error("Payload must be a JSON object.", 400, error_code="invalid_payload")
    # Payload must contain a 'fixes' list
    fixes = payload.get("fixes")
    if not isinstance(fixes, list):
        return _error("Payload must contain a 'fixes' list.", 400, error_code="invalid_payload")
    batch_size = len(fixes)
    # Enforce batch‑size limit before consuming quota
    if batch_size > telemetry.MAX_BATCH:
        return _error(
            f"Batch exceeds {telemetry.MAX_BATCH} fixes",
            413,
            error_code="batch_too_large",
        )
    wait = ratelimit.retry_after_seconds(unit_row["id"], batch_size)
    if wait:
        retry_seconds = int(wait)
        limited = jsonify(
            {
                "error": "Too many position updates for this unit. Retry shortly.",
                "error_code": "rate_limited",
                "retry_after_seconds": retry_seconds,
            }
        )
        limited.headers["Retry-After"] = str(retry_seconds)
        return limited, 429

    try:
        result = telemetry.ingest(unit_row, payload)
    except telemetry.FixRejected as rejection:
        status = _TELEMETRY_STATUS.get(rejection.code, 422)
        return _error(rejection.message, status, error_code=rejection.code)

    # A batch where nothing survived is an error response, not a success with a
    # list of regrets: the phone needs one status to decide whether to retry.
    if result["accepted"] == 0 and result["duplicates"] == 0:
        first = next((o for o in result["outcomes"] if not o.get("accepted")), None)
        if first is not None:
            return (
                jsonify(
                    {
                        "error": first["message"],
                        "error_code": first["code"],
                        "telemetry": result,
                    }
                ),
                422,
            )

    return jsonify({"telemetry": result}), 200


@driver_api.get("/telemetry")
def telemetry_status():
    """What the phone's location badge shows: am I tracked, how fresh is it?"""
    unit_row, failure = _require_unit()
    if failure is not None:
        return failure
    return jsonify({"telemetry": telemetry.status_for_unit(unit_row)})
