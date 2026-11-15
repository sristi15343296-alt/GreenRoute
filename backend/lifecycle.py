"""The emergency lifecycle — one server-authoritative state machine.

Phase B introduces a formal vocabulary on top of the six trip statuses the
application already had. The two are the *same* lifecycle seen from two angles,
and this module is the only place that knows both:

    emergency state      trips.status      meaning
    ----------------     ------------      -----------------------------------
    CREATED              scheduled         response recorded, no crew has taken it
    VERIFIED             accepted          an authorised person confirmed it and a
                                           unit owns it
    ACTIVE               in_transit        unit is moving; future telemetry and
                                           proximity alerts are permitted
    ON_SCENE             on_scene          unit is at the incident
    COMPLETED            completed         closed successfully
    CANCELLED            cancelled         closed deliberately, with a reason
    EXPIRED              cancelled         watchdog closure (stale activation)

`trips.status` stays the single authoritative column: every reader already
depends on it, the driver API filters on it, and Phase A's indexes are built on
it. `emergency_sessions` stores the session facts that are not trip facts
(who activated it, when it expires, why it ended) plus a materialised `state`
projection for Phase C queries. Both are written in **one transaction** by
`db.update_status`, so they can never disagree: there is one writer, not two.

APPROACHING is deliberately *not* a state. It is a derived operational
condition (`derive_condition`) computed from position: always true or false for
the current moment, never something a client transitions into, and never
persisted. Adding it as a state would create a seventh value every client would
have to handle in order to say nothing new.

Compatibility: this module adds behaviour and never renames a trip action. The
driver API keeps calling the same database function with the same action names,
and receives the same statuses back.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import admin_store
import db as store

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

CREATED = "CREATED"
VERIFIED = "VERIFIED"
ACTIVE = "ACTIVE"
ON_SCENE = "ON_SCENE"
COMPLETED = "COMPLETED"
CANCELLED = "CANCELLED"
EXPIRED = "EXPIRED"

STATES = [CREATED, VERIFIED, ACTIVE, ON_SCENE, COMPLETED, CANCELLED, EXPIRED]

STATE_LABELS = {
    CREATED: "Created",
    VERIFIED: "Verified",
    ACTIVE: "Active",
    ON_SCENE: "On scene",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired",
}

#: States from which a session is still running. Phase C may write telemetry
#: only in ACTIVE; Phase D may raise alerts only in ACTIVE (and may keep an
#: existing alert until it expires while ON_SCENE).
OPEN_STATES = {CREATED, VERIFIED, ACTIVE, ON_SCENE}
LIVE_STATES = {ACTIVE}
CLOSED_STATES = {COMPLETED, CANCELLED, EXPIRED}

TRIP_STATUS_FOR_STATE = {
    CREATED: "scheduled",
    VERIFIED: "accepted",
    ACTIVE: "in_transit",
    ON_SCENE: "on_scene",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    EXPIRED: "cancelled",
}

STATE_FOR_TRIP_STATUS = {
    "scheduled": CREATED,
    "accepted": VERIFIED,
    "in_transit": ACTIVE,
    "on_scene": ON_SCENE,
    "completed": COMPLETED,
    "cancelled": CANCELLED,
}

#: How long a cancelled or completed session keeps emitting nothing. Phase D
#: reads this to expire outstanding proximity alerts.
ALERT_GRACE_SECONDS = 120


def state_for_status(status: str) -> str:
    return STATE_FOR_TRIP_STATUS.get(status, CREATED)


# ---------------------------------------------------------------------------
# Transition table
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Transition:
    action: str
    sources: frozenset
    target: str
    trip_action: str
    permission: str | None
    actor_kinds: frozenset
    summary: str


def _t(action, sources, target, trip_action, permission, actor_kinds, summary):
    return Transition(
        action=action,
        sources=frozenset(sources),
        target=target,
        trip_action=trip_action,
        permission=permission,
        actor_kinds=frozenset(actor_kinds),
        summary=summary,
    )


_OPERATORS = {"admin"}
_UNIT = {"unit"}
_SYSTEM = {"system"}
_EITHER = {"admin", "unit"}

TRANSITIONS = {
    # Verification is the deliberate second pair of eyes: a response must be
    # confirmed by an administrator or operator before a crew can be committed.
    "verify": _t(
        "verify",
        {CREATED},
        VERIFIED,
        "accept",
        "trips.dispatch",
        _OPERATORS,
        "Confirm the response and place it with its assigned unit.",
    ),
    # Operator dispatch override: CREATED -> ACTIVE directly, for a response
    # that is already rolling when it is recorded. Kept from Phase A because
    # the admin UI's existing "Mark en route" button uses it.
    "activate": _t(
        "activate",
        {CREATED},
        ACTIVE,
        "start",
        "trips.dispatch",
        _OPERATORS,
        "Dispatch a verified-in-the-field response straight to ACTIVE.",
    ),
    "depart": _t(
        "depart",
        {VERIFIED},
        ACTIVE,
        "depart",
        "trips.dispatch",
        _EITHER,
        "The unit leaves for the incident. This is the activation event.",
    ),
    "arrive": _t(
        "arrive",
        {ACTIVE},
        ON_SCENE,
        "arrive",
        "trips.dispatch",
        _EITHER,
        "The unit reaches the incident.",
    ),
    "complete": _t(
        "complete",
        {ACTIVE, ON_SCENE},
        COMPLETED,
        "complete",
        "trips.dispatch",
        _EITHER,
        "Close the response successfully.",
    ),
    "cancel": _t(
        "cancel",
        {CREATED, VERIFIED, ACTIVE, ON_SCENE},
        CANCELLED,
        "cancel",
        "trips.cancel",
        {"admin", "unit", "system"},
        "Close the response deliberately. A reason is required.",
    ),
    "expire": _t(
        "expire",
        {ACTIVE},
        EXPIRED,
        "cancel",
        "trips.cancel",
        _SYSTEM,
        "Watchdog closure: an active session stopped reporting.",
    ),
}

#: Actions an administrator may request through the API, in UI order.
ADMIN_ACTIONS = ["verify", "activate", "depart", "arrive", "complete", "cancel"]

#: Terminal states never transition: a completed response is reopened by
#: creating a new one, and a cancelled one cannot be revived by an old request.
TERMINAL_STATES = CLOSED_STATES


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class LifecycleError(Exception):
    code = "lifecycle_error"
    status = 409

    def __init__(self, message, **extra):
        super().__init__(message)
        self.message = message
        self.extra = extra


class NotFound(LifecycleError):
    code = "not_found"
    status = 404


class InvalidTransition(LifecycleError):
    code = "invalid_transition"
    status = 409


class PermissionDenied(LifecycleError):
    code = "permission_denied"
    status = 403


class Conflict(LifecycleError):
    code = "conflict"
    status = 409


class ReasonRequired(LifecycleError):
    code = "reason_required"
    status = 422


# ---------------------------------------------------------------------------
# Applying a transition
# ---------------------------------------------------------------------------


def available_actions(session_state: str, actor=None) -> list[str]:
    """The transitions this actor could legally request right now."""
    actions = []
    for name, transition in TRANSITIONS.items():
        if name == "expire":
            continue
        if session_state not in transition.sources:
            continue
        if actor is not None:
            kind = "admin" if getattr(actor, "role", None) else "unit"
            if kind not in transition.actor_kinds:
                continue
            if transition.permission and not actor.can(transition.permission):
                continue
        actions.append(name)
    return actions


def apply(
    trip_id: int,
    action: str,
    actor,
    *,
    expected_state: str | None = None,
    reason: str | None = None,
    client_event_id: str | None = None,
):
    """Validate and apply one lifecycle action. Returns the updated trip row.

    `actor` may be an `auth.Actor` (administrator) or a dict
    `{"kind": "unit", "unit": vehicle_row}`.
    """
    transition = TRANSITIONS.get(action)
    if transition is None:
        raise InvalidTransition(f"{action!r} is not a lifecycle action.")

    trip = store.get_trip(trip_id)
    if trip is None:
        raise NotFound("Response not found.")

    session_row = store.emergency_session_for_trip(trip_id)
    current_state = (
        session_row["state"] if session_row else state_for_status(trip["status"])
    )

    # The trip column is authoritative; if a legacy row drifted from its session
    # projection, repair the projection instead of refusing the action.
    projected = state_for_status(trip["status"])
    if projected != current_state:
        store.sync_emergency_session(trip_id, trip["status"], action="resync")
        current_state = projected

    # A replayed request is answered before any validation: the work it asks for
    # has already happened, so "that is not valid now" would be misleading.
    if client_event_id and store.client_event_seen(client_event_id):
        return store.get_trip(trip_id)

    if expected_state and expected_state != current_state:
        raise Conflict(
            "Someone else changed this response first.",
            current_state=current_state,
            expected_state=expected_state,
        )

    kind, actor_id, actor_role = _describe_actor(actor)
    if kind not in transition.actor_kinds:
        raise PermissionDenied(
            "That action is not available to this kind of client.",
            allowed=sorted(transition.actor_kinds),
        )

    if transition.permission and kind == "admin":
        if not actor.can(transition.permission):
            raise PermissionDenied(
                "Your role is not allowed to perform this action.",
                required_permission=transition.permission,
            )

    if current_state not in transition.sources:
        raise InvalidTransition(
            f"A {STATE_LABELS.get(current_state, current_state).lower()} response cannot be "
            f"moved with “{action}”.",
            current_state=current_state,
            allowed=sorted(transition.sources),
        )

    if action in {"cancel", "expire"} and not (reason or "").strip():
        if action == "cancel":
            raise ReasonRequired("Give a reason for cancelling this response.")
        reason = "No telemetry received from the unit."

    try:
        row = store.update_status(
            trip_id,
            transition.trip_action,
            expected_status=trip["status"],
            actor_kind=kind,
            actor_id=actor_id,
            actor_role=actor_role,
            reason=(reason or None),
            lifecycle_action=action,
        )
    except store.StaleTransition as error:
        raise Conflict(
            "Someone else changed this response first.",
            current_state=state_for_status(error.current_status),
        ) from error

    if client_event_id:
        store.record_client_event(
            client_event_id, trip_id, transition.trip_action, row["status"]
        )

    admin_store.audit_record(
        actor_id=actor_id if kind == "admin" else None,
        actor_role=actor_role,
        action=f"emergency.{action}",
        outcome="success",
        trip_id=trip_id,
        session_id=session_row["id"] if session_row else None,
        detail={
            "from": current_state,
            "to": transition.target,
            "reason": (reason or None),
            "actor_kind": kind,
        },
    )
    return row


def _describe_actor(actor):
    if actor is None:
        return "system", None, "SYSTEM"
    if isinstance(actor, dict):
        kind = actor.get("kind", "unit")
        if kind == "unit":
            unit = actor.get("unit") or {}
            return "unit", str(unit.get("id") or unit.get("call_sign") or ""), "UNIT"
        return kind, str(actor.get("id", "")), actor.get("role", "")
    # auth.Actor
    return "admin", str(actor.id), actor.role


# ---------------------------------------------------------------------------
# Derived conditions and the expiry watchdog
# ---------------------------------------------------------------------------

APPROACH_RADIUS_M = 800
EXPIRY_IDLE_SECONDS = 120


def derive_condition(trip, session_row=None, last_fix=None) -> str:
    """The operational label for the session right now.

    Returns one of `CREATED`, `VERIFIED`, `ACTIVE`, `APPROACHING`, `ON_SCENE`,
    `COMPLETED`, `CANCELLED`, `EXPIRED`. `APPROACHING` is only ever returned
    here: it is a function of position, not a stored state.
    """
    state = (
        session_row["state"]
        if session_row is not None
        else state_for_status(trip["status"])
    )
    if state != ACTIVE:
        return state
    if last_fix is None:
        return ACTIVE

    destination = None
    if trip["destination_lat"] is not None and trip["destination_lng"] is not None:
        destination = (trip["destination_lat"], trip["destination_lng"])
    if destination is None:
        return ACTIVE

    import geocoding

    distance_m = geocoding.haversine_km(
        (last_fix["lat"], last_fix["lng"]), destination
    ) * 1000
    return "APPROACHING" if distance_m < APPROACH_RADIUS_M else ACTIVE


def stale_sessions(now: datetime | None = None):
    """ACTIVE sessions whose unit has not reported inside the health window.

    Phase C note: this is a **telemetry health** query, not a lifecycle trigger.
    Phase B used it to cancel responses after 120 s of silence, which would have
    ended a genuine emergency because a phone lost signal in a tunnel. The state
    is now left alone and the operator is told the position is stale; see
    `telemetry_warnings()` and `expire_overtime()`.
    """
    now = now or store.utcnow()
    cutoff = store.stamp(now - timedelta(seconds=EXPIRY_IDLE_SECONDS))
    return store.active_sessions_last_seen_before(cutoff)


def telemetry_warnings(now: datetime | None = None):
    """Active sessions whose telemetry is stale or lost. Never changes state."""
    now = now or store.utcnow()
    warnings = []
    # `since=-1` keeps sessions that have not reported a single fix yet: a unit
    # that went en route and never got a GPS fix is exactly what an operator
    # needs to be told about.
    for row in store.live_positions(-1):
        received = row["received_at"]
        if received is None:
            age = None
            status = "UNKNOWN"
            # A unit that has just gone en route is allowed a minute to get its
            # first fix; warning about it immediately would train operators to
            # ignore the strip.
            activated = row["activated_at"]
            if activated is not None:
                elapsed = (now - store.parse_dt(activated)).total_seconds()
                if elapsed < NO_TELEMETRY_GRACE_SECONDS:
                    continue
        else:
            age = max(0, int((now - store.parse_dt(received)).total_seconds()))
            if age <= 15:
                status = "LIVE"
            elif age <= 45:
                status = "DELAYED"
            elif age <= 120:
                status = "STALE"
            else:
                status = "LOST"
        if status in {"STALE", "LOST", "UNKNOWN"}:
            warnings.append(
                {
                    "trip_id": row["trip_id"],
                    "reference": row["reference"],
                    "call_sign": row["call_sign"],
                    "status": status,
                    "age_seconds": age,
                    "session_state": row["session_state"],
                }
            )
    return warnings


#: Grace before a unit that has never reported is warned about.
NO_TELEMETRY_GRACE_SECONDS = 60

#: Hard ceiling on one activation. This is the *only* automatic closure Phase C
#: performs, and it is about the response record, not about GPS: twelve hours is
#: long past any single response, and leaving it open forever would let a
#: forgotten session keep occupying a unit.
MAX_ACTIVE_HOURS = 12


def expire_overtime(now: datetime | None = None) -> list[int]:
    """Close ACTIVE sessions that exceeded the maximum activation window.

    Deliberately *not* driven by telemetry. A vehicle whose phone died is still
    on an emergency; an operator decides that, using the STALE/LOST warnings.
    """
    now = now or store.utcnow()
    cutoff = store.stamp(now - timedelta(hours=MAX_ACTIVE_HOURS))
    expired = []
    for row in store.active_sessions_last_seen_before(cutoff):
        # `last_seen_at` is the last activation or telemetry contact; if it is
        # older than the ceiling the session has simply been open too long.
        if row["activated_at"] is None:
            continue
        if store.parse_dt(row["activated_at"]) > store.parse_dt(cutoff):
            continue
        try:
            apply(
                row["trip_id"],
                "expire",
                None,
                reason="Maximum activation window exceeded.",
            )
            expired.append(row["trip_id"])
        except LifecycleError:
            continue
    return expired


def expire_stale(now: datetime | None = None) -> list[int]:
    """Deprecated alias retained for callers of the Phase B endpoint.

    It no longer expires anything because of missing GPS. It only applies the
    twelve-hour ceiling. New code should call `telemetry_warnings()` for health
    and `expire_overtime()` for closure.
    """
    return expire_overtime(now)


def can_track(session_state: str) -> bool:
    """Phase C: may telemetry be accepted for this session?"""
    return session_state in LIVE_STATES


def can_alert(session_state: str) -> bool:
    """Phase D: may proximity alerts be generated for this session?"""
    return session_state in LIVE_STATES
