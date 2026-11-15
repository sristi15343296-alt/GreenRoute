"""GreenRoute fleet operations workspace.

All screens share one design system and one persisted dataset:
    /                     Operations overview
    /fleet-map            Recorded fleet map
    /trips                Response register
    /resources            Vehicle and personnel registry
    /trips/new            Create emergency response
    /trips/<id>           Response details
    /analytics            Analytics & reports
    /settings             Workspace settings
"""

import csv
import io
import json
import os
import math
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import (
    Flask,
    Response,
    abort,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)

import admin_store
import auth
import config
import db as store
import geocoding
import lifecycle
import telemetry
import unit_tokens
import ratelimit
from blueprints.admin_auth import admin_auth
from blueprints.admin_users import admin_users
from blueprints.driver_api import driver_api
from blueprints.route_api import route_api

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Resolved before anything else: in production a missing or public SECRET_KEY
# raises here, so the process never serves a forgeable session cookie.
SECRET_KEY, USES_DEVELOPMENT_SECRET = config.resolve_secret_key()

app = Flask(__name__)
app.config.update(
    DATABASE=os.environ.get(
        "GREENROUTE_DB", os.path.join(app.instance_path, "greenroute.sqlite")
    ),
    SECRET_KEY=SECRET_KEY,
    ENVIRONMENT=config.environment(),
    USES_DEVELOPMENT_SECRET=USES_DEVELOPMENT_SECRET,
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

# Validate telemetry burst capacity
if ratelimit.capacity() < telemetry.MAX_BATCH:
    raise config.ConfigurationError(
        f"GREENROUTE_TELEMETRY_BURST ({ratelimit.capacity()}) must be >= telemetry.MAX_BATCH ({telemetry.MAX_BATCH})"
    )
# Disallow legacy token acceptance in production
if config.is_production() and unit_tokens.legacy_allowed():
    raise config.ConfigurationError(
        "Legacy driver token acceptance must be disabled in production."
    )

app.jinja_env.auto_reload = True

store.init_app(app)

with app.app_context():
    store.init_db()

# Unit credentials: every vehicle without one is issued a random code and its
# plaintext is written to instance/unit-tokens.txt for the operator to hand out.
# Existing codes are never rotated by this.
with app.app_context():
    _issued_unit_tokens = unit_tokens.backfill(app.instance_path)
if _issued_unit_tokens:
    print(
        f"unit credentials issued for {len(_issued_unit_tokens)} vehicle(s); "
        "see instance/unit-tokens.txt",
        flush=True,
    )

# The crew phone and the route resolver live on the same database as the admin
# screens. Registered as blueprints so their URLs cannot collide with a screen.
app.register_blueprint(driver_api)
app.register_blueprint(route_api)
app.register_blueprint(admin_auth)
app.register_blueprint(admin_users)

# A workspace with no administrators cannot be administered at all, so the first
# one is created on boot. With no environment variables set, the password is
# generated and written to instance/first-admin.txt (never to a log).
with app.app_context():
    auth.bootstrap_admin(app.instance_path)


# ---------------------------------------------------------------------------
# Access control
#
# Every administrative endpoint names the permission it needs. The map lives
# here, in one place, so a reviewer can audit the whole surface at once and a
# new route is a deliberate addition rather than an accidental gap. The driver
# API and the sign-in routes are the only public endpoints; everything else
# requires an authenticated account.
# ---------------------------------------------------------------------------

PUBLIC_ENDPOINTS = {
    "static",
    "admin_auth.login",
    "admin_auth.logout",
    "admin_auth.session_info",
    "not_found",
    "server_error",
}

#: Blueprints that authenticate by bearer token (crew phone) and therefore do not
#: participate in cookie sessions or CSRF.
TOKEN_BLUEPRINTS = {"driver_api"}

ENDPOINT_PERMISSIONS = {
    # Screens
    "dashboard": "dashboard.view",
    "fleet_map": "trips.view",
    "trips": "trips.view",
    "trip_detail": "trips.view",
    "resources": "resources.view",
    "analytics": "analytics.view",
    "settings": "settings.view",
    # Response creation and lifecycle
    "create_response": "trips.create",
    "api_create_trip": "trips.create",
    "api_update_trip": "trips.dispatch",
    "api_bulk_trips": "trips.dispatch",
    "api_trip_location": "trips.dispatch",
    "api_trip_geocode": "trips.dispatch",
    "api_maintenance_expire": "trips.dispatch",
    # Phase C live monitoring: operational read, same permission as the map.
    "api_live_positions": "trips.view",
    "api_live_track": "trips.view",
    # Reads
    "api_trips": "trips.view",
    "api_trip": "trips.view",
    "api_resource_availability": "trips.view",
    "api_geocode": "trips.dispatch",
    "api_location_suggest": "trips.dispatch",
    # Registry
    "create_resource_vehicle": "resources.manage",
    "update_resource_vehicle": "resources.manage",
    "issue_resource_vehicle_token": "resources.manage",
    "revoke_resource_vehicle_token": "resources.manage",
    "create_resource_personnel": "resources.manage",
    "update_resource_personnel": "resources.manage",
    # Exports
    "export_trips": "trips.export",
    "export_trip": "trips.export",
    "export_analytics": "trips.export",
    "export_analytics_json": "trips.export",
    # Workspace settings
    "reset_settings": "settings.manage",
    # Routing (Phase A endpoint, now administrative)
    "route_api.resolve": "route.resolve",
    "route_api.active": "route.resolve",
    # Administrator management
    "admin_users.administrators": "admins.manage",
    "admin_users.create_administrator": "admins.manage",
    "admin_users.change_role": "admins.manage",
    "admin_users.change_status": "admins.manage",
    "admin_users.reset_password": "admins.manage",
    "admin_users.audit_log": "audit.view",
}

#: Routes where a mutating request is allowed without a session cookie: sign-in,
#: sign-out (checked inside the view) and the bearer-token driver API.
CSRF_EXEMPT_ENDPOINTS = {"admin_auth.login", "admin_auth.logout"}


def _required_permission(endpoint: str, method: str):
    if endpoint == "settings" and method == "POST":
        return "settings.manage"
    return ENDPOINT_PERMISSIONS.get(endpoint)


@app.before_request
def enforce_admin_access():
    """Authenticate and authorise every administrative request in one place.

    Backend enforcement is what protects the workspace: hiding a button is a
    usability decision, never a security one.
    """
    endpoint = request.endpoint or ""
    if request.method == "OPTIONS":
        return None
    if endpoint in PUBLIC_ENDPOINTS or endpoint == "static":
        return None

    blueprint = endpoint.split(".", 1)[0] if "." in endpoint else ""
    if blueprint in TOKEN_BLUEPRINTS:
        return None

    # A browser request that is not signed in is sent to the sign-in page; any
    # JSON/API caller receives 401 so the client can react without HTML.
    actor = auth.current_actor()
    if actor is None:
        return auth.unauthorized_response()

    permission = _required_permission(endpoint, request.method)
    if permission and not actor.can(permission):
        admin_store.audit_record(
            actor_id=actor.id,
            actor_role=actor.role,
            action="authorization.denied",
            outcome="denied",
            detail={"permission": permission, "path": request.path},
            ip=request.remote_addr or "unknown",
        )
        return auth.forbidden_response(permission)

    if (
        request.method in auth.MUTATING_METHODS
        and endpoint not in CSRF_EXEMPT_ENDPOINTS
        and not auth.csrf_ok(actor)
    ):
        if auth.wants_json():
            return (
                jsonify(
                    {
                        "error": "This form expired. Reload the page and try again.",
                        "code": "csrf_failed",
                    }
                ),
                400,
            )
        return ("This form expired. Reload the page and try again.", 400)
    return None


# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------

KM_TO_MILES = 0.621371

TIMEZONES = [
    ("UTC", "UTC"),
    ("Europe/London", "London (GMT/BST)"),
    ("Europe/Berlin", "Berlin (CET/CEST)"),
    ("Europe/Paris", "Paris (CET/CEST)"),
    ("Europe/Madrid", "Madrid (CET/CEST)"),
    ("Europe/Warsaw", "Warsaw (CET/CEST)"),
    ("America/New_York", "New York (ET)"),
    ("America/Chicago", "Chicago (CT)"),
    ("America/Denver", "Denver (MT)"),
    ("America/Los_Angeles", "Los Angeles (PT)"),
    ("Africa/Johannesburg", "Johannesburg (SAST)"),
    ("Asia/Kolkata", "Kolkata (IST)"),
    ("Asia/Singapore", "Singapore (SGT)"),
    ("Australia/Sydney", "Sydney (AET)"),
]

REFRESH_OPTIONS = [("0", "Manual refresh only"), ("30", "Every 30 seconds"), ("60", "Every minute"), ("120", "Every 2 minutes")]


def _settings():
    # `store.save_settings()` clears this cache, so a write followed by a render
    # in the same request shows the new values rather than the old ones.
    if not getattr(g, "settings", None):
        g.settings = store.get_settings()
    return g.settings


def _zone():
    if "zone" not in g:
        try:
            g.zone = ZoneInfo(_settings().get("timezone", "UTC"))
        except (ZoneInfoNotFoundError, ValueError):
            g.zone = timezone.utc
    return g.zone


def _initials(name):
    parts = [part for part in (name or "").split() if part]
    if not parts:
        return "GR"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _unit():
    return _settings().get("distance_unit", "km")


def distance_value(value):
    if value is None:
        return None
    number = float(value)
    if _unit() == "mi":
        number *= KM_TO_MILES
    return number


@app.template_filter("localdt")
def localdt(value, fmt="%d %b %Y · %H:%M"):
    parsed = store.parse_dt(value)
    if parsed is None:
        return "—"
    return parsed.astimezone(_zone()).strftime(fmt)


@app.template_filter("localtime")
def localtime(value, fmt="%H:%M"):
    return localdt(value, fmt)


@app.template_filter("localdate")
def localdate(value, fmt="%d %b %Y"):
    return localdt(value, fmt)


@app.template_filter("number")
def number(value, digits=0):
    if value is None:
        return "—"
    return f"{float(value):,.{digits}f}"


@app.template_filter("distance")
def distance_filter(value, digits=1):
    converted = distance_value(value)
    if converted is None:
        return "—"
    return f"{converted:,.{digits}f} {_unit()}"


@app.template_filter("distance_number")
def distance_number(value, digits=1):
    converted = distance_value(value)
    if converted is None:
        return "—"
    return f"{converted:,.{digits}f}"


@app.template_filter("duration")
def duration_filter(value):
    if value is None:
        return "—"
    minutes = int(round(value))
    if minutes < 60:
        return f"{minutes} min"
    hours, remainder = divmod(minutes, 60)
    return f"{hours}h {remainder:02d}m" if remainder else f"{hours}h"


@app.template_filter("pct")
def pct_filter(value, digits=1):
    if value is None:
        return "—"
    return f"{float(value):.{digits}f}%"


@app.template_filter("signed_pct")
def signed_pct(value, digits=1):
    if value is None:
        return "—"
    sign = "+" if value > 0 else ("−" if value < 0 else "")
    return f"{sign}{abs(float(value)):.{digits}f}%"


@app.template_filter("clock")
def clock_filter(_value=None):
    return store.utcnow().astimezone(_zone()).strftime("%H:%M")


@app.context_processor
def inject_globals():
    settings = _settings()
    counts = store.status_counts()
    return {
        "app_settings": settings,
        "nav_counts": counts,
        "distance_unit": settings.get("distance_unit", "km"),
        "initials": _initials(settings.get("operator_name", "")),
        "status_meta": store.STATUS_META,
        "priority_meta": store.PRIORITY_META,
        "status_order": store.STATUS_ORDER,
        "priority_order": store.PRIORITY_ORDER,
        "emergency_meta": store.EMERGENCY_META,
        "emergency_order": store.EMERGENCY_ORDER,
        "timezone_label": settings.get("timezone", "UTC"),
        "today_label": datetime.now(timezone.utc)
        .astimezone(_zone())
        .strftime("%a, %d %b %Y"),
        "geocoding_enabled": settings.get("geocoding_enabled", "1") == "1",
        "map_center": {
            "lat": _as_float(settings.get("map_center_lat"), 48.8566),
            "lng": _as_float(settings.get("map_center_lng"), 2.3522),
            "zoom": int(_as_float(settings.get("map_zoom"), 11)),
        },
        "refresh_interval": int(_as_float(settings.get("refresh_interval"), 0)),
        # Phase B: every template can ask what the signed-in account may do,
        # but the answer that matters is enforced again on the server.
        "current_actor": auth.current_actor(),
        "can": lambda permission: auth.can(auth.current_actor(), permission),
        "csrf_token": (auth.current_actor().csrf_token if auth.current_actor() else ""),
        "role_labels": auth.ROLE_LABELS,
    }


def _as_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _trip_payload(row, with_assignment=False):
    if row is None:
        return None
    payload = store.serialise_trip(row)
    payload["url"] = url_for("trip_detail", trip_id=row["id"])
    if with_assignment:
        payload["assignment"] = store.trip_assignment(row["id"])
    return payload


def _validate_assignment(values, availability):
    """Validate selected resources against the current availability window."""
    errors = {}
    vehicle_id = values.get("vehicle_id")
    if vehicle_id not in (None, ""):
        try:
            vehicle_id = int(vehicle_id)
        except (TypeError, ValueError):
            errors["vehicle_id"] = "Choose a valid vehicle from the registry."
            vehicle_id = None
        else:
            vehicle = next(
                (item for item in availability["vehicles"] if item["id"] == vehicle_id),
                None,
            )
            if vehicle is None:
                errors["vehicle_id"] = "That vehicle is not in the registry."
            elif not vehicle["available"]:
                errors["vehicle_id"] = (
                    f"{vehicle['call_sign']} is unavailable: {vehicle['reason']}."
                )
    else:
        vehicle_id = None

    crew_ids = []
    for raw in values.get("crew_ids", []):
        try:
            personnel_id = int(raw)
        except (TypeError, ValueError):
            errors["crew_ids"] = "Choose valid personnel from the registry."
            continue
        if personnel_id not in crew_ids:
            crew_ids.append(personnel_id)
    if len(crew_ids) > 4:
        errors["crew_ids"] = "Assign no more than four responders to one response."
    for personnel_id in crew_ids:
        member = next(
            (item for item in availability["personnel"] if item["id"] == personnel_id),
            None,
        )
        if member is None:
            errors["crew_ids"] = "One of the selected responders is not in the registry."
            break
        if not member["available"]:
            errors["crew_ids"] = (
                f"{member['name']} is unavailable: {member['reason']}."
            )
            break
    return vehicle_id, crew_ids, errors


def _wants_json():
    return request.is_json or request.accept_mimetypes.best == "application/json"


# ---------------------------------------------------------------------------
# Screens
# ---------------------------------------------------------------------------


@app.route("/")
def dashboard():
    summary = store.dashboard_summary()
    return render_template(
        "dashboard.html",
        current_nav="dashboard",
        page_title="Operations overview",
        page_subtitle="Recorded emergency responses, dispatch status and route readiness across the workspace.",
        summary=summary,
        active_trips=store.list_open_trips(limit=6),
        recent_trips=store.list_trips(limit=7),
        activity=store.recent_events(6),
        map_data=[_trip_payload(row) for row in store.list_trips(limit=80)],
    )


@app.route("/fleet-map")
def fleet_map():
    trips = [_trip_payload(row) for row in store.list_trips(limit=200)]
    return render_template(
        "fleet_map.html",
        current_nav="map",
        page_title="Response map",
        page_subtitle="Geographic view of recorded incident locations and response destinations.",
        trips=trips,
        located=sum(1 for trip in trips if trip["has_coordinates"]),
        counts={status: sum(1 for trip in trips if trip["status"] == status) for status in store.STATUS_ORDER},
        map_data=trips,
    )


@app.route("/trips")
def trips():
    settings = _settings()
    allowed_status = {"all", *store.STATUS_ORDER}
    allowed_priority = {"all", *store.PRIORITY_ORDER}
    allowed_sort = set(store.SORTS)

    query = (request.args.get("q") or "").strip()[:80]
    status = request.args.get("status") or settings.get("default_register_view", "all")
    status = status if status in allowed_status else "all"
    priority = request.args.get("priority", "all")
    priority = priority if priority in allowed_priority else "all"
    sort = request.args.get("sort", "newest")
    sort = sort if sort in allowed_sort else "newest"

    try:
        page = int(request.args.get("page", 1))
    except ValueError:
        page = 1
    per_page = 12

    total = store.count_trips(query, status, priority)
    pages = max(1, math.ceil(total / per_page))
    page = min(max(page, 1), pages)
    rows = store.list_trips(
        query=query,
        status=status,
        priority=priority,
        sort=sort,
        limit=per_page,
        offset=(page - 1) * per_page,
    )

    export_args = {
        "q": query,
        "status": status,
        "priority": priority,
        "sort": sort,
    }

    return render_template(
        "trips.html",
        current_nav="trips",
        page_title="Response register",
        page_subtitle="Search, filter and manage every recorded emergency response in the register.",
        trips=rows,
        total=total,
        counts=store.status_counts(),
        page=page,
        pages=pages,
        per_page=per_page,
        query=query,
        status=status,
        priority=priority,
        sort=sort,
        export_args=export_args,
        filtered=bool(query or status != "all" or priority != "all"),
    )


def _response_values(source):
    source = source or {}
    waypoints = source.get("waypoints")
    if isinstance(waypoints, str):
        try:
            waypoints = json.loads(waypoints)
        except (TypeError, ValueError):
            waypoints = []
    if not isinstance(waypoints, list):
        waypoints = []
    raw_vehicle = source.get("vehicle_id")
    if raw_vehicle in (None, ""):
        vehicle_id = None
    else:
        try:
            vehicle_id = int(raw_vehicle)
        except (TypeError, ValueError):
            vehicle_id = raw_vehicle
    if hasattr(source, "getlist"):
        raw_crew = source.getlist("crew_ids")
    else:
        raw_crew = source.get("crew_ids") or []
    if isinstance(raw_crew, (str, int)):
        raw_crew = [raw_crew]
    crew_ids = []
    for item in raw_crew:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        if value not in crew_ids:
            crew_ids.append(value)
    return {
        "name": (source.get("name") or "").strip()[:120],
        "emergency_type": (source.get("emergency_type") or "").strip(),
        "origin": (source.get("origin") or "").strip()[:120],
        "destination": (source.get("destination") or "").strip()[:120],
        "priority": (source.get("priority") or "").strip(),
        "status": (source.get("status") or "").strip(),
        "status_explicit": (source.get("status_explicit") or "") == "1",
        "dispatch_at": (source.get("dispatch_at") or "").strip(),
        "instructions": (source.get("instructions") or "").strip()[:2000],
        "notes": (source.get("notes") or "").strip()[:2000],
        "waypoints": [str(item).strip()[:120] for item in waypoints if str(item).strip()][:4],
        "vehicle_id": vehicle_id,
        "crew_ids": crew_ids,
        "origin_place_id": (source.get("origin_place_id") or "").strip()[:120],
        "destination_place_id": (source.get("destination_place_id") or "").strip()[:120],
    }


def _validate_response(values):
    errors = {}
    if not 2 <= len(values["name"]) <= 120:
        errors["name"] = "Enter a response name between 2 and 120 characters."
    if values["emergency_type"] not in store.EMERGENCY_META:
        errors["emergency_type"] = "Choose the type of emergency response."
    if len(values["origin"]) < 2:
        errors["origin"] = "Enter the incident location."
    if len(values["destination"]) < 2:
        errors["destination"] = "Enter the response destination."
    if (
        values["origin"]
        and values["destination"]
        and values["origin"].casefold() == values["destination"].casefold()
    ):
        errors["destination"] = "The incident location and response destination must differ."
    if values["priority"] not in store.PRIORITY_META:
        errors["priority"] = "Choose a valid response priority."
    if values["status"] not in {"scheduled", "in_transit"}:
        errors["status"] = "Choose whether to dispatch now or schedule the response."
    if not values["dispatch_at"]:
        errors["dispatch_at"] = "Choose the dispatch date and time."
    else:
        try:
            parsed = store.parse_dt(values["dispatch_at"])
            values["dispatch_at"] = parsed.strftime("%Y-%m-%dT%H:%M")
        except (TypeError, ValueError):
            errors["dispatch_at"] = "Enter a valid dispatch date and time."
    if len(values["waypoints"]) > 4:
        errors["waypoints"] = "Add no more than four intermediate stops."
    for waypoint in values["waypoints"]:
        if len(waypoint) < 2:
            errors["waypoints"] = "Each intermediate stop needs a name."
            break
    return errors


@app.route("/trips/new", methods=["GET", "POST"])
def create_response():
    settings = _settings()
    errors = {}
    status_code = 200
    if request.method == "POST":
        payload = request.get_json(silent=True) if request.is_json else request.form
        values = _response_values(payload)
        errors = _validate_response(values)
        try:
            duration_hint = _optional_int(payload.get("duration_min"), 0, 20160)
        except ValueError:
            duration_hint = None
        resource_data = store.resource_availability(
            dispatch_at=values["dispatch_at"] if "dispatch_at" not in errors else None,
            duration_min=duration_hint,
            emergency_type=values["emergency_type"]
            if values["emergency_type"] in store.EMERGENCY_META
            else None,
        )
        vehicle_id, crew_ids, assignment_errors = _validate_assignment(
            values, resource_data
        )
        errors.update(assignment_errors)
        # A response with a unit already assigned has not departed yet: it starts
        # scheduled unless the operator deliberately chose a starting state.
        if not errors and vehicle_id is not None and not values["status_explicit"]:
            values["status"] = "scheduled"
        if not errors:
            try:
                distance = _optional_float(payload.get("distance_km"), 0, 50000)
                duration = _optional_int(payload.get("duration_min"), 0, 20160)
                origin_coords = _parse_coordinate_pair(payload, "origin")
                destination_coords = _parse_coordinate_pair(payload, "destination")
            except ValueError as error:
                errors["route"] = str(error)
            else:
                if (origin_coords is None) != (destination_coords is None):
                    errors["route"] = "Provide both incident and destination coordinates."
                else:
                    trip_id = store.create_trip(
                        origin=values["origin"],
                        destination=values["destination"],
                        priority=values["priority"],
                        status=values["status"],
                        distance_km=distance,
                        duration_min=duration,
                        origin_lat=origin_coords[0] if origin_coords else None,
                        origin_lng=origin_coords[1] if origin_coords else None,
                        destination_lat=destination_coords[0]
                        if destination_coords
                        else None,
                        destination_lng=destination_coords[1]
                        if destination_coords
                        else None,
                        name=values["name"],
                        emergency_type=values["emergency_type"],
                        dispatch_at=store.parse_dt(values["dispatch_at"]).strftime(
                            "%Y-%m-%d %H:%M:%S"
                        ),
                        instructions=values["instructions"] or None,
                        notes=values["notes"] or None,
                        waypoints=values["waypoints"] or None,
                        vehicle_id=vehicle_id,
                        crew_ids=crew_ids,
                        origin_place_id=values["origin_place_id"] or None,
                        destination_place_id=values["destination_place_id"] or None,
                    )
                    trip = store.get_trip(trip_id)
                    if request.is_json:
                        return jsonify({"trip": _trip_payload(trip, with_assignment=True)}), 201
                    flash(
                        f"Response {trip['reference']} recorded for {trip['origin']}.",
                        "success",
                    )
                    return redirect(url_for("trip_detail", trip_id=trip_id))
        else:
            status_code = 422
    else:
        values = {
            "name": "",
            "emergency_type": "",
            "origin": "",
            "destination": "",
            "priority": settings.get("default_priority", "high"),
            "status": settings.get("default_trip_status", "in_transit"),
            "dispatch_at": store.utcnow().strftime("%Y-%m-%dT%H:%M"),
            "instructions": "",
            "notes": "",
            "waypoints": [],
            "vehicle_id": None,
            "crew_ids": [],
            "origin_place_id": "",
            "destination_place_id": "",
        }
        resource_data = store.resource_availability(
            dispatch_at=values["dispatch_at"],
            emergency_type=None,
        )

    if errors:
        status_code = 422
        if request.is_json:
            return (
                jsonify(
                    {
                        "error": next(iter(errors.values())),
                        "errors": errors,
                    }
                ),
                422,
            )

    latest = store.list_trips(limit=1)
    return (
        render_template(
            "trip_create.html",
            current_nav="trips",
            page_title="Create emergency response",
            page_subtitle="Dispatch an emergency unit, record the response route and store the assignment in the register.",
            values=values,
            errors=errors,
            latest_response=_trip_payload(latest[0]) if latest else None,
            resource_data=resource_data,
        ),
        status_code,
    )


@app.route("/api/resources/availability")
def api_resource_availability():
    dispatch_at = request.args.get("dispatch_at") or store.iso_now()
    try:
        dispatch = store.parse_dt(dispatch_at)
        duration = _optional_int(request.args.get("duration_min"), 0, 20160)
    except (TypeError, ValueError):
        return jsonify({"error": "Provide a valid dispatch time and duration."}), 400
    emergency_type = (request.args.get("emergency_type") or "").strip()
    if emergency_type not in store.EMERGENCY_META:
        emergency_type = None
    return jsonify(
        store.resource_availability(
            dispatch_at=dispatch,
            duration_min=duration,
            emergency_type=emergency_type,
        )
    )


@app.route("/resources")
def resources():
    return render_template(
        "resources.html",
        current_nav="resources",
        page_title="Response resources",
        page_subtitle="Vehicles and personnel available for emergency assignment across the workspace.",
        vehicles=store.list_vehicles(),
        personnel=store.list_personnel(),
        vehicle_types=store.VEHICLE_TYPES,
        vehicle_type_order=store.VEHICLE_TYPE_ORDER,
        vehicle_statuses=store.VEHICLE_STATUS_META,
        vehicle_status_order=store.VEHICLE_STATUS_ORDER,
        personnel_roles=store.PERSONNEL_ROLES,
        personnel_role_order=store.PERSONNEL_ROLE_ORDER,
        personnel_statuses=store.PERSONNEL_STATUS_META,
        personnel_status_order=store.PERSONNEL_STATUS_ORDER,
        registry_counts=store.registry_counts(),
    )


@app.route("/resources/vehicles", methods=["POST"])
def create_resource_vehicle():
    call_sign = (request.form.get("call_sign") or "").strip().upper()[:24]
    vehicle_type = (request.form.get("vehicle_type") or "").strip()
    status = (request.form.get("status") or "available").strip()
    base = (request.form.get("base_location") or "").strip()[:120]
    registration = (request.form.get("registration") or "").strip()[:40]
    notes = (request.form.get("notes") or "").strip()[:300]
    error = None
    if len(call_sign) < 2:
        error = "Enter a vehicle call sign between 2 and 24 characters."
    elif vehicle_type not in store.VEHICLE_TYPES:
        error = "Choose a valid vehicle type."
    elif status not in store.VEHICLE_STATUS_META:
        error = "Choose a valid vehicle status."
    if error:
        flash(error, "error")
        return redirect(url_for("resources"))
    try:
        store.create_vehicle(
            call_sign=call_sign,
            vehicle_type=vehicle_type,
            registration=registration or None,
            base_location=base or None,
            status=status,
            notes=notes or None,
        )
    except sqlite3.IntegrityError:
        flash(f"A vehicle with call sign {call_sign} already exists.", "error")
    else:
        flash(
            f"Vehicle {call_sign} added. Issue a unit code from its row so the crew "
            "can pair a phone.",
            "success",
        )
    return redirect(url_for("resources"))


@app.route("/resources/vehicles/<int:vehicle_id>/status", methods=["POST"])
def update_resource_vehicle(vehicle_id):
    status = (request.form.get("status") or "").strip()
    try:
        store.update_vehicle_status(vehicle_id, status)
    except LookupError:
        abort(404)
    except ValueError as error:
        flash(str(error), "error")
    else:
        flash("Vehicle availability updated.", "success")
    return redirect(url_for("resources"))


@app.route("/resources/vehicles/<int:vehicle_id>/token", methods=["POST"])
def issue_resource_vehicle_token(vehicle_id):
    """Issue or rotate a unit code.

    The plaintext is rendered on the response page and nowhere else: only its
    digest is stored, and re-issuing invalidates the previous code immediately.
    """
    vehicle = store.get_vehicle(vehicle_id)
    if vehicle is None:
        abort(404)
    rotated = vehicle["has_token"]
    token = unit_tokens.issue(vehicle_id)
    if token is None:
        abort(404)
    actor = auth.current_actor()
    admin_store.audit_record(
        actor_id=actor.id if actor else None,
        actor_role=actor.role if actor else None,
        action="vehicle.token_issued",
        detail={
            "vehicle_id": vehicle_id,
            "call_sign": vehicle["call_sign"],
            "replaced_existing": bool(rotated),
        },
        ip=request.remote_addr or "unknown",
    )
    return render_template(
        "unit_token.html",
        current_nav="resources",
        page_title="Unit code",
        page_subtitle="Shown once. Only a digest is stored, so it cannot be read back.",
        vehicle=vehicle,
        token=token,
        rotated=rotated,
    )


@app.route("/resources/vehicles/<int:vehicle_id>/token/revoke", methods=["POST"])
def revoke_resource_vehicle_token(vehicle_id):
    vehicle = store.get_vehicle(vehicle_id)
    if vehicle is None:
        abort(404)
    unit_tokens.revoke(vehicle_id)
    actor = auth.current_actor()
    admin_store.audit_record(
        actor_id=actor.id if actor else None,
        actor_role=actor.role if actor else None,
        action="vehicle.token_revoked",
        detail={"vehicle_id": vehicle_id, "call_sign": vehicle["call_sign"]},
        ip=request.remote_addr or "unknown",
    )
    flash(
        f"Unit code for {vehicle['call_sign']} revoked. That unit is refused until "
        "a new code is issued.",
        "success",
    )
    return redirect(url_for("resources"))


@app.route("/resources/personnel", methods=["POST"])
def create_resource_personnel():
    employee_id = (request.form.get("employee_id") or "").strip().upper()[:24]
    name = (request.form.get("name") or "").strip()[:80]
    role = (request.form.get("role") or "").strip()
    status = (request.form.get("status") or "on_duty").strip()
    base = (request.form.get("base_location") or "").strip()[:120]
    error = None
    if len(employee_id) < 2:
        error = "Enter an employee ID between 2 and 24 characters."
    elif not 2 <= len(name) <= 80:
        error = "Enter the responder's name between 2 and 80 characters."
    elif role not in store.PERSONNEL_ROLES:
        error = "Choose a valid responder role."
    elif status not in store.PERSONNEL_STATUS_META:
        error = "Choose a valid duty status."
    if error:
        flash(error, "error")
        return redirect(url_for("resources"))
    try:
        store.create_personnel(
            employee_id=employee_id,
            name=name,
            role=role,
            base_location=base or None,
            status=status,
        )
    except sqlite3.IntegrityError:
        flash(f"A responder with employee ID {employee_id} already exists.", "error")
    else:
        flash(f"{name} added to the response roster.", "success")
    return redirect(url_for("resources"))


@app.route("/resources/personnel/<int:personnel_id>/status", methods=["POST"])
def update_resource_personnel(personnel_id):
    status = (request.form.get("status") or "").strip()
    try:
        store.update_personnel_status(personnel_id, status)
    except LookupError:
        abort(404)
    except ValueError as error:
        flash(str(error), "error")
    else:
        flash("Personnel duty status updated.", "success")
    return redirect(url_for("resources"))


@app.route("/trips/<int:trip_id>")
def trip_detail(trip_id):
    trip = store.get_trip(trip_id)
    if trip is None:
        abort(404)
    events = store.trip_events(trip_id)
    return render_template(
        "trip_detail.html",
        current_nav="trips",
        page_title="Response details",
        page_subtitle="Route record, dispatch details and lifecycle timeline for this response.",
        trip=trip,
        trip_json=_trip_payload(trip),
        assignment=store.trip_assignment(trip_id),
        events=events,
        created=request.args.get("created") == "1",
    )


@app.route("/analytics")
def analytics():
    range_key = request.args.get("range", "30")
    if range_key not in {"7", "30", "90", "all"}:
        range_key = "30"
    status = request.args.get("status", "all")
    if status not in {"all", *store.STATUS_ORDER}:
        status = "all"

    data = store.analytics(range_key, status)
    return render_template(
        "analytics.html",
        current_nav="analytics",
        page_title="Analytics & reports",
        page_subtitle="Historic performance of the emergency responses recorded in this workspace.",
        data=data,
        range_key=range_key,
        status=status,
    )


def _settings_values(source):
    source = source or {}
    return {
        "workspace_name": (source.get("workspace_name") or "").strip(),
        "workspace_region": (source.get("workspace_region") or "").strip(),
        "timezone": source.get("timezone") or "UTC",
        "distance_unit": source.get("distance_unit") or "km",
        "default_priority": source.get("default_priority") or "high",
        "default_trip_status": source.get("default_trip_status") or "in_transit",
        "default_register_view": source.get("default_register_view") or "all",
        "map_center_lat": (source.get("map_center_lat") or "").strip(),
        "map_center_lng": (source.get("map_center_lng") or "").strip(),
        "map_zoom": (source.get("map_zoom") or "").strip(),
        "geocoding_enabled": "1"
        if str(source.get("geocoding_enabled")) in {"1", "on", "true"}
        else "0",
        "refresh_interval": source.get("refresh_interval") or "0",
        "operator_name": (source.get("operator_name") or "").strip(),
        "operator_role": (source.get("operator_role") or "").strip(),
    }


def _validate_settings(values):
    errors = {}

    if not 2 <= len(values["workspace_name"]) <= 60:
        errors["workspace_name"] = "Enter a workspace name between 2 and 60 characters."
    if len(values["workspace_region"]) > 60:
        errors["workspace_region"] = "Keep the region under 60 characters."

    try:
        ZoneInfo(values["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        errors["timezone"] = "Choose a valid timezone."

    if values["distance_unit"] not in {"km", "mi"}:
        errors["distance_unit"] = "Choose kilometres or miles."
    if values["default_priority"] not in store.PRIORITY_META:
        errors["default_priority"] = "Choose a valid default priority."
    if values["default_trip_status"] not in {"in_transit", "scheduled"}:
        errors["default_trip_status"] = "Choose how new trips should begin."
    if values["default_register_view"] not in {"all", *store.STATUS_ORDER}:
        errors["default_register_view"] = "Choose a valid default register view."
    if values["refresh_interval"] not in {"0", "30", "60", "120"}:
        errors["refresh_interval"] = "Choose a supported refresh interval."

    try:
        lat = float(values["map_center_lat"])
        if not -90 <= lat <= 90:
            raise ValueError
    except ValueError:
        errors["map_center_lat"] = "Latitude must be between -90 and 90."
    try:
        lng = float(values["map_center_lng"])
        if not -180 <= lng <= 180:
            raise ValueError
    except ValueError:
        errors["map_center_lng"] = "Longitude must be between -180 and 180."
    try:
        zoom = int(values["map_zoom"])
        if not 2 <= zoom <= 18:
            raise ValueError
    except ValueError:
        errors["map_zoom"] = "Zoom must be a whole number between 2 and 18."

    if not 1 <= len(values["operator_name"]) <= 40:
        errors["operator_name"] = "Enter an operator name under 40 characters."
    if len(values["operator_role"]) > 40:
        errors["operator_role"] = "Keep the role under 40 characters."

    return errors


@app.route("/settings", methods=["GET", "POST"])
def settings():
    errors = {}
    values = store.get_settings()

    if request.method == "POST":
        values = _settings_values(request.form)
        errors = _validate_settings(values)
        if not errors:
            store.save_settings(values)
            g.pop("settings", None)
            g.pop("zone", None)
            flash("Workspace settings saved.", "success")
            return redirect(url_for("settings"))

    counts = store.data_counts()
    return render_template(
        "settings.html",
        current_nav="settings",
        page_title="Settings",
        page_subtitle="Workspace identity, operator defaults, map behaviour and stored data.",
        values=values,
        errors=errors,
        counts=counts,
        timezones=TIMEZONES,
        refresh_options=REFRESH_OPTIONS,
        saved=request.args.get("saved") == "1",
        schema_version=1,
    )


@app.route("/settings/reset", methods=["POST"])
def reset_settings():
    store.reset_settings()
    g.pop("settings", None)
    g.pop("zone", None)
    flash("Settings restored to the GreenRoute defaults.", "success")
    return redirect(url_for("settings"))


# ---------------------------------------------------------------------------
# Trip API
# ---------------------------------------------------------------------------


def _clean_text(value, limit):
    return (value or "").strip()[:limit]


def _optional_float(value, low, high):
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("A numeric value was expected.")
    if not low <= number <= high:
        raise ValueError("A value is outside the supported range.")
    return number


def _optional_int(value, low, high):
    number = _optional_float(value, low, high)
    return int(round(number)) if number is not None else None


def _parse_coordinate_pair(payload, prefix):
    lat = _optional_float(payload.get(f"{prefix}_lat"), -90, 90)
    lng = _optional_float(payload.get(f"{prefix}_lng"), -180, 180)
    if (lat is None) != (lng is None):
        raise ValueError("Both coordinates must be supplied together.")
    return (lat, lng) if lat is not None else None


# ---------------------------------------------------------------------------
# Address lookup
# ---------------------------------------------------------------------------

GEOCODE_NEGATIVE_TTL_SECONDS = 60 * 60


def _cached_geocode_payload(cached, address):
    return {
        "status": cached["status"],
        "lat": cached["lat"],
        "lng": cached["lng"],
        "display_name": cached["display_name"],
        "message": cached["message"],
        "provider": cached["provider"],
        "attribution": geocoding.ATTRIBUTION,
        "cached": True,
        "address": address,
    }


def _cached_geocode(address, near=None):
    """Resolve one address, reusing successful and recent negative results."""
    normalized = geocoding.normalise_address(address)
    if len(normalized) < 2:
        return {
            "status": "missing_address",
            "message": "The recorded address is too short to look up.",
            "cached": False,
            "address": normalized,
        }

    context = geocoding.context_key(near)
    cache_key = f"{normalized.casefold()}|{context}"
    cached = store.get_geocode_cache(cache_key)
    if cached:
        recent = False
        if cached["status"] != "resolved":
            attempted = store.parse_dt(cached["attempted_at"])
            recent = bool(
                attempted
                and (store.utcnow() - attempted).total_seconds()
                < GEOCODE_NEGATIVE_TTL_SECONDS
            )
        if cached["status"] == "resolved" or recent:
            return _cached_geocode_payload(cached, normalized)

    try:
        result = geocoding.geocode(normalized, near)
    except geocoding.GeocodeError as error:
        return {
            "status": error.status,
            "message": error.message,
            "cached": False,
            "address": normalized,
        }

    result["cached"] = False
    if result["status"] in {"resolved", "ambiguous", "not_found"}:
        store.save_geocode_cache(
            cache_key,
            normalized,
            context,
            result["status"],
            lat=result.get("lat"),
            lng=result.get("lng"),
            display_name=result.get("display_name"),
            provider=result.get("provider", geocoding.PROVIDER),
            provider_ref=result.get("provider_ref"),
            message=result.get("message"),
        )
    return result


def _combined_geocode_status(origin, destination):
    results = [origin, destination]
    statuses = [result.get("status") for result in results]
    for status in (
        "unavailable",
        "rate_limited",
        "invalid_response",
        "error",
        "ambiguous",
        "not_found",
        "missing_address",
        "invalid",
    ):
        if status in statuses:
            return status
    return "partial" if "resolved" in statuses else "error"


def _geocode_failure_message(origin, destination):
    parts = []
    if origin.get("status") != "resolved":
        parts.append(
            "Incident location: "
            + (origin.get("message") or "Address could not be resolved.")
        )
    if destination.get("status") != "resolved":
        parts.append(
            "Response destination: "
            + (destination.get("message") or "Address could not be resolved.")
        )
    return " ".join(parts) or "The recorded addresses could not be resolved."


def _same_endpoints(trip, origin, destination):
    if not all(
        trip[key] is not None
        for key in ("origin_lat", "origin_lng", "destination_lat", "destination_lng")
    ):
        return False
    return (
        geocoding.haversine_km(
            (trip["origin_lat"], trip["origin_lng"]),
            (origin["lat"], origin["lng"]),
        )
        < 0.02
        and geocoding.haversine_km(
            (trip["destination_lat"], trip["destination_lng"]),
            (destination["lat"], destination["lng"]),
        )
        < 0.02
    )


def _resolve_trip_geocode(trip):
    """Resolve and persist both endpoints for one recorded trip."""
    origin = _cached_geocode(trip["origin"])
    near = None
    if origin.get("status") == "resolved":
        near = (origin["lat"], origin["lng"])
    destination = _cached_geocode(trip["destination"], near)

    if origin.get("status") == "resolved" and destination.get("status") == "resolved":
        endpoint_distance = geocoding.haversine_km(
            (origin["lat"], origin["lng"]),
            (destination["lat"], destination["lng"]),
        )
        if endpoint_distance < 0.05:
            status = "invalid"
            message = "The two addresses resolved to the same point. Refine one of the addresses."
            store.mark_geocode_status(trip["id"], status, message)
        else:
            if not _same_endpoints(trip, origin, destination):
                store.save_coordinates(
                    trip["id"],
                    (origin["lat"], origin["lng"]),
                    (destination["lat"], destination["lng"]),
                )
            else:
                store.mark_geocode_status(trip["id"], "resolved", None)
            return {
                "status": "resolved",
                "message": "Origin and destination resolved from their recorded addresses.",
                "origin": origin,
                "destination": destination,
            }
    else:
        status = _combined_geocode_status(origin, destination)
        message = _geocode_failure_message(origin, destination)
        store.mark_geocode_status(trip["id"], status, message)

    return {
        "status": status,
        "message": message,
        "origin": origin,
        "destination": destination,
    }


@app.get("/api/geocode")
def api_geocode():
    if _settings().get("geocoding_enabled", "1") != "1":
        return jsonify({"error": "Address lookup is disabled in settings."}), 403

    address = (request.args.get("address") or "").strip()[:200]
    near = None
    raw_lat = request.args.get("near_lat")
    raw_lng = request.args.get("near_lng")
    if raw_lat not in (None, "") or raw_lng not in (None, ""):
        try:
            lat = _optional_float(raw_lat, -90, 90)
            lng = _optional_float(raw_lng, -180, 180)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        if lat is None or lng is None or not geocoding.coordinate_is_valid(lat, lng):
            return jsonify({"error": "Provide a valid nearby coordinate pair."}), 400
        near = (lat, lng)

    result = _cached_geocode(address, near)
    if result.get("status") == "resolved":
        return jsonify(result)
    return jsonify({**result, "error": result.get("message")}), 422


@app.get("/api/locations/suggest")
def api_location_suggest():
    if _settings().get("geocoding_enabled", "1") != "1":
        return jsonify({"error": "Location search is disabled in settings."}), 403

    query = geocoding.normalise_address(request.args.get("q") or "")[:200]
    if len(query) < geocoding.SUGGESTION_MIN_LENGTH:
        return jsonify(
            {
                "suggestions": [],
                "status": "too_short",
                "message": "Type at least three characters to search for a place.",
                "provider": geocoding.SUGGESTION_PROVIDER,
            }
        )

    near = None
    raw_lat = request.args.get("near_lat")
    raw_lng = request.args.get("near_lng")
    if raw_lat not in (None, "") or raw_lng not in (None, ""):
        try:
            lat = _optional_float(raw_lat, -90, 90)
            lng = _optional_float(raw_lng, -180, 180)
        except ValueError as error:
            return jsonify({"error": str(error), "suggestions": []}), 400
        if lat is None or lng is None or not geocoding.coordinate_is_valid(lat, lng):
            return jsonify({"error": "Provide a valid nearby coordinate pair.", "suggestions": []}), 400
        near = (lat, lng)

    try:
        limit = int(request.args.get("limit", geocoding.SUGGESTION_LIMIT))
    except (TypeError, ValueError):
        limit = geocoding.SUGGESTION_LIMIT
    limit = max(1, min(geocoding.SUGGESTION_LIMIT, limit))

    try:
        suggestions = geocoding.suggest(query, near, limit)
    except geocoding.GeocodeError as error:
        status_code = 429 if error.status == "rate_limited" else 503
        return jsonify(
            {
                "suggestions": [],
                "status": error.status,
                "error": error.message,
                "message": error.message,
                "provider": geocoding.SUGGESTION_PROVIDER,
            }
        ), status_code

    response = jsonify(
        {
            "suggestions": suggestions,
            "count": len(suggestions),
            "status": "ok" if suggestions else "not_found",
            "message": "" if suggestions else "No matching places were found. Check the spelling or enter the address manually.",
            "query": query,
            "provider": geocoding.SUGGESTION_PROVIDER,
            "attribution": geocoding.SUGGESTION_ATTRIBUTION,
        }
    )
    response.headers["Cache-Control"] = "private, max-age=30"
    return response


@app.post("/api/trips/<int:trip_id>/geocode")
def api_trip_geocode(trip_id):
    if _settings().get("geocoding_enabled", "1") != "1":
        return jsonify({"error": "Address lookup is disabled in settings."}), 403

    trip = store.get_trip(trip_id)
    if trip is None:
        return jsonify({"error": "Trip not found."}), 404

    lookup = _resolve_trip_geocode(trip)
    updated = store.get_trip(trip_id)
    return jsonify({"trip": _trip_payload(updated), "lookup": lookup}), 200


@app.post("/api/trips")
def api_create_trip():
    payload = request.get_json(silent=True) or request.form

    settings = _settings()
    origin = _clean_text(payload.get("origin"), 120)
    destination = _clean_text(payload.get("destination"), 120)
    priority = (payload.get("priority") or settings.get("default_priority") or "normal").strip()
    status = (payload.get("status") or settings.get("default_trip_status") or "in_transit").strip()

    errors = []
    if len(origin) < 2:
        errors.append("Enter a starting location of at least 2 characters.")
    if len(destination) < 2:
        errors.append("Enter a destination of at least 2 characters.")
    if origin and destination and origin.casefold() == destination.casefold():
        errors.append("The starting location and destination must be different.")
    if priority not in store.PRIORITY_META:
        errors.append("Choose a valid priority.")
    if status not in {"in_transit", "scheduled"}:
        errors.append("Choose whether the trip starts now or is scheduled.")
    if errors:
        return jsonify({"error": errors[0], "errors": errors}), 400

    try:
        distance = _optional_float(payload.get("distance_km"), 0, 50000)
        duration = _optional_int(payload.get("duration_min"), 0, 20160)
        origin_coords = _parse_coordinate_pair(payload, "origin")
        destination_coords = _parse_coordinate_pair(payload, "destination")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    if (origin_coords is None) != (destination_coords is None):
        return jsonify({"error": "Provide both origin and destination coordinates."}), 400

    trip_id = store.create_trip(
        origin=origin,
        destination=destination,
        priority=priority,
        status=status,
        distance_km=distance,
        duration_min=duration,
        origin_lat=origin_coords[0] if origin_coords else None,
        origin_lng=origin_coords[1] if origin_coords else None,
        destination_lat=destination_coords[0] if destination_coords else None,
        destination_lng=destination_coords[1] if destination_coords else None,
        origin_place_id=_clean_text(payload.get("origin_place_id"), 120) or None,
        destination_place_id=_clean_text(payload.get("destination_place_id"), 120) or None,
    )
    trip = store.get_trip(trip_id)
    return jsonify({"trip": _trip_payload(trip)}), 201


@app.route("/api/trips", methods=["GET"])
def api_trips():
    status = request.args.get("status", "all")
    if status not in {"all", *store.STATUS_ORDER}:
        status = "all"
    priority = request.args.get("priority", "all")
    if priority not in {"all", *store.PRIORITY_ORDER}:
        priority = "all"
    query = (request.args.get("q") or "").strip()[:80]
    rows = store.list_trips(
        query=query, status=status, priority=priority, sort="newest", limit=200
    )
    return jsonify(
        {
            "trips": [_trip_payload(row) for row in rows],
            "counts": store.status_counts(),
            "generated_at": store.iso_now(),
        }
    )


@app.route("/api/trips/<int:trip_id>", methods=["GET"])
def api_trip(trip_id):
    trip = store.get_trip(trip_id)
    if trip is None:
        return jsonify({"error": "Trip not found."}), 404
    return jsonify(
        {
            "trip": _trip_payload(trip, with_assignment=True),
            "events": [
                {
                    "kind": event["kind"],
                    "message": event["message"],
                    "created_at": event["created_at"],
                }
                for event in store.trip_events(trip_id)
            ],
        }
    )


#: The admin UI's button names stay as they were in Phase A; each maps onto one
#: lifecycle action. Keeping the mapping here means the browser contract does
#: not change while the server gains a formal state machine.
ADMIN_ACTION_ALIASES = {
    "accept": "verify",
    "start": "activate",
    "depart": "depart",
    "arrive": "arrive",
    "complete": "complete",
    "cancel": "cancel",
}


@app.patch("/api/trips/<int:trip_id>")
def api_update_trip(trip_id):
    actor = auth.current_actor()
    payload = request.get_json(silent=True) or request.form
    action = (payload.get("action") or "").strip()
    lifecycle_action = ADMIN_ACTION_ALIASES.get(action)
    if lifecycle_action is None:
        return jsonify({"error": "Unsupported action."}), 400

    try:
        trip = lifecycle.apply(
            trip_id,
            lifecycle_action,
            actor,
            expected_state=(payload.get("expected_state") or "").strip() or None,
            reason=(payload.get("reason") or "").strip() or None,
        )
    except lifecycle.NotFound as error:
        return jsonify({"error": error.message}), error.status
    except lifecycle.LifecycleError as error:
        body = {"error": error.message, "code": error.code}
        body.update(error.extra)
        return jsonify(body), error.status

    return jsonify({"trip": _trip_payload(trip)})


@app.post("/api/maintenance/expire-stale")
def api_maintenance_expire():
    """Sweep endpoint: report telemetry health and apply the activation ceiling.

    Phase C corrected the Phase B behaviour: losing GPS no longer cancels an
    emergency. A stale unit is reported so an operator can act; only a session
    that exceeded the twelve-hour activation ceiling is closed automatically.
    """
    actor = auth.current_actor()
    warnings = lifecycle.telemetry_warnings()
    expired = lifecycle.expire_overtime()
    admin_store.audit_record(
        actor_id=actor.id if actor else None,
        actor_role=actor.role if actor else None,
        action="emergency.expire_sweep",
        detail={"expired": expired, "warnings": len(warnings)},
        ip=request.remote_addr or "unknown",
    )
    return jsonify(
        {
            "expired": expired,
            "count": len(expired),
            "telemetry_warnings": warnings,
        }
    )


@app.get("/api/live/positions")
def api_live_positions():
    """Active emergency vehicles with their latest trusted position.

    Polling contract: `event_id` is the highest telemetry fix id in this answer.
    Pass it back as `since` to receive only what changed. The id is monotonic and
    assigned by the same insert that stores the position, so it doubles as an
    ordering token without a separate cursor table.
    """
    try:
        since = max(0, int(request.args.get("since", 0)))
    except (TypeError, ValueError):
        since = 0

    rows = store.live_positions(since)
    now = store.utcnow()
    payload = []
    event_id = since
    for row in rows:
        position = None
        if row["position_trip_id"] is not None:
            position = {
                "lat": row["lat"],
                "lng": row["lng"],
                "accuracy_m": row["accuracy_m"],
                "heading_deg": row["heading_deg"],
                "speed_mps": row["speed_mps"],
                "device_time": row["device_time"],
                "received_at": row["received_at"],
                "quality": row["quality"],
                "source": row["source"],
            }
        health = telemetry.health(
            {"received_at": row["received_at"], "accuracy_m": row["accuracy_m"]}
            if position
            else None,
            row["session_state"],
            now=now,
        )
        if row["last_fix_id"]:
            event_id = max(event_id, int(row["last_fix_id"]))
        payload.append(
            {
                "trip_id": row["trip_id"],
                "reference": row["reference"],
                "name": row["name"],
                "priority": row["priority"],
                "call_sign": row["call_sign"],
                "vehicle_type": row["vehicle_type"],
                "session_state": row["session_state"],
                "activated_at": row["activated_at"],
                "destination": row["destination"],
                "destination_coords": (
                    [row["destination_lat"], row["destination_lng"]]
                    if row["destination_lat"] is not None
                    else None
                ),
                "position": position,
                "health": health,
                "route": {
                    "provider": row["route_provider"],
                    "quality": row["route_quality"],
                    "deviation_m": row["route_deviation_m"],
                    "computed_at": row["route_computed_at"],
                    "recalculated_at": row["route_recalculated_at"],
                },
            }
        )

    return jsonify(
        {
            "event_id": event_id,
            "server_time": store.iso_now(),
            "positions": payload,
            "active_count": len(payload),
        }
    )


@app.get("/api/live/sessions/<int:trip_id>/track")
def api_live_track(trip_id):
    """Trail, active route and health for one response."""
    trip = store.get_trip(trip_id)
    if trip is None:
        return jsonify({"error": "Response not found."}), 404

    limit = request.args.get("limit", 200)
    try:
        limit = max(1, min(1000, int(limit)))
    except (TypeError, ValueError):
        limit = 200

    session_row = store.emergency_session_for_trip(trip_id)
    position = store.latest_position(trip_id)
    route = store.active_route(trip_id)
    return jsonify(
        {
            "trip_id": trip_id,
            "reference": trip["reference"],
            "session_state": session_row["state"] if session_row else None,
            "position": dict(position) if position else None,
            "health": telemetry.health(
                position, session_row["state"] if session_row else None
            ),
            "trail": store.telemetry_trail(trip_id, limit=limit),
            "route": route,
            "route_quality": trip["route_quality"],
            "deviation_m": trip["route_deviation_m"],
        }
    )


@app.post("/api/trips/bulk")
def api_bulk_trips():
    payload = request.get_json(silent=True) or request.form
    identifier = payload.get("action")
    if identifier not in {"complete", "cancel"}:
        return jsonify({"error": "Unsupported bulk action."}), 400

    raw_ids = payload.get("ids") or []
    if not isinstance(raw_ids, list):
        return jsonify({"error": "Trip ids must be a list."}), 400
    if not 1 <= len(raw_ids) <= 100:
        return jsonify({"error": "Select between 1 and 100 trips."}), 400

    actor = auth.current_actor()
    permission = "trips.cancel" if identifier == "cancel" else "trips.dispatch"
    if actor is None or not actor.can(permission):
        return auth.forbidden_response(permission)

    reason = (payload.get("reason") or "").strip() or f"Bulk {identifier} by operator."
    updated = 0
    skipped = []
    for raw_id in raw_ids:
        try:
            trip_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        try:
            lifecycle.apply(trip_id, identifier, actor, reason=reason)
            updated += 1
        except lifecycle.LifecycleError as error:
            skipped.append({"id": raw_id, "reason": error.message})
        except (LookupError, ValueError) as error:
            skipped.append({"id": raw_id, "reason": str(error)})

    return jsonify({"updated": updated, "skipped": skipped})


@app.patch("/api/trips/<int:trip_id>/location")
def api_trip_location(trip_id):
    if _settings().get("geocoding_enabled", "1") != "1":
        return (
            jsonify(
                {
                    "error": "Address lookup is disabled in settings. Enable it before recording coordinates."
                }
            ),
            403,
        )

    trip = store.get_trip(trip_id)
    if trip is None:
        return jsonify({"error": "Trip not found."}), 404

    payload = request.get_json(silent=True) or request.form
    try:
        origin = _parse_coordinate_pair(payload, "origin")
        destination = _parse_coordinate_pair(payload, "destination")
        distance = _optional_float(payload.get("distance_km"), 0, 50000)
        duration = _optional_int(payload.get("duration_min"), 0, 20160)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    if not origin or not destination:
        return (
            jsonify(
                {"error": "Both origin and destination coordinates are required."}
            ),
            400,
        )

    updated = store.save_coordinates(
        trip_id, origin, destination, distance_km=distance, duration_min=duration
    )
    return jsonify({"trip": _trip_payload(updated)})


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------


def _csv_response(rows, filename):
    buffer = io.StringIO()
    buffer.write("\ufeff")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerows(rows)
    return Response(
        buffer.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.route("/trips/export.csv")
def export_trips():
    query = (request.args.get("q") or "").strip()[:80]
    status = request.args.get("status", "all")
    priority = request.args.get("priority", "all")
    sort = request.args.get("sort", "newest")
    if status not in {"all", *store.STATUS_ORDER}:
        status = "all"
    if priority not in {"all", *store.PRIORITY_ORDER}:
        priority = "all"
    if sort not in store.SORTS:
        sort = "newest"

    rows = [["Reference", "Origin", "Destination", "Priority", "Status", "Distance (km)", "Est. duration (min)", "Created (UTC)"]]
    for trip in store.list_trips(query=query, status=status, priority=priority, sort=sort):
        rows.append(
            [
                trip["reference"],
                trip["origin"],
                trip["destination"],
                store.PRIORITY_META[trip["priority"]]["label"],
                store.STATUS_META.get(trip["status"], {}).get(
                    "label", trip["status"]
                ),
                "" if trip["distance_km"] is None else f"{trip['distance_km']:.1f}",
                "" if trip["duration_min"] is None else trip["duration_min"],
                trip["created_at"],
            ]
        )
    filename = f"greenroute-trips-{store.utcnow().strftime('%Y%m%d-%H%M')}.csv"
    return _csv_response(rows, filename)


@app.route("/trips/<int:trip_id>/export.csv")
def export_trip(trip_id):
    trip = store.get_trip(trip_id)
    if trip is None:
        abort(404)
    events = store.trip_events(trip_id)
    rows = [
        ["Reference", trip["reference"]],
        ["Origin", trip["origin"]],
        ["Destination", trip["destination"]],
        ["Priority", store.PRIORITY_META[trip["priority"]]["label"]],
        [
            "Status",
            store.STATUS_META.get(trip["status"], {}).get("label", trip["status"]),
        ],
        ["Distance (km)", "" if trip["distance_km"] is None else f"{trip['distance_km']:.1f}"],
        ["Est. duration (min)", "" if trip["duration_min"] is None else trip["duration_min"]],
        ["Created (UTC)", trip["created_at"]],
        [],
        ["Event", "Detail", "Recorded (UTC)"],
    ]
    for event in events:
        rows.append([event["kind"], event["message"], event["created_at"]])
    return _csv_response(rows, f"greenroute-{trip['reference']}.csv")


def _analytics_payload(data):
    trip = data["summary"]
    return {
        "generated_at": data["generated_at"],
        "range": data["range"],
        "range_label": data["range_label"],
        "status_filter": data["status"],
        "summary": {
            "trips": trip["total"],
            "completed": trip["completed"],
            "completion_rate": trip["completion_rate"],
            "distance_km": trip["distance_km"],
            "avg_distance_km": trip["avg_distance_km"],
            "avg_duration_min": trip["avg_duration_min"],
        },
        "change": data["change"],
        "series": data["series"],
        "status_breakdown": data["status_breakdown"],
        "priority_breakdown": data["priority_breakdown"],
    }


@app.route("/analytics/export.csv")
def export_analytics():
    range_key = request.args.get("range", "30")
    status = request.args.get("status", "all")
    data = store.analytics(range_key, status)
    rows = [["Range", data["range_label"]], ["Status filter", status], ["Generated (UTC)", data["generated_at"]], []]
    rows.append(["Date", "Trips", "Completed", "Distance (km)"])
    for day in data["series"]:
        rows.append([day["date"], day["trips"], day["completed"], f"{day['distance']:.1f}"])
    return _csv_response(
        rows, f"greenroute-analytics-{store.utcnow().strftime('%Y%m%d-%H%M')}.csv"
    )


@app.route("/analytics/export.json")
def export_analytics_json():
    data = store.analytics(
        request.args.get("range", "30"), request.args.get("status", "all")
    )
    payload = json.dumps(_analytics_payload(data), indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="greenroute-analytics.json"'
        },
    )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found."}), 404
    return (
        render_template(
            "error.html",
            current_nav=None,
            page_title="Page not found",
            page_subtitle="The page you requested does not exist.",
            error_code="404",
            error_title="We could not find that page",
            error_message="The address may have changed, or the trip record may no longer exist.",
        ),
        404,
    )


@app.errorhandler(500)
def server_error(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Internal server error."}), 500
    return (
        render_template(
            "error.html",
            current_nav=None,
            page_title="Something went wrong",
            page_subtitle="The workspace could not complete that request.",
            error_code="500",
            error_title="Unexpected workspace error",
            error_message="Try reloading the workspace. If the problem persists, check the server log.",
        ),
        500,
    )


if __name__ == "__main__":
    # One canonical development entry point. The VS Code launch and task
    # configurations also use this file and this port.
    if config.is_production():
        raise SystemExit(
            "refusing to start Flask's development server with GREENROUTE_ENV=production. "
            "Use a WSGI server (see docs/security.md)."
        )
    if app.config["USES_DEVELOPMENT_SECRET"]:
        print(
            "warning: SECRET_KEY is not set. Administrator sessions are signed with "
            "the built-in development key, which is public in this repository. Set "
            "SECRET_KEY before this server is reachable by anyone else.",
            flush=True,
        )
    port = int(os.environ.get("GREENROUTE_PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=True)
