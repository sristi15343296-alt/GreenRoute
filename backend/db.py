"""Persistence layer for GreenRoute.

The application stores recorded trips, their lifecycle events and workspace
settings in a local SQLite database. There is no live telemetry feed: every
value surfaced in the UI is derived from these records.
"""

import json
import os
import sqlite3
from datetime import date, datetime, timedelta, timezone

from flask import current_app, g

# ---------------------------------------------------------------------------
# Domain vocabulary
# ---------------------------------------------------------------------------

STATUS_META = {
    "scheduled": {"label": "Scheduled"},
    "accepted": {"label": "Accepted"},
    "in_transit": {"label": "En route"},
    "on_scene": {"label": "On scene"},
    "completed": {"label": "Completed"},
    "cancelled": {"label": "Cancelled"},
}
STATUS_ORDER = [
    "scheduled",
    "accepted",
    "in_transit",
    "on_scene",
    "completed",
    "cancelled",
]
# A response is open until it is completed or cancelled. Every availability and
# workload calculation keys off this list so committed crews are never skipped.
OPEN_STATUSES = ["scheduled", "accepted", "in_transit", "on_scene"]
CLOSED_STATUSES = ["completed", "cancelled"]

PRIORITY_META = {
    "critical": {"label": "Critical"},
    "high": {"label": "High"},
    "normal": {"label": "Normal"},
}
PRIORITY_ORDER = ["critical", "high", "normal"]

# Response categories supported by the dispatch form. These describe the type
# of emergency assignment, not a commercial service level.
EMERGENCY_META = {
    "medical": {"label": "Medical emergency", "short": "Medical"},
    "fire": {"label": "Fire or smoke", "short": "Fire"},
    "collision": {"label": "Road collision", "short": "Collision"},
    "rescue": {"label": "Rescue or extraction", "short": "Rescue"},
    "hazard": {"label": "Hazardous materials", "short": "Hazmat"},
    "welfare": {"label": "Public welfare check", "short": "Welfare"},
}
EMERGENCY_ORDER = ["medical", "fire", "collision", "rescue", "hazard", "welfare"]

VEHICLE_TYPES = {
    "ambulance": {
        "label": "Ambulance",
        "suitable_for": ["medical", "collision", "welfare"],
    },
    "fire_engine": {
        "label": "Fire engine",
        "suitable_for": ["fire", "rescue", "hazard"],
    },
    "rescue_unit": {
        "label": "Rescue unit",
        "suitable_for": ["rescue", "collision", "fire"],
    },
    "hazmat_unit": {
        "label": "Hazmat unit",
        "suitable_for": ["hazard", "fire"],
    },
    "supervisor": {
        "label": "Command vehicle",
        "suitable_for": list(EMERGENCY_META),
    },
}
VEHICLE_TYPE_ORDER = [
    "ambulance",
    "fire_engine",
    "rescue_unit",
    "hazmat_unit",
    "supervisor",
]
VEHICLE_STATUS_META = {
    "available": {"label": "Available"},
    "maintenance": {"label": "In maintenance"},
    "out_of_service": {"label": "Out of service"},
}
VEHICLE_STATUS_ORDER = ["available", "maintenance", "out_of_service"]

PERSONNEL_ROLES = {
    "paramedic": {"label": "Paramedic"},
    "emergency_driver": {"label": "Emergency driver"},
    "firefighter": {"label": "Firefighter"},
    "rescue_technician": {"label": "Rescue technician"},
    "hazmat_specialist": {"label": "Hazmat specialist"},
    "supervisor": {"label": "Response supervisor"},
}
PERSONNEL_ROLE_ORDER = [
    "paramedic",
    "emergency_driver",
    "firefighter",
    "rescue_technician",
    "hazmat_specialist",
    "supervisor",
]
PERSONNEL_STATUS_META = {
    "on_duty": {"label": "On duty"},
    "off_duty": {"label": "Off duty"},
    "leave": {"label": "On leave"},
}
PERSONNEL_STATUS_ORDER = ["on_duty", "off_duty", "leave"]

DEFAULT_SETTINGS = {
    "workspace_name": "Pan-European Logistics",
    "workspace_region": "Central Europe",
    "timezone": "UTC",
    "distance_unit": "km",
    "default_priority": "high",
    "default_trip_status": "in_transit",
    "default_register_view": "all",
    "map_center_lat": "48.8566",
    "map_center_lng": "2.3522",
    "map_zoom": "11",
    "geocoding_enabled": "1",
    "refresh_interval": "0",
    "operator_name": "Demo Operator",
    "operator_role": "Fleet Operations",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'scheduled',
    distance_km REAL,
    duration_min INTEGER,
    origin_lat REAL,
    origin_lng REAL,
    destination_lat REAL,
    destination_lng REAL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    name TEXT,
    incident_reference TEXT,
    emergency_type TEXT,
    dispatch_at TEXT,
    instructions TEXT,
    notes TEXT,
    waypoints_json TEXT,
    vehicle_id INTEGER,
    origin_place_id TEXT,
    destination_place_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status);
CREATE INDEX IF NOT EXISTS idx_trips_created ON trips (created_at);

CREATE TABLE IF NOT EXISTS trip_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_trip ON trip_events (trip_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sign TEXT UNIQUE NOT NULL,
    vehicle_type TEXT NOT NULL,
    registration TEXT,
    base_location TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    notes TEXT,
    created_at TEXT NOT NULL,
    -- The unit's bearer credential. Only the SHA-256 digest is stored, so a
    -- copy of this file cannot be replayed against the driver API.
    token_hash TEXT,
    token_issued_at TEXT
);

CREATE TABLE IF NOT EXISTS personnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    base_location TEXT,
    status TEXT NOT NULL DEFAULT 'on_duty',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_crew (
    trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    personnel_id INTEGER NOT NULL REFERENCES personnel (id),
    role_on_response TEXT,
    PRIMARY KEY (trip_id, personnel_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_crew_personnel ON trip_crew (personnel_id);

CREATE TABLE IF NOT EXISTS geocode_cache (
    cache_key TEXT PRIMARY KEY,
    address_text TEXT NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    lat REAL,
    lng REAL,
    display_name TEXT,
    provider TEXT NOT NULL DEFAULT 'nominatim',
    provider_ref TEXT,
    message TEXT,
    attempted_at TEXT NOT NULL,
    resolved_at TEXT
);
"""


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_app(app):
    app.teardown_appcontext(close_db)


def _migrate(db):
    """Add response fields to an existing trips table without touching rows."""
    existing = {row["name"] for row in db.execute("PRAGMA table_info(trips)")}
    additions = {
        "name": "TEXT",
        "incident_reference": "TEXT",
        "emergency_type": "TEXT",
        "dispatch_at": "TEXT",
        "instructions": "TEXT",
        "notes": "TEXT",
        "waypoints_json": "TEXT",
        "vehicle_id": "INTEGER",
        "geocode_status": "TEXT",
        "geocode_message": "TEXT",
        "geocoded_at": "TEXT",
        "origin_place_id": "TEXT",
        "destination_place_id": "TEXT",
        # The resolved road geometry, stored rather than recomputed per request.
        # Nullable: a response can exist before it is ever routed.
        "route_json": "TEXT",
        "route_provider": "TEXT",
        "route_computed_at": "TEXT",
        "route_distance_m": "REAL",
    }
    for column, ddl in additions.items():
        if column not in existing:
            db.execute(f"ALTER TABLE trips ADD COLUMN {column} {ddl}")
    # Columns referenced again later in this migration (Phase C).
    existing_trip_columns = {row["name"] for row in db.execute("PRAGMA table_info(trips)")}
    db.execute("CREATE INDEX IF NOT EXISTS idx_trips_vehicle ON trips (vehicle_id)")

    # ---- Unit credentials ----------------------------------------------------
    # The driver token used to be derived from the call sign, so anyone who knew
    # a call sign could act as that unit. It is now a random secret issued per
    # vehicle, stored only as a digest. Existing rows are backfilled by
    # `unit_tokens.backfill` during application startup.
    vehicle_columns = {row["name"] for row in db.execute("PRAGMA table_info(vehicles)")}
    for column, ddl in (("token_hash", "TEXT"), ("token_issued_at", "TEXT")):
        if column not in vehicle_columns:
            db.execute(f"ALTER TABLE vehicles ADD COLUMN {column} {ddl}")
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_token_hash "
        "ON vehicles (token_hash) WHERE token_hash IS NOT NULL"
    )

    # ---- Phase B tables -----------------------------------------------------
    # A provider answer, kept so two screens asking for the same pair do not
    # spend two provider calls.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS route_cache (
            cache_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    # Every recalculation of an emergency route is its own row, so a disputed
    # path can be replayed later. superseded_by points at the replacement.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS emergency_routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            geometry_json TEXT NOT NULL,
            distance_m REAL,
            duration_s REAL,
            reason TEXT,
            computed_at TEXT NOT NULL,
            superseded_by INTEGER REFERENCES emergency_routes (id)
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_routes_trip ON emergency_routes (trip_id)"
    )
    # Idempotency for driver transitions: the same client_event_id is applied
    # once, no matter how many times a flaky phone retries it.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS client_events (
            client_event_id TEXT PRIMARY KEY,
            trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    # ---- Phase B: administrators, sessions, audit ---------------------------
    # Roles are stored, never trusted from a request. A role is an enum by
    # CHECK, so a bad write fails at the database rather than in a route.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            name TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'EMERGENCY_OPERATOR', 'VIEWER')),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
            created_at TEXT NOT NULL,
            updated_at TEXT,
            last_login_at TEXT
        )
        """
    )
    # Server-side sessions. Only the SHA-256 digest of the cookie token is
    # stored, so a database copy cannot be replayed as a login.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            csrf_token TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_seen_at TEXT,
            ip TEXT,
            user_agent TEXT,
            revoked_at TEXT
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions (admin_id)"
    )
    # Login attempts drive the brute-force limiter. They are kept short-lived
    # and pruned on every successful sign-in.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            ip TEXT,
            outcome TEXT NOT NULL,
            attempted_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_login_attempts ON admin_login_attempts (email, attempted_at)"
    )
    # Append-only operational audit. Triggers make the immutability a property
    # of the database, not a convention in application code.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            actor_id INTEGER,
            actor_role TEXT,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL DEFAULT 'success',
            trip_id INTEGER,
            session_id INTEGER,
            ip TEXT,
            detail_json TEXT
        )
        """
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_audit_trip ON audit_log (trip_id)")
    db.execute(
        """
        CREATE TRIGGER IF NOT EXISTS audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
            SELECT RAISE(ABORT, 'audit log is append-only');
        END
        """
    )
    db.execute(
        """
        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
            SELECT RAISE(ABORT, 'audit log is append-only');
        END
        """
    )

    # ---- Phase B: emergency sessions ---------------------------------------
    # One session per response. `trips.status` stays authoritative; `state` is
    # its projection, written in the same transaction by update_status().
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS emergency_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL UNIQUE REFERENCES trips (id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (state IN ('CREATED', 'VERIFIED', 'ACTIVE', 'ON_SCENE', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
            activated_at TEXT,
            activated_by_kind TEXT,
            activated_by_id TEXT,
            verified_at TEXT,
            verified_by_kind TEXT,
            verified_by_id TEXT,
            closed_at TEXT,
            close_reason TEXT,
            expires_at TEXT,
            last_seen_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_state ON emergency_sessions (state)"
    )
    # Every lifecycle move, with who did it and why. Separate from trip_events
    # because it carries actor identity, which trip_events deliberately does not.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS emergency_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES emergency_sessions (id) ON DELETE CASCADE,
            trip_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            from_state TEXT,
            to_state TEXT NOT NULL,
            actor_kind TEXT NOT NULL,
            actor_id TEXT,
            actor_role TEXT,
            reason TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_transitions_session ON emergency_transitions (session_id)"
    )

    # ---- Phase C: GPS telemetry ---------------------------------------------
    # Every accepted fix, with the phone's own timestamp and the server's receipt
    # time kept apart. `client_fix_id` is UNIQUE, which is what makes a retried
    # batch a no-op instead of a duplicate trail.
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS telemetry_fixes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
            session_id INTEGER REFERENCES emergency_sessions (id) ON DELETE SET NULL,
            vehicle_id INTEGER,
            client_fix_id TEXT UNIQUE,
            sequence INTEGER,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            accuracy_m REAL,
            heading_deg REAL,
            speed_mps REAL,
            device_time TEXT NOT NULL,
            received_at TEXT NOT NULL,
            quality TEXT NOT NULL DEFAULT 'good',
            -- Where the fix came from: gps, network, manual or simulated. An
            -- imported or replayed row must never look like a live reading.
            source TEXT NOT NULL DEFAULT 'gps'
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_fixes_trip ON telemetry_fixes (trip_id, id)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_fixes_received ON telemetry_fixes (received_at)"
    )

    # The latest trusted position, one row per response. Separate from the trail
    # so the admin map reads one row per vehicle instead of scanning history, and
    # so an older fix can never overwrite a newer one (the upsert has a WHERE).
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS vehicle_positions (
            trip_id INTEGER PRIMARY KEY REFERENCES trips (id) ON DELETE CASCADE,
            session_id INTEGER REFERENCES emergency_sessions (id) ON DELETE SET NULL,
            vehicle_id INTEGER,
            last_fix_id INTEGER REFERENCES telemetry_fixes (id) ON DELETE SET NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            accuracy_m REAL,
            heading_deg REAL,
            speed_mps REAL,
            device_time TEXT NOT NULL,
            received_at TEXT NOT NULL,
            sequence INTEGER,
            client_fix_id TEXT,
            quality TEXT NOT NULL DEFAULT 'good',
            source TEXT NOT NULL DEFAULT 'gps',
            updated_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_positions_updated ON vehicle_positions (updated_at)"
    )

    # Route quality as seen by the operator: an explicit 'degraded' beats a
    # straight line silently pretending to be a road.
    for column, ddl in (
        ("route_quality", "TEXT"),
        ("route_deviation_m", "REAL"),
        ("route_recalculated_at", "TEXT"),
    ):
        if column not in existing_trip_columns:
            db.execute(f"ALTER TABLE trips ADD COLUMN {column} {ddl}")

    # A database created by an earlier Phase C build has `telemetry_fixes`
    # without `source`. ALTER is guarded by a column check so this stays
    # repeatable, which is what lets `init_db()` double as the migration.
    fix_columns = {row["name"] for row in db.execute("PRAGMA table_info(telemetry_fixes)")}
    if fix_columns and "source" not in fix_columns:
        db.execute("ALTER TABLE telemetry_fixes ADD COLUMN source TEXT NOT NULL DEFAULT 'gps'")

    # Backfill: every existing response gets a session in the state its status
    # already implies. INSERT OR IGNORE makes this safe to run on every boot.
    db.execute(
        """
        INSERT OR IGNORE INTO emergency_sessions
            (trip_id, state, created_at, updated_at)
        SELECT
            id,
            CASE status
                WHEN 'scheduled' THEN 'CREATED'
                WHEN 'accepted' THEN 'VERIFIED'
                WHEN 'in_transit' THEN 'ACTIVE'
                WHEN 'on_scene' THEN 'ON_SCENE'
                WHEN 'completed' THEN 'COMPLETED'
                ELSE 'CANCELLED'
            END,
            created_at,
            created_at
        FROM trips
        """
    )


def init_db():
    os.makedirs(current_app.instance_path, exist_ok=True)
    db = get_db()
    db.executescript(SCHEMA)
    with db:
        _migrate(db)
        for key, value in DEFAULT_SETTINGS.items():
            db.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0)


def stamp(moment):
    """Format a datetime the way this database stores timestamps.

    Every stored timestamp goes through `iso_now`, which writes whole seconds in
    UTC. Code that compares stored strings (the login throttle, the expiry
    watchdog) must use this function rather than `isoformat()`, which produces a
    different string and would compare incorrectly.
    """
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def iso_now():
    return stamp(utcnow())


def parse_dt(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _column(row, name, fallback=None):
    """Read a column that a partially-migrated database may not have yet."""
    try:
        return row[name]
    except (IndexError, KeyError):
        return fallback


def _stored_route(row):
    raw = _column(row, "route_json")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, list):
        return None
    points = []
    for item in parsed:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            try:
                points.append([float(item[0]), float(item[1])])
            except (TypeError, ValueError):
                continue
    return points or None


def serialise_trip(row):
    if row is None:
        return None
    has_origin = row["origin_lat"] is not None and row["origin_lng"] is not None
    has_destination = (
        row["destination_lat"] is not None and row["destination_lng"] is not None
    )
    existing_columns = set(row.keys())
    stored_geocode_status = (
        row["geocode_status"] if "geocode_status" in existing_columns else None
    )
    geocode_message = (
        row["geocode_message"] if "geocode_message" in existing_columns else None
    )
    geocoded_at = row["geocoded_at"] if "geocoded_at" in existing_columns else None
    if has_origin and has_destination:
        coordinate_status = "resolved"
    elif stored_geocode_status:
        coordinate_status = stored_geocode_status
    elif has_origin or has_destination:
        coordinate_status = "partial"
    else:
        coordinate_status = "missing"
    waypoints = []
    if row["waypoints_json"]:
        try:
            parsed = json.loads(row["waypoints_json"])
            if isinstance(parsed, list):
                waypoints = [str(item) for item in parsed if str(item).strip()]
        except (TypeError, ValueError):
            waypoints = []
    return {
        "id": row["id"],
        "reference": row["reference"],
        "name": row["name"],
        "incident_reference": row["incident_reference"],
        "emergency_type": row["emergency_type"],
        "emergency_type_label": EMERGENCY_META.get(row["emergency_type"], {}).get(
            "label"
        ),
        "dispatch_at": row["dispatch_at"],
        "instructions": row["instructions"],
        "notes": row["notes"],
        "waypoints": waypoints,
        "vehicle_id": row["vehicle_id"],
        "origin_place_id": row["origin_place_id"],
        "destination_place_id": row["destination_place_id"],
        "origin": row["origin"],
        "destination": row["destination"],
        "priority": row["priority"],
        "priority_label": PRIORITY_META.get(row["priority"], {}).get(
            "label", row["priority"].title()
        ),
        "status": row["status"],
        "status_label": STATUS_META.get(row["status"], {}).get(
            "label", row["status"].title()
        ),
        "distance_km": row["distance_km"],
        "duration_min": row["duration_min"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
        "cancelled_at": row["cancelled_at"],
        "origin_coords": [row["origin_lat"], row["origin_lng"]]
        if has_origin
        else None,
        "destination_coords": [row["destination_lat"], row["destination_lng"]]
        if has_destination
        else None,
        "has_coordinates": has_origin and has_destination,
        "geocode_status": coordinate_status,
        "geocode_message": geocode_message,
        "geocoded_at": geocoded_at,
        "route": _stored_route(row),
        "route_provider": _column(row, "route_provider"),
        "route_distance_m": _column(row, "route_distance_m"),
        "url": f"/trips/{row['id']}",
    }


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def get_settings():
    values = dict(DEFAULT_SETTINGS)
    rows = get_db().execute("SELECT key, value FROM settings").fetchall()
    values.update({row["key"]: row["value"] for row in rows})
    return values


def _forget_cached_settings():
    """Drop the per-context settings cache after a write.

    `app._settings()` caches the row set on `g` for the duration of a request.
    Saving inside that request must not leave the caller reading its own stale
    copy, so the cache is cleared here rather than in the settings view.
    """
    try:
        g.settings = None
    except RuntimeError:
        pass


def save_settings(values):
    db = get_db()
    with db:
        for key, value in values.items():
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)),
            )
    _forget_cached_settings()


def reset_settings():
    db = get_db()
    with db:
        db.execute("DELETE FROM settings")
        for key, value in DEFAULT_SETTINGS.items():
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?)", (key, value)
            )
    _forget_cached_settings()


# ---------------------------------------------------------------------------
# Response resources
# ---------------------------------------------------------------------------


def _vehicle_row(row):
    item = dict(row)
    # The digest is never rendered or serialised; templates only need to know
    # whether a unit currently holds a credential.
    item.pop("token_hash", None)
    item["has_token"] = bool(row["token_hash"])
    type_meta = VEHICLE_TYPES.get(item["vehicle_type"], {})
    item["type_label"] = type_meta.get("label", item["vehicle_type"].replace("_", " ").title())
    item["status_label"] = VEHICLE_STATUS_META.get(item["status"], {}).get(
        "label", item["status"].replace("_", " ").title()
    )
    item["available"] = None
    item["reason"] = None
    return item


def _personnel_row(row):
    item = dict(row)
    item["role_label"] = PERSONNEL_ROLES.get(item["role"], {}).get(
        "label", item["role"].replace("_", " ").title()
    )
    item["status_label"] = PERSONNEL_STATUS_META.get(item["status"], {}).get(
        "label", item["status"].replace("_", " ").title()
    )
    item["available"] = None
    item["reason"] = None
    return item


def list_vehicles():
    rows = get_db().execute(
        "SELECT * FROM vehicles ORDER BY call_sign COLLATE NOCASE"
    ).fetchall()
    return [_vehicle_row(row) for row in rows]


def get_vehicle(vehicle_id):
    row = get_db().execute(
        "SELECT * FROM vehicles WHERE id = ?", (vehicle_id,)
    ).fetchone()
    return _vehicle_row(row) if row is not None else None


def create_vehicle(
    *, call_sign, vehicle_type, registration=None, base_location=None, status="available", notes=None
):
    now = iso_now()
    with get_db() as db:
        cursor = db.execute(
            """
            INSERT INTO vehicles (call_sign, vehicle_type, registration, base_location, status, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (call_sign, vehicle_type, registration, base_location, status, notes, now),
        )
    return cursor.lastrowid


def vehicles_without_token():
    """Vehicles that still need a credential issued by the migration."""
    return [
        _vehicle_row(row)
        for row in get_db().execute(
            "SELECT * FROM vehicles WHERE token_hash IS NULL ORDER BY id"
        ).fetchall()
    ]


def vehicle_for_token_hash(token_hash):
    """The vehicle holding this credential digest, or None.

    A unit that leaves the registry stops authenticating because the row is
    gone; a unit whose credential was revoked has a NULL digest.
    """
    if not token_hash:
        return None
    row = get_db().execute(
        "SELECT * FROM vehicles WHERE token_hash = ?", (token_hash,)
    ).fetchone()
    return _vehicle_row(row) if row is not None else None


def set_vehicle_token(vehicle_id, token_hash, issued_at=None):
    """Store a new credential digest, replacing any previous one."""
    with get_db() as db:
        cursor = db.execute(
            "UPDATE vehicles SET token_hash = ?, token_issued_at = ? WHERE id = ?",
            (token_hash, issued_at or iso_now(), vehicle_id),
        )
    return cursor.rowcount > 0


def clear_vehicle_token(vehicle_id):
    """Revoke: the unit keeps its history but can no longer authenticate."""
    with get_db() as db:
        cursor = db.execute(
            "UPDATE vehicles SET token_hash = NULL, token_issued_at = NULL WHERE id = ?",
            (vehicle_id,),
        )
    return cursor.rowcount > 0


def update_vehicle_status(vehicle_id, status):
    if status not in VEHICLE_STATUS_META:
        raise ValueError("Choose a valid vehicle status.")
    if get_vehicle(vehicle_id) is None:
        raise LookupError("Vehicle not found.")
    with get_db() as db:
        db.execute("UPDATE vehicles SET status = ? WHERE id = ?", (status, vehicle_id))


def list_personnel():
    rows = get_db().execute(
        "SELECT * FROM personnel ORDER BY name COLLATE NOCASE"
    ).fetchall()
    return [_personnel_row(row) for row in rows]


def get_personnel(personnel_id):
    row = get_db().execute(
        "SELECT * FROM personnel WHERE id = ?", (personnel_id,)
    ).fetchone()
    return _personnel_row(row) if row is not None else None


def create_personnel(
    *, employee_id, name, role, base_location=None, status="on_duty"
):
    now = iso_now()
    with get_db() as db:
        cursor = db.execute(
            """
            INSERT INTO personnel (employee_id, name, role, base_location, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (employee_id, name, role, base_location, status, now),
        )
    return cursor.lastrowid


def update_personnel_status(personnel_id, status):
    if status not in PERSONNEL_STATUS_META:
        raise ValueError("Choose a valid personnel status.")
    if get_personnel(personnel_id) is None:
        raise LookupError("Personnel record not found.")
    with get_db() as db:
        db.execute("UPDATE personnel SET status = ? WHERE id = ?", (status, personnel_id))


def trip_assignment(trip_id):
    db = get_db()
    vehicle = db.execute(
        "SELECT v.* FROM vehicles v JOIN trips t ON t.vehicle_id = v.id WHERE t.id = ?",
        (trip_id,),
    ).fetchone()
    crew = db.execute(
        """
        SELECT p.*, tc.role_on_response
        FROM trip_crew tc JOIN personnel p ON p.id = tc.personnel_id
        WHERE tc.trip_id = ?
        ORDER BY p.name COLLATE NOCASE
        """,
        (trip_id,),
    ).fetchall()
    return {
        "vehicle": _vehicle_row(vehicle) if vehicle is not None else None,
        "crew": [_personnel_row(row) for row in crew],
    }


def _assignment_windows(resource):
    db = get_db()
    if resource == "vehicle":
        rows = db.execute(
            """
            SELECT t.id, t.reference, t.status, t.dispatch_at, t.started_at,
                   t.created_at, t.duration_min, t.vehicle_id AS resource_id
            FROM trips t
            WHERE t.status IN ('scheduled', 'accepted', 'in_transit', 'on_scene')
              AND t.vehicle_id IS NOT NULL
            """
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT t.id, t.reference, t.status, t.dispatch_at, t.started_at,
                   t.created_at, t.duration_min, tc.personnel_id AS resource_id
            FROM trip_crew tc JOIN trips t ON t.id = tc.trip_id
            WHERE t.status IN ('scheduled', 'accepted', 'in_transit', 'on_scene')
            """
        ).fetchall()

    windows = []
    for row in rows:
        # Accepted crews have not departed yet but are already committed, and
        # on-scene crews remain committed until the response is completed.
        if row["status"] in ("accepted", "in_transit", "on_scene"):
            start = parse_dt(
                row["started_at"] or row["dispatch_at"] or row["created_at"]
            )
        else:
            start = parse_dt(
                row["dispatch_at"] or row["started_at"] or row["created_at"]
            )
        if start is None:
            continue
        minutes = max(30, min(int(row["duration_min"] or 120), 720))
        end = start + timedelta(minutes=minutes)
        if row["status"] in ("accepted", "in_transit", "on_scene"):
            end = max(end, utcnow() + timedelta(minutes=60))
        windows.append((row["resource_id"], start, end, row["reference"], row["id"]))
    return windows


def _conflict(windows, resource_id, start, end, exclude_trip_id=None):
    for assigned_id, assigned_start, assigned_end, reference, trip_id in windows:
        if exclude_trip_id is not None and trip_id == exclude_trip_id:
            continue
        if assigned_id == resource_id and assigned_start < end and assigned_end > start:
            return reference, assigned_end
    return None


def resource_availability(
    *, dispatch_at=None, duration_min=None, emergency_type=None, exclude_trip_id=None
):
    start = parse_dt(dispatch_at) if dispatch_at else utcnow()
    if start is None:
        start = utcnow()
    minutes = max(30, min(int(duration_min or 120), 720))
    end = start + timedelta(minutes=minutes)

    vehicle_windows = _assignment_windows("vehicle")
    crew_windows = _assignment_windows("personnel")
    vehicles = []
    for vehicle in list_vehicles():
        reason = None
        if vehicle["status"] != "available":
            reason = vehicle["status_label"]
        elif emergency_type and emergency_type not in VEHICLE_TYPES.get(
            vehicle["vehicle_type"], {}
        ).get("suitable_for", []):
            label = EMERGENCY_META.get(emergency_type, {}).get("short", "this response")
            reason = f"Not suitable for {label.lower()}"
        else:
            conflict = _conflict(
                vehicle_windows, vehicle["id"], start, end, exclude_trip_id
            )
            if conflict:
                reference, until = conflict
                reason = f"Assigned to {reference} until {until.strftime('%d %b %H:%M')} UTC"
        vehicle["available"] = reason is None
        vehicle["reason"] = reason
        vehicles.append(vehicle)

    personnel = []
    for member in list_personnel():
        reason = None
        if member["status"] != "on_duty":
            reason = member["status_label"]
        else:
            conflict = _conflict(
                crew_windows, member["id"], start, end, exclude_trip_id
            )
            if conflict:
                reference, until = conflict
                reason = f"Assigned to {reference} until {until.strftime('%d %b %H:%M')} UTC"
        member["available"] = reason is None
        member["reason"] = reason
        personnel.append(member)

    return {
        "start": start.strftime("%Y-%m-%d %H:%M:%S"),
        "end": end.strftime("%Y-%m-%d %H:%M:%S"),
        "duration_min": minutes,
        "emergency_type": emergency_type,
        "vehicles": vehicles,
        "personnel": personnel,
        "available_vehicles": sum(1 for item in vehicles if item["available"]),
        "available_personnel": sum(1 for item in personnel if item["available"]),
    }


def registry_counts():
    db = get_db()
    vehicles = db.execute("SELECT COUNT(*) AS total FROM vehicles").fetchone()["total"]
    on_duty = db.execute(
        "SELECT COUNT(*) AS total FROM personnel WHERE status = 'on_duty'"
    ).fetchone()["total"]
    personnel = db.execute("SELECT COUNT(*) AS total FROM personnel").fetchone()["total"]
    return {"vehicles": vehicles, "personnel": personnel, "on_duty": on_duty}


# ---------------------------------------------------------------------------
# Trips
# ---------------------------------------------------------------------------


def _insert_event(db, trip_id, kind, message, timestamp):
    db.execute(
        "INSERT INTO trip_events (trip_id, kind, message, created_at) "
        "VALUES (?, ?, ?, ?)",
        (trip_id, kind, message, timestamp),
    )


def create_trip(
    *,
    origin,
    destination,
    priority,
    status,
    distance_km=None,
    duration_min=None,
    origin_lat=None,
    origin_lng=None,
    destination_lat=None,
    destination_lng=None,
    name=None,
    emergency_type=None,
    dispatch_at=None,
    instructions=None,
    notes=None,
    waypoints=None,
    vehicle_id=None,
    crew_ids=None,
    origin_place_id=None,
    destination_place_id=None,
):
    db = get_db()
    now = iso_now()
    started_at = now if status == "in_transit" else None
    waypoints_json = json.dumps(waypoints) if waypoints else None
    with db:
        cursor = db.execute(
            """
            INSERT INTO trips (
                reference, origin, destination, priority, status,
                distance_km, duration_min,
                origin_lat, origin_lng, destination_lat, destination_lng,
                created_at, started_at, name, emergency_type, dispatch_at,
                instructions, notes, waypoints_json, vehicle_id,
                origin_place_id, destination_place_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "TRP-pending",
                origin,
                destination,
                priority,
                status,
                distance_km,
                duration_min,
                origin_lat,
                origin_lng,
                destination_lat,
                destination_lng,
                now,
                started_at,
                name,
                emergency_type,
                dispatch_at,
                instructions,
                notes,
                waypoints_json,
                vehicle_id,
                origin_place_id,
                destination_place_id,
            ),
        )
        trip_id = cursor.lastrowid
        reference = f"TRP-{1000 + trip_id}"
        incident_reference = f"INC-{now[:4]}-{trip_id:05d}"
        db.execute(
            "UPDATE trips SET reference = ?, incident_reference = ? WHERE id = ?",
            (reference, incident_reference, trip_id),
        )
        for personnel_id in crew_ids or []:
            db.execute(
                "INSERT OR IGNORE INTO trip_crew (trip_id, personnel_id) VALUES (?, ?)",
                (trip_id, personnel_id),
            )
        _insert_event(
            db,
            trip_id,
            "created",
            f"Response assignment recorded from {origin} to {destination}.",
            now,
        )
        if status == "in_transit":
            _insert_event(db, trip_id, "started", "Response dispatched.", now)
        elif status == "cancelled":
            _insert_event(db, trip_id, "cancelled", "Response cancelled.", now)
        # The emergency session is created with the response, in the state its
        # starting status already implies. Creating it here (inside the same
        # transaction) is what makes "every response has a session" a fact.
        _sync_session(db, trip_id, status, action="create", now=now)
    return trip_id


def get_trip(trip_id):
    return get_db().execute(
        "SELECT * FROM trips WHERE id = ?", (trip_id,)
    ).fetchone()


def get_trip_by_reference(reference):
    return get_db().execute(
        "SELECT * FROM trips WHERE reference = ?", (reference,)
    ).fetchone()


def _where_clause(query=None, status=None, priority=None):
    clauses = []
    params = []
    if query:
        clauses.append(
            "(origin LIKE ? COLLATE NOCASE OR destination LIKE ? COLLATE NOCASE "
            "OR reference LIKE ? COLLATE NOCASE)"
        )
        wildcard = f"%{query}%"
        params.extend([wildcard, wildcard, wildcard])
    if status and status != "all":
        if status not in STATUS_ORDER:
            raise ValueError(f"Unknown trip status: {status}")
        clauses.append("status = ?")
        params.append(status)
    if priority and priority != "all":
        clauses.append("priority = ?")
        params.append(priority)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


SORTS = {
    "newest": "created_at DESC, id DESC",
    "oldest": "created_at ASC, id ASC",
    "distance": "distance_km IS NULL, distance_km DESC",
    "duration": "duration_min IS NULL, duration_min DESC",
    "priority": "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at DESC",
}


def list_trips(query=None, status=None, priority=None, sort="newest", limit=None, offset=0):
    where, params = _where_clause(query, status, priority)
    order = SORTS.get(sort, SORTS["newest"])
    sql = f"SELECT * FROM trips {where} ORDER BY {order}"
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
    return get_db().execute(sql, params).fetchall()


def list_open_trips(limit=None):
    """Open responses for the dispatch queue, newest first (existing order)."""
    placeholders = ", ".join("?" for _ in OPEN_STATUSES)
    sql = (
        f"SELECT * FROM trips WHERE status IN ({placeholders}) "
        "ORDER BY created_at DESC, id DESC"
    )
    params = list(OPEN_STATUSES)
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return get_db().execute(sql, params).fetchall()


def count_trips(query=None, status=None, priority=None):
    where, params = _where_clause(query, status, priority)
    row = get_db().execute(
        f"SELECT COUNT(*) AS total FROM trips {where}", params
    ).fetchone()
    return row["total"]


def status_counts():
    counts = {status: 0 for status in STATUS_ORDER}
    for row in get_db().execute(
        "SELECT status, COUNT(*) AS total FROM trips GROUP BY status"
    ).fetchall():
        if row["status"] in counts:
            counts[row["status"]] = row["total"]
    counts["all"] = sum(counts[status] for status in STATUS_ORDER)
    counts["open"] = sum(counts[status] for status in OPEN_STATUSES)
    return counts


def data_counts():
    db = get_db()
    trips = db.execute("SELECT COUNT(*) AS total FROM trips").fetchone()["total"]
    events = db.execute("SELECT COUNT(*) AS total FROM trip_events").fetchone()[
        "total"
    ]
    return {"trips": trips, "events": events}


class StaleTransition(Exception):
    """Raised when a conditional status write loses a race with another writer.

    Carries the status that won, so the caller can tell the operator what the
    response actually is now instead of overwriting it.
    """

    def __init__(self, current_status):
        super().__init__("The response changed before this update was applied.")
        self.current_status = current_status


#: One row per lifecycle action: where it may start, where it ends, which
#: timestamp it stamps and the human sentence written to the event log.
#: The messages are the ones Phase A already produced, so nothing downstream
#: has to relearn them.
ACTION_SPECS = {
    "accept": {
        "sources": ("scheduled",),
        "target": "accepted",
        "column": None,
        "kind": "accepted",
        "message": "Response accepted by the assigned crew.",
        "error": "Only scheduled responses can be accepted.",
    },
    "start": {
        "sources": ("scheduled",),
        "target": "in_transit",
        "column": "started_at",
        "kind": "started",
        "message": "Trip started.",
        "error": "Only scheduled responses can be started.",
    },
    "depart": {
        "sources": ("accepted",),
        "target": "in_transit",
        "column": "started_at",
        "kind": "departed",
        "message": "Crew departed for the incident.",
        "error": "Only accepted responses can depart.",
    },
    "arrive": {
        "sources": ("in_transit",),
        "target": "on_scene",
        "column": None,
        "kind": "arrived",
        "message": "Crew arrived on scene.",
        "error": "Only responses en route can arrive on scene.",
    },
    "complete": {
        "sources": ("in_transit", "on_scene"),
        "target": "completed",
        "column": "completed_at",
        "kind": "completed",
        "message": "Trip completed and closed.",
        "error": "Only responses en route or on scene can be completed.",
    },
    "cancel": {
        "sources": tuple(OPEN_STATUSES),
        "target": "cancelled",
        "column": "cancelled_at",
        "kind": "cancelled",
        "message": "Trip cancelled.",
        "error": "This trip is already closed.",
    },
}


def update_status(
    trip_id,
    action,
    *,
    expected_status=None,
    actor_kind="system",
    actor_id=None,
    actor_role=None,
    reason=None,
    lifecycle_action=None,
):
    """Apply a lifecycle action atomically. Returns the updated row.

    The status write is a single conditional UPDATE: the row only moves if it is
    still in a state the action accepts. Two operators pressing "cancel" at the
    same moment therefore produce one change and one `StaleTransition`, never a
    silent overwrite. The event row, the session projection and its transition
    row are written inside the same transaction, so a failure leaves nothing
    behind — the response is never half-moved.
    """
    trip = get_trip(trip_id)
    if trip is None:
        raise LookupError("Trip not found.")

    spec = ACTION_SPECS.get(action)
    if spec is None:
        raise ValueError("Unsupported trip action.")

    current = trip["status"]
    # A caller that named the state it expected gets the more useful answer
    # first: "someone else moved it" beats "that action is not valid now".
    if expected_status and current != expected_status:
        raise StaleTransition(current)
    if current not in spec["sources"]:
        raise ValueError(spec["error"])

    now = iso_now()
    db = get_db()
    assignments = "status = ?"
    params = [spec["target"]]
    if spec["column"]:
        assignments += f", {spec['column']} = ?"
        params.append(now)
    params.append(trip_id)
    params.extend(spec["sources"])
    placeholders = ", ".join("?" for _ in spec["sources"])

    with db:
        cursor = db.execute(
            f"UPDATE trips SET {assignments} WHERE id = ? AND status IN ({placeholders})",
            params,
        )
        if cursor.rowcount != 1:
            latest = get_trip(trip_id)
            raise StaleTransition(latest["status"] if latest else current)

        message = spec["message"]
        if action == "cancel" and (reason or "").strip():
            message = f"Trip cancelled: {reason.strip()[:200]}."
        _insert_event(db, trip_id, spec["kind"], message, now)
        _sync_session(
            db,
            trip_id,
            spec["target"],
            action=(lifecycle_action or action),
            now=now,
            actor_kind=actor_kind,
            actor_id=actor_id,
            actor_role=actor_role,
            reason=(reason or None),
        )

    return get_trip(trip_id)



def save_coordinates(
    trip_id,
    origin_coords,
    destination_coords,
    distance_km=None,
    duration_min=None,
    geocode_message=None,
):
    trip = get_trip(trip_id)
    if trip is None:
        raise LookupError("Trip not found.")

    db = get_db()
    now = iso_now()
    with db:
        db.execute(
            """
            UPDATE trips SET
                origin_lat = ?, origin_lng = ?,
                destination_lat = ?, destination_lng = ?,
                distance_km = COALESCE(?, distance_km),
                duration_min = COALESCE(?, duration_min),
                geocode_status = 'resolved',
                geocode_message = ?,
                geocoded_at = ?
            WHERE id = ?
            """,
            (
                origin_coords[0],
                origin_coords[1],
                destination_coords[0],
                destination_coords[1],
                distance_km,
                duration_min,
                geocode_message,
                now,
                trip_id,
            ),
        )
        _insert_event(
            db,
            trip_id,
            "location",
            "Route coordinates recorded from the trip addresses.",
            now,
        )
    return get_trip(trip_id)


def mark_geocode_status(trip_id, status, message=None):
    """Persist an unresolved lookup outcome without changing coordinates."""
    trip = get_trip(trip_id)
    if trip is None:
        raise LookupError("Trip not found.")
    with get_db() as db:
        db.execute(
            """
            UPDATE trips SET geocode_status = ?, geocode_message = ?,
                geocoded_at = ?
            WHERE id = ?
            """,
            (status, message, iso_now(), trip_id),
        )
    return get_trip(trip_id)


def get_geocode_cache(cache_key):
    row = get_db().execute(
        "SELECT * FROM geocode_cache WHERE cache_key = ?", (cache_key,)
    ).fetchone()
    return dict(row) if row is not None else None


def save_geocode_cache(
    cache_key,
    address_text,
    context_key_value,
    status,
    lat=None,
    lng=None,
    display_name=None,
    provider="nominatim",
    provider_ref=None,
    message=None,
):
    now = iso_now()
    with get_db() as db:
        db.execute(
            """
            INSERT INTO geocode_cache (
                cache_key, address_text, context_key, status, lat, lng,
                display_name, provider, provider_ref, message, attempted_at,
                resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                address_text = excluded.address_text,
                context_key = excluded.context_key,
                status = excluded.status,
                lat = excluded.lat,
                lng = excluded.lng,
                display_name = excluded.display_name,
                provider = excluded.provider,
                provider_ref = excluded.provider_ref,
                message = excluded.message,
                attempted_at = excluded.attempted_at,
                resolved_at = excluded.resolved_at
            """,
            (
                cache_key,
                address_text,
                context_key_value,
                status,
                lat,
                lng,
                display_name,
                provider,
                provider_ref,
                message,
                now,
                now if status == "resolved" else None,
            ),
        )
    return get_geocode_cache(cache_key)


def trip_events(trip_id):
    return get_db().execute(
        "SELECT * FROM trip_events WHERE trip_id = ? ORDER BY created_at ASC, id ASC",
        (trip_id,),
    ).fetchall()


def recent_events(limit=6):
    return get_db().execute(
        """
        SELECT e.*, t.reference, t.origin, t.destination, t.status
        FROM trip_events e
        JOIN trips t ON t.id = e.trip_id
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


# ---------------------------------------------------------------------------
# Aggregates
# ---------------------------------------------------------------------------


def dashboard_summary():
    counts = status_counts()
    db = get_db()
    distance = db.execute(
        "SELECT COALESCE(SUM(distance_km), 0) AS total FROM trips WHERE distance_km IS NOT NULL"
    ).fetchone()["total"]
    routed = db.execute(
        "SELECT COUNT(*) AS total FROM trips WHERE distance_km IS NOT NULL"
    ).fetchone()["total"]
    last = db.execute(
        "SELECT MAX(created_at) AS latest FROM trip_events"
    ).fetchone()["latest"]
    total = counts["all"]
    completed = counts["completed"]
    return {
        "total": total,
        "in_transit": counts["in_transit"],
        "scheduled": counts["scheduled"],
        "accepted": counts["accepted"],
        "on_scene": counts["on_scene"],
        "completed": completed,
        "cancelled": counts["cancelled"],
        "open": counts["open"],
        "distance_km": round(distance or 0, 1),
        "routed_trips": routed,
        "completion_rate": round((completed / total) * 100, 1) if total else None,
        "last_recorded_at": last,
    }


def _pct_change(current, previous):
    if previous in (None, 0):
        return None
    return round(((current - previous) / previous) * 100, 1)


def analytics(range_key="30", status="all"):
    db = get_db()
    today = utcnow().date()

    if range_key == "all":
        first = db.execute("SELECT MIN(created_at) AS first FROM trips").fetchone()[
            "first"
        ]
        start_date = parse_dt(first).date() if first else today - timedelta(days=29)
        start_date = max(start_date, today - timedelta(days=179))
        days = (today - start_date).days + 1
        range_label = "All recorded time"
    else:
        try:
            days = int(range_key)
        except (TypeError, ValueError):
            days = 30
        days = days if days in (7, 30, 90) else 30
        start_date = today - timedelta(days=days - 1)
        range_label = f"Last {days} days"

    start_iso = start_date.strftime("%Y-%m-%d 00:00:00")
    previous_start = start_date - timedelta(days=days)
    previous_iso = previous_start.strftime("%Y-%m-%d 00:00:00")

    rows = db.execute(
        "SELECT * FROM trips WHERE created_at >= ? ORDER BY created_at ASC",
        (start_iso,),
    ).fetchall()
    previous_rows = db.execute(
        "SELECT * FROM trips WHERE created_at >= ? AND created_at < ?",
        (previous_iso, start_iso),
    ).fetchall()

    def keep(row):
        return status == "all" or row["status"] == status

    filtered = [row for row in rows if keep(row)]
    previous_filtered = [row for row in previous_rows if keep(row)]

    def summarise(subset):
        counts = {key: 0 for key in STATUS_ORDER}
        for row in subset:
            if row["status"] in counts:
                counts[row["status"]] += 1
        routed = [row for row in subset if row["distance_km"] is not None]
        distance = round(sum(row["distance_km"] for row in routed), 1)
        durations = [
            row["duration_min"] for row in subset if row["duration_min"] is not None
        ]
        total = len(subset)
        return {
            "total": total,
            "counts": counts,
            "completed": counts["completed"],
            "distance_km": distance,
            "routed_trips": len(routed),
            "avg_distance_km": round(distance / len(routed), 1) if routed else None,
            "avg_duration_min": round(sum(durations) / len(durations))
            if durations
            else None,
            "completion_rate": round((counts["completed"] / total) * 100, 1)
            if total
            else None,
        }

    summary = summarise(filtered)
    previous_summary = summarise(previous_filtered)

    # Day buckets for the chart, capped to the selected window.
    buckets = {}
    cursor = start_date
    while cursor <= today:
        buckets[cursor.isoformat()] = {
            "date": cursor.isoformat(),
            "label": cursor.strftime("%d %b"),
            "trips": 0,
            "completed": 0,
            "distance": 0.0,
        }
        cursor += timedelta(days=1)

    for row in filtered:
        created = parse_dt(row["created_at"])
        key = created.date().isoformat() if created else None
        if key in buckets:
            buckets[key]["trips"] += 1
            if row["status"] == "completed":
                buckets[key]["completed"] += 1
            buckets[key]["distance"] = round(
                buckets[key]["distance"] + (row["distance_km"] or 0), 1
            )

    series = list(buckets.values())

    status_breakdown = []
    for key in STATUS_ORDER:
        count = sum(1 for row in rows if row["status"] == key)
        status_breakdown.append(
            {
                "key": key,
                "label": STATUS_META[key]["label"],
                "count": count,
                "percent": round((count / len(rows)) * 100, 1) if rows else 0,
            }
        )

    priority_breakdown = []
    for key in PRIORITY_ORDER:
        count = sum(1 for row in rows if row["priority"] == key)
        priority_breakdown.append(
            {
                "key": key,
                "label": PRIORITY_META[key]["label"],
                "count": count,
                "percent": round((count / len(rows)) * 100, 1) if rows else 0,
            }
        )

    return {
        "range": range_key if range_key == "all" else str(days),
        "range_label": range_label,
        "status": status,
        "start_date": start_date.isoformat(),
        "end_date": today.isoformat(),
        "summary": summary,
        "previous": previous_summary,
        "change": {
            "trips": _pct_change(summary["total"], previous_summary["total"]),
            "completed": _pct_change(
                summary["completed"], previous_summary["completed"]
            ),
            "distance": _pct_change(
                summary["distance_km"], previous_summary["distance_km"]
            ),
        },
        "series": series,
        "status_breakdown": status_breakdown,
        "priority_breakdown": priority_breakdown,
        "generated_at": iso_now(),
    }


def map_trips(limit=200):
    return [
        serialise_trip(row)
        for row in list_trips(sort="newest", limit=limit)
    ]


# ---------------------------------------------------------------------------
# Routes (Phase B/D): cached provider answers and per-trip geometry
# ---------------------------------------------------------------------------


def route_cache_get(cache_key, ttl_seconds):
    row = get_db().execute(
        "SELECT payload_json, created_at FROM route_cache WHERE cache_key = ?",
        (cache_key,),
    ).fetchone()
    if row is None:
        return None
    try:
        created = parse_dt(row["created_at"])
    except ValueError:
        return None
    if created is None:
        return None
    age = (utcnow() - created).total_seconds()
    if age > ttl_seconds:
        return None
    try:
        payload = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def route_cache_put(cache_key, payload):
    db = get_db()
    with db:
        db.execute(
            """
            INSERT INTO route_cache (cache_key, payload_json, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                created_at = excluded.created_at
            """,
            (cache_key, json.dumps(payload), iso_now()),
        )


def save_route(trip_id, route, reason="initial"):
    """Persist a resolved route on the trip and record it in the audit trail.

    The previous active row is marked superseded, so "what was the path at 14:32"
    stays answerable after a recalculation.
    """
    trip = get_trip(trip_id)
    if trip is None:
        raise LookupError("Trip not found.")

    geometry = route.get("geometry") or []
    if len(geometry) < 2:
        raise ValueError("A route needs at least two points.")

    db = get_db()
    now = iso_now()
    distance_m = route.get("distance_m")
    duration_s = route.get("duration_s")
    provider = route.get("provider") or "unknown"

    with db:
        cursor = db.execute(
            """
            INSERT INTO emergency_routes
                (trip_id, provider, geometry_json, distance_m, duration_s,
                 reason, computed_at, superseded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                trip_id,
                provider,
                json.dumps(geometry),
                distance_m,
                duration_s,
                reason,
                now,
            ),
        )
        new_id = cursor.lastrowid
        db.execute(
            """
            UPDATE emergency_routes
            SET superseded_by = ?
            WHERE trip_id = ? AND id <> ? AND superseded_by IS NULL
            """,
            (new_id, trip_id, new_id),
        )
        db.execute(
            """
            UPDATE trips SET
                route_json = ?, route_provider = ?,
                route_computed_at = ?, route_distance_m = ?,
                distance_km = COALESCE(distance_km, ?),
                duration_min = COALESCE(duration_min, ?)
            WHERE id = ?
            """,
            (
                json.dumps(geometry),
                provider,
                now,
                distance_m,
                None if distance_m is None else round(distance_m / 1000, 2),
                None if duration_s is None else int(round(duration_s / 60)),
                trip_id,
            ),
        )
        _insert_event(
            db,
            trip_id,
            "routed",
            f"Route computed by {provider} ({reason}).",
            now,
        )
    return get_trip(trip_id)


def active_route(trip_id):
    row = get_db().execute(
        """
        SELECT * FROM emergency_routes
        WHERE trip_id = ? AND superseded_by IS NULL
        ORDER BY id DESC LIMIT 1
        """,
        (trip_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        geometry = json.loads(row["geometry_json"])
    except (TypeError, ValueError):
        return None
    return {
        "id": row["id"],
        "provider": row["provider"],
        "geometry": geometry,
        "distance_m": row["distance_m"],
        "duration_s": row["duration_s"],
        "computed_at": row["computed_at"],
        "reason": row["reason"],
    }


# ---------------------------------------------------------------------------
# Driver API (Phase B/E): the crew phone's view of one unit
# ---------------------------------------------------------------------------


#: Which lifecycle actions the phone may offer from each status. Mirrors
#: ACTION_TARGETS in the mobile app, so neither side invents an action.
DRIVER_NEXT_ACTIONS = {
    "scheduled": ["accept"],
    "accepted": ["depart"],
    "in_transit": ["arrive", "complete"],
    "on_scene": ["complete"],
    "completed": [],
    "cancelled": [],
}

#: Statuses a unit can still be carrying.
DRIVER_OPEN_STATUSES = ["scheduled", "accepted", "in_transit", "on_scene"]


def unit_open_trips(vehicle_id):
    db = get_db()
    placeholders = ", ".join("?" for _ in DRIVER_OPEN_STATUSES)
    return db.execute(
        f"""
        SELECT * FROM trips
        WHERE vehicle_id = ? AND status IN ({placeholders})
        ORDER BY id DESC
        """,
        (vehicle_id, *DRIVER_OPEN_STATUSES),
    ).fetchall()


def get_trip_for_unit(trip_id, vehicle_id):
    """A trip, but only if this unit is the one assigned to it.

    This is the authorization boundary for every driver endpoint: a token maps
    to one vehicle, and a vehicle only ever sees its own responses.
    """
    return get_db().execute(
        "SELECT * FROM trips WHERE id = ? AND vehicle_id = ?",
        (trip_id, vehicle_id),
    ).fetchone()


def timeline_for(trip_id):
    rows = get_db().execute(
        """
        SELECT kind, message, created_at
        FROM trip_events WHERE trip_id = ?
        ORDER BY id ASC
        """,
        (trip_id,),
    ).fetchall()
    return [
        {
            "kind": row["kind"],
            "message": row["message"],
            "created_at": row["created_at"],
            "actor": None,
            "source": None,
            "client_at": None,
        }
        for row in rows
    ]


def client_event_seen(client_event_id):
    row = get_db().execute(
        "SELECT status FROM client_events WHERE client_event_id = ?",
        (client_event_id,),
    ).fetchone()
    return None if row is None else row["status"]


def record_client_event(client_event_id, trip_id, action, status):
    db = get_db()
    with db:
        db.execute(
            """
            INSERT OR IGNORE INTO client_events
                (client_event_id, trip_id, action, status, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (client_event_id, trip_id, action, status, iso_now()),
        )


def add_manual_event(trip_id, kind, message):
    """Record something the driver reported, in the same event stream.

    Deliberately does not change status: an issue or a backup request is a
    message to dispatch, not a lifecycle step.
    """
    db = get_db()
    now = iso_now()
    with db:
        _insert_event(db, trip_id, kind, message, now)


def note_client_time(trip_id, action, client_at):
    """Keep the phone's own timestamp next to the server's.

    They differ on a device with a wrong clock, and when they do, the driver's
    account of "I pressed accept before dispatch cancelled it" depends on this
    line existing.
    """
    db = get_db()
    with db:
        _insert_event(
            db,
            trip_id,
            "client-time",
            f"Driver clock at {action}: {client_at}",
            iso_now(),
        )

# ---------------------------------------------------------------------------
# Phase B — emergency session projection
#
# `trips.status` is the single authoritative column. These helpers keep its
# projection in `emergency_sessions` correct, and are called *inside* the
# transaction that writes the status, never on their own from a route.
# ---------------------------------------------------------------------------

SESSION_STATE_ORDER = [
    "CREATED",
    "VERIFIED",
    "ACTIVE",
    "ON_SCENE",
    "COMPLETED",
    "CANCELLED",
    "EXPIRED",
]

#: A session that stays ACTIVE with no telemetry for this long is expired by the
#: watchdog. Phase C supplies the missing writer; the rule lives here.
SESSION_EXPIRY_SECONDS = 120
#: Hard ceiling on an activation, so a forgotten session cannot alert forever.
SESSION_MAX_ACTIVE_SECONDS = 12 * 60 * 60

_STATE_FOR_STATUS = {
    "scheduled": "CREATED",
    "accepted": "VERIFIED",
    "in_transit": "ACTIVE",
    "on_scene": "ON_SCENE",
    "completed": "COMPLETED",
    "cancelled": "CANCELLED",
}

_STATUS_FOR_STATE = {
    "CREATED": "scheduled",
    "VERIFIED": "accepted",
    "ACTIVE": "in_transit",
    "ON_SCENE": "on_scene",
    "COMPLETED": "completed",
    "CANCELLED": "cancelled",
    "EXPIRED": "cancelled",
}


def state_for_trip_status(status):
    """The emergency state a trip status projects to."""
    return _STATE_FOR_STATUS.get(status, "CREATED")


def _sync_session(
    db,
    trip_id,
    status,
    *,
    action,
    now=None,
    actor_kind="system",
    actor_id=None,
    actor_role=None,
    reason=None,
):
    """Write the session projection and its transition row. Transactional.

    Must be called with the open connection `db`, inside the caller's `with db:`
    block, so the status write, the event row and the session projection either
    all land or none do.
    """
    now = now or iso_now()
    state = state_for_trip_status(status)
    if action == "expire":
        # The trip column has no separate "expired" value (Phase A never had
        # one), but the session must remember that this was a watchdog closure
        # rather than an operator decision.
        state = "EXPIRED"

    row = db.execute(
        "SELECT * FROM emergency_sessions WHERE trip_id = ?", (trip_id,)
    ).fetchone()
    if row is None:
        cursor = db.execute(
            """
            INSERT INTO emergency_sessions (trip_id, state, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (trip_id, state, now, now),
        )
        session_id = cursor.lastrowid
        previous_state = None
    else:
        session_id = row["id"]
        previous_state = row["state"]

    fields = {"state": state, "updated_at": now}
    if state == "VERIFIED":
        fields["verified_at"] = now
        fields["verified_by_kind"] = actor_kind
        fields["verified_by_id"] = str(actor_id) if actor_id is not None else None
    elif state == "ACTIVE":
        fields["activated_at"] = now
        fields["activated_by_kind"] = actor_kind
        fields["activated_by_id"] = str(actor_id) if actor_id is not None else None
        fields["last_seen_at"] = now
        fields["expires_at"] = stamp(
            utcnow() + timedelta(seconds=SESSION_MAX_ACTIVE_SECONDS)
        )
        fields["closed_at"] = None
        fields["close_reason"] = None
    elif state in ("COMPLETED", "CANCELLED", "EXPIRED"):
        fields["closed_at"] = now
        fields["close_reason"] = (reason or None)

    assignments = ", ".join(f"{name} = ?" for name in fields)
    db.execute(
        f"UPDATE emergency_sessions SET {assignments} WHERE id = ?",
        list(fields.values()) + [session_id],
    )

    if previous_state != state:
        db.execute(
            """
            INSERT INTO emergency_transitions (
                session_id, trip_id, action, from_state, to_state,
                actor_kind, actor_id, actor_role, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                trip_id,
                action,
                previous_state,
                state,
                actor_kind or "system",
                str(actor_id) if actor_id is not None else None,
                actor_role,
                (reason or None),
                now,
            ),
        )
    return session_id


def sync_emergency_session(trip_id, status, action="resync"):
    """Repair the projection for one response in its own transaction."""
    db = get_db()
    with db:
        return _sync_session(db, trip_id, status, action=action)


def emergency_session_for_trip(trip_id):
    return get_db().execute(
        "SELECT * FROM emergency_sessions WHERE trip_id = ?", (trip_id,)
    ).fetchone()


def emergency_session_get(session_id):
    return get_db().execute(
        "SELECT * FROM emergency_sessions WHERE id = ?", (session_id,)
    ).fetchone()


def emergency_transitions(session_id):
    return get_db().execute(
        """
        SELECT * FROM emergency_transitions
        WHERE session_id = ?
        ORDER BY id
        """,
        (session_id,),
    ).fetchall()


def session_state_counts():
    return {
        row["state"]: row["count"]
        for row in get_db().execute(
            "SELECT state, COUNT(*) AS count FROM emergency_sessions GROUP BY state"
        )
    }


def active_sessions_last_seen_before(cutoff):
    """ACTIVE sessions that have not reported since `cutoff` (watchdog input)."""
    return get_db().execute(
        """
        SELECT s.*, t.reference, t.name
        FROM emergency_sessions s
        JOIN trips t ON t.id = s.trip_id
        WHERE s.state = 'ACTIVE'
          AND (s.last_seen_at IS NULL OR s.last_seen_at <= ?)
        ORDER BY s.id
        """,
        (cutoff,),
    ).fetchall()


def touch_session_last_seen(trip_id, at=None):
    """Record that the unit reported. Phase C calls this on every telemetry batch."""
    db = get_db()
    with db:
        db.execute(
            "UPDATE emergency_sessions SET last_seen_at = ?, updated_at = ? "
            "WHERE trip_id = ?",
            (at or iso_now(), at or iso_now(), trip_id),
        )


def sessions_open_count():
    row = get_db().execute(
        "SELECT COUNT(*) AS n FROM emergency_sessions "
        "WHERE state IN ('CREATED', 'VERIFIED', 'ACTIVE', 'ON_SCENE')"
    ).fetchone()
    return row["n"] if row else 0


# ---------------------------------------------------------------------------
# Phase C — telemetry persistence
#
# Two shapes on purpose: `telemetry_fixes` is the audit trail of accepted
# positions (bounded by retention), `vehicle_positions` is the one row per
# response that every reader uses. Writing them in this order inside one
# transaction keeps the trail and the latest position consistent.
# ---------------------------------------------------------------------------


def record_telemetry_fix(*, trip_id, session_id, vehicle_id, fix, quality):
    """Insert one accepted fix. Returns {"id": int|None, "duplicate": bool}."""
    db = get_db()
    now = fix["received_at"]
    with db:
        cursor = db.execute(
            """
            INSERT INTO telemetry_fixes (
                trip_id, session_id, vehicle_id, client_fix_id, sequence,
                lat, lng, accuracy_m, heading_deg, speed_mps,
                device_time, received_at, quality, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (client_fix_id) DO NOTHING
            """,
            (
                trip_id,
                session_id,
                vehicle_id,
                fix["client_fix_id"],
                fix["sequence"],
                fix["lat"],
                fix["lng"],
                fix["accuracy_m"],
                fix["heading_deg"],
                fix["speed_mps"],
                fix["device_time"],
                now,
                quality,
                fix.get("source") or "gps",
            ),
        )
        if cursor.rowcount == 0:
            # The fix id already existed: a retry, not a new position.
            row = db.execute(
                "SELECT id FROM telemetry_fixes WHERE client_fix_id = ?",
                (fix["client_fix_id"],),
            ).fetchone()
            return {"id": row["id"] if row else None, "duplicate": True}
    return {"id": cursor.lastrowid, "duplicate": False}


def upsert_latest_position(*, trip_id, session_id, vehicle_id, fix, quality, fix_id):
    """Replace the latest position only when this fix is strictly newer.

    The ordering test lives in the SQL `WHERE`, so two concurrent uploads cannot
    race an older fix over a newer one — the second statement simply matches no
    row. Returns True when the row was inserted or replaced.
    """
    db = get_db()
    with db:
        cursor = db.execute(
            """
            INSERT INTO vehicle_positions (
                trip_id, session_id, vehicle_id, last_fix_id,
                lat, lng, accuracy_m, heading_deg, speed_mps,
                device_time, received_at, sequence, client_fix_id, quality, source, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (trip_id) DO UPDATE SET
                session_id = excluded.session_id,
                vehicle_id = excluded.vehicle_id,
                last_fix_id = excluded.last_fix_id,
                lat = excluded.lat,
                lng = excluded.lng,
                accuracy_m = excluded.accuracy_m,
                heading_deg = excluded.heading_deg,
                speed_mps = excluded.speed_mps,
                device_time = excluded.device_time,
                received_at = excluded.received_at,
                sequence = excluded.sequence,
                client_fix_id = excluded.client_fix_id,
                quality = excluded.quality,
                source = excluded.source,
                updated_at = excluded.updated_at
            WHERE excluded.device_time > vehicle_positions.device_time
               OR (
                    excluded.device_time = vehicle_positions.device_time
                    AND COALESCE(excluded.sequence, -1) > COALESCE(vehicle_positions.sequence, -1)
               )
            """,
            (
                trip_id,
                session_id,
                vehicle_id,
                fix_id,
                fix["lat"],
                fix["lng"],
                fix["accuracy_m"],
                fix["heading_deg"],
                fix["speed_mps"],
                fix["device_time"],
                fix["received_at"],
                fix["sequence"],
                fix["client_fix_id"],
                quality,
                fix["source"],
                fix["received_at"],
            ),
        )
        return cursor.rowcount == 1


def telemetry_fix_by_client_id(client_fix_id):
    """The stored row for a retried fix id, or None."""
    if not client_fix_id:
        return None
    return get_db().execute(
        "SELECT id, trip_id FROM telemetry_fixes WHERE client_fix_id = ?",
        (client_fix_id,),
    ).fetchone()


def latest_position(trip_id):
    return get_db().execute(
        "SELECT * FROM vehicle_positions WHERE trip_id = ?", (trip_id,)
    ).fetchone()


def telemetry_trail(trip_id, limit=200):
    """The most recent accepted fixes, oldest first, for a trail overlay."""
    rows = get_db().execute(
        """
        SELECT lat, lng, accuracy_m, heading_deg, speed_mps, device_time, received_at, quality
        FROM telemetry_fixes
        WHERE trip_id = ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (trip_id, max(1, min(1000, int(limit)))),
    ).fetchall()
    return list(reversed([dict(row) for row in rows]))


def live_positions(since_fix_id=0):
    """Active responses with their latest trusted position (admin polling).

    `last_fix_id` doubles as the event id: it is monotonic, unique and assigned by
    the same insert that created the position, so a poller can ask for
    "everything newer than the last id I saw" without a separate cursor table.
    """
    return get_db().execute(
        """
        SELECT
            t.id AS trip_id, t.reference, t.name, t.status, t.priority,
            t.origin, t.destination,
            t.destination_lat, t.destination_lng,
            t.route_quality, t.route_deviation_m, t.route_recalculated_at,
            t.route_provider, t.route_computed_at,
            s.state AS session_state, s.activated_at, s.last_seen_at,
            p.trip_id AS position_trip_id, p.lat, p.lng, p.accuracy_m,
            p.heading_deg, p.speed_mps, p.device_time, p.received_at,
            p.quality, p.updated_at, p.last_fix_id, p.source,
            v.call_sign, v.vehicle_type
        FROM emergency_sessions s
        JOIN trips t ON t.id = s.trip_id
        LEFT JOIN vehicle_positions p ON p.trip_id = s.trip_id
        LEFT JOIN vehicles v ON v.id = COALESCE(p.vehicle_id, t.vehicle_id)
        WHERE s.state = 'ACTIVE' AND COALESCE(p.last_fix_id, 0) > ?
        ORDER BY p.last_fix_id
        """,
        (int(since_fix_id or 0),),
    ).fetchall()


def active_live_count():
    row = get_db().execute(
        "SELECT COUNT(*) AS n FROM emergency_sessions WHERE state = 'ACTIVE'"
    ).fetchone()
    return row["n"] if row else 0


def mark_route_quality(trip_id, quality):
    db = get_db()
    with db:
        db.execute(
            "UPDATE trips SET route_quality = ? WHERE id = ?", (quality, trip_id)
        )


def mark_route_deviation(trip_id, metres):
    db = get_db()
    now = iso_now()
    with db:
        db.execute(
            "UPDATE trips SET route_deviation_m = ?, route_recalculated_at = ?, route_quality = 'ok' "
            "WHERE id = ?",
            (metres, now, trip_id),
        )


def prune_telemetry(before):
    """Delete trail rows older than the retention window.

    The latest-position row is deliberately kept: a vehicle that went quiet still
    has a last known position, and deleting it would make the admin map show
    "no telemetry" instead of "signal lost".
    """
    db = get_db()
    with db:
        cursor = db.execute(
            "DELETE FROM telemetry_fixes WHERE received_at < ?", (before,)
        )
    return cursor.rowcount


def telemetry_counts():
    db = get_db()
    fixes = db.execute("SELECT COUNT(*) AS n FROM telemetry_fixes").fetchone()["n"]
    positions = db.execute("SELECT COUNT(*) AS n FROM vehicle_positions").fetchone()["n"]
    oldest = db.execute(
        "SELECT MIN(received_at) AS oldest FROM telemetry_fixes"
    ).fetchone()["oldest"]
    return {"fixes": fixes, "positions": positions, "oldest": oldest}
