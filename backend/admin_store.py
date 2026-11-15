"""Persistence for administrator identity, sessions, throttling and audit.

Split from `db.py` because it holds a different kind of data: `db.py` owns the
fleet's operational records (responses, vehicles, routes), while this module
owns *who may act on them* and *what they did*. Both share the same SQLite
connection handed out by `db.get_db()`, so an administrator change and its audit
row still land in one transaction.

Nothing here returns a password hash to a template or a route by accident: the
only function that returns one is `admin_get_by_email`, which `auth.authenticate`
is the only caller of.
"""

from __future__ import annotations

import json

import db as store

# ---------------------------------------------------------------------------
# Administrators
# ---------------------------------------------------------------------------


def admin_create(*, email, name, role, password_hash, status="active"):
    db = store.get_db()
    now = store.iso_now()
    with db:
        cursor = db.execute(
            """
            INSERT INTO admins (email, name, password_hash, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (email.strip().lower(), name, password_hash, role, status, now, now),
        )
    return cursor.lastrowid


def admin_get(admin_id):
    return store.get_db().execute(
        "SELECT * FROM admins WHERE id = ?", (admin_id,)
    ).fetchone()


def admin_get_by_email(email):
    return store.get_db().execute(
        "SELECT * FROM admins WHERE email = ?", ((email or "").strip().lower(),)
    ).fetchone()


def admin_list():
    return store.get_db().execute(
        "SELECT * FROM admins ORDER BY (status != 'active'), email"
    ).fetchall()


def admin_count():
    row = store.get_db().execute("SELECT COUNT(*) AS n FROM admins").fetchone()
    return row["n"] if row else 0


def active_super_admin_count():
    row = store.get_db().execute(
        "SELECT COUNT(*) AS n FROM admins WHERE role = 'SUPER_ADMIN' AND status = 'active'"
    ).fetchone()
    return row["n"] if row else 0


def admin_update(admin_id, *, name=None, role=None, status=None):
    fields = {}
    if name is not None:
        fields["name"] = name
    if role is not None:
        fields["role"] = role
    if status is not None:
        fields["status"] = status
    if not fields:
        return
    fields["updated_at"] = store.iso_now()
    assignments = ", ".join(f"{key} = ?" for key in fields)
    db = store.get_db()
    with db:
        db.execute(
            f"UPDATE admins SET {assignments} WHERE id = ?",
            list(fields.values()) + [admin_id],
        )


def admin_set_password(admin_id, password_hash):
    db = store.get_db()
    with db:
        db.execute(
            "UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, store.iso_now(), admin_id),
        )
    # Changing a password ends every other session for that account.
    admin_sessions_revoke_all(admin_id)


def admin_mark_login(admin_id, at=None):
    db = store.get_db()
    with db:
        db.execute(
            "UPDATE admins SET last_login_at = ? WHERE id = ?",
            (at or store.iso_now(), admin_id),
        )


# ---------------------------------------------------------------------------
# Server-side sessions
# ---------------------------------------------------------------------------


def admin_session_create(
    *, admin_id, token_hash, csrf_token, created_at, expires_at, ip, user_agent
):
    db = store.get_db()
    with db:
        cursor = db.execute(
            """
            INSERT INTO admin_sessions
                (admin_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                admin_id,
                token_hash,
                csrf_token,
                created_at,
                expires_at,
                created_at,
                ip,
                user_agent,
            ),
        )
    return cursor.lastrowid


def admin_session_get(token_hash):
    return store.get_db().execute(
        "SELECT * FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL",
        (token_hash,),
    ).fetchone()


def admin_session_touch(session_id, at=None):
    db = store.get_db()
    with db:
        db.execute(
            "UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?",
            (at or store.iso_now(), session_id),
        )


def admin_session_revoke(session_id):
    db = store.get_db()
    with db:
        db.execute(
            "UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (store.iso_now(), session_id),
        )


def admin_sessions_revoke_all(admin_id):
    db = store.get_db()
    with db:
        db.execute(
            "UPDATE admin_sessions SET revoked_at = ? "
            "WHERE admin_id = ? AND revoked_at IS NULL",
            (store.iso_now(), admin_id),
        )


def admin_sessions_for_admin(admin_id, active_only=True):
    query = "SELECT * FROM admin_sessions WHERE admin_id = ?"
    if active_only:
        query += " AND revoked_at IS NULL"
    query += " ORDER BY id DESC"
    return store.get_db().execute(query, (admin_id,)).fetchall()


def admin_session_purge(before):
    """Delete sessions that expired before `before`. Keeps the table small."""
    db = store.get_db()
    with db:
        db.execute(
            "DELETE FROM admin_sessions WHERE expires_at < ? OR revoked_at < ?",
            (before, before),
        )


# ---------------------------------------------------------------------------
# Login throttling
# ---------------------------------------------------------------------------


def record_login_attempt(email, ip, outcome, at=None):
    db = store.get_db()
    with db:
        db.execute(
            """
            INSERT INTO admin_login_attempts (email, ip, outcome, attempted_at)
            VALUES (?, ?, ?, ?)
            """,
            ((email or "").strip().lower(), ip, outcome, at or store.iso_now()),
        )


def login_failures_since(email, since):
    row = store.get_db().execute(
        """
        SELECT COUNT(*) AS n FROM admin_login_attempts
        WHERE email = ? AND outcome = 'failed' AND attempted_at >= ?
        """,
        ((email or "").strip().lower(), since),
    ).fetchone()
    return row["n"] if row else 0


def latest_failure_at(email):
    row = store.get_db().execute(
        """
        SELECT attempted_at FROM admin_login_attempts
        WHERE email = ? AND outcome = 'failed'
        ORDER BY attempted_at DESC LIMIT 1
        """,
        ((email or "").strip().lower(),),
    ).fetchone()
    return row["attempted_at"] if row else None


def login_attempts_recent(limit=50):
    return store.get_db().execute(
        "SELECT * FROM admin_login_attempts ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()


def purge_login_attempts(before):
    db = store.get_db()
    with db:
        db.execute("DELETE FROM admin_login_attempts WHERE attempted_at < ?", (before,))


# ---------------------------------------------------------------------------
# Audit log (append-only; the database enforces it with triggers)
# ---------------------------------------------------------------------------


def audit_record(
    *,
    action,
    outcome="success",
    actor_id=None,
    actor_role=None,
    trip_id=None,
    session_id=None,
    detail=None,
    ip=None,
):
    """Append one audit row. Never raises: an audit failure must not break the
    operation that was already committed, but it is reported to the caller.
    """
    payload = None
    if detail is not None:
        payload = json.dumps(detail, sort_keys=True, default=str)[:4000]
    db = store.get_db()
    try:
        with db:
            db.execute(
                """
                INSERT INTO audit_log
                    (at, actor_id, actor_role, action, outcome, trip_id, session_id, ip, detail_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    store.iso_now(),
                    actor_id,
                    actor_role,
                    action,
                    outcome,
                    trip_id,
                    session_id,
                    ip,
                    payload,
                ),
            )
        return True
    except Exception:  # noqa: BLE001 - auditing must never mask the real result
        return False


def audit_list(limit=100, trip_id=None):
    query = "SELECT * FROM audit_log"
    params = []
    if trip_id is not None:
        query += " WHERE trip_id = ?"
        params.append(trip_id)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))
    rows = store.get_db().execute(query, params).fetchall()
    return [dict(row) for row in rows]


def audit_for_trip(trip_id, limit=50):
    return audit_list(limit=limit, trip_id=trip_id)


def audit_count():
    row = store.get_db().execute("SELECT COUNT(*) AS n FROM audit_log").fetchone()
    return row["n"] if row else 0
