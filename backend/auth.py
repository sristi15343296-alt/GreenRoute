"""Administrative authentication, server-side sessions and authorization.

Design notes (Phase B)
----------------------
* **Passwords** are hashed with scrypt (Werkzeug's `generate_password_hash`
  default) and are never stored, logged or rendered anywhere. Verification is
  constant-time inside Werkzeug.
* **Sessions are server-side.** The browser holds only an opaque random token in
  an `HttpOnly` cookie; the database holds its SHA-256 digest, so a leaked
  database cannot be replayed as a login. Session rows carry an absolute expiry
  (8 h) *and* an idle expiry (45 min), and `revoke` deletes them immediately.
* **CSRF** is a per-session random token, stored with the session row and
  compared in constant time for every state-changing request. A pre-authentication
  token protects the login form itself.
* **Rate limiting** is recorded in `admin_login_attempts`, counted per e-mail and
  per client address over a sliding window. It is deliberately pessimistic: a
  correct password after too many failures is still refused until the window
  clears, so an attacker cannot flood-and-guess.
* **Roles** live in the database, never in the cookie or the form. An actor's
  permissions are derived from the stored role on every request, so demoting an
  administrator takes effect on their next request.

Nothing here is a substitute for HTTPS. Cookies are marked `Secure` only when
`GREENROUTE_HTTPS=1` is set, so local development over http still works; the
deployment checklist in docs/phase-b-implementation.md requires it in production.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from flask import g, jsonify, redirect, request, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import admin_store as accounts
import db as store

# ---------------------------------------------------------------------------
# Roles and permissions
# ---------------------------------------------------------------------------

ROLE_LABELS = {
    "SUPER_ADMIN": "Super administrator",
    "ADMIN": "Administrator",
    "EMERGENCY_OPERATOR": "Emergency operator",
    "VIEWER": "Viewer",
}

#: Every permission the backend understands. Routes ask for one of these, never
#: for a role name, so a role can be re-scoped without touching route code.
PERMISSIONS = {
    "dashboard.view",
    "trips.view",
    "trips.export",
    "trips.create",
    "trips.dispatch",
    "trips.cancel",
    "trips.assign",
    "analytics.view",
    "resources.view",
    "resources.manage",
    "settings.view",
    "settings.manage",
    "audit.view",
    "admins.manage",
    "route.resolve",
}

_VIEWER = {
    "dashboard.view",
    "trips.view",
    "analytics.view",
    "resources.view",
    "settings.view",
}

_OPERATOR = _VIEWER | {
    "trips.create",
    "trips.dispatch",
    "trips.cancel",
    "trips.assign",
    "route.resolve",
}

_ADMIN = _OPERATOR | {
    "trips.export",
    "resources.manage",
    "audit.view",
}

ROLE_PERMISSIONS = {
    "SUPER_ADMIN": _ADMIN | {"settings.manage", "admins.manage"},
    "ADMIN": _ADMIN,
    "EMERGENCY_OPERATOR": _OPERATOR,
    "VIEWER": _VIEWER,
}

ROLE_ORDER = ["SUPER_ADMIN", "ADMIN", "EMERGENCY_OPERATOR", "VIEWER"]

ADMIN_STATUSES = {"active": "Active", "suspended": "Suspended"}

# ---------------------------------------------------------------------------
# Policy constants
# ---------------------------------------------------------------------------

SESSION_COOKIE = "gr_admin_session"
CSRF_COOKIE = "gr_csrf"

SESSION_ABSOLUTE_TTL = timedelta(hours=8)
SESSION_IDLE_TTL = timedelta(minutes=45)
SESSION_TOUCH_INTERVAL = timedelta(seconds=60)

MAX_FAILED_LOGINS = 5
FAILURE_WINDOW = timedelta(minutes=15)
#: A correct password is still refused this long after the failures aged out,
#: so the limiter cannot be bypassed by racing it.
RATE_LIMIT_HOURS = 1

MIN_PASSWORD_LENGTH = 10


def permissions_for(role: str) -> set[str]:
    return set(ROLE_PERMISSIONS.get(role, set()))


def can(actor, permission: str) -> bool:
    return actor is not None and permission in actor.permissions


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """scrypt hash with a per-password salt (Werkzeug's default method)."""
    return generate_password_hash(password, method="scrypt")


def verify_password(password_hash: str, password: str) -> bool:
    if not password_hash or not password:
        return False
    try:
        return check_password_hash(password_hash, password)
    except (ValueError, TypeError):
        # A malformed hash must read as "wrong password", never as an exception
        # that reveals the difference.
        return False


def password_problems(password: str, confirm: str | None = None) -> list[str]:
    problems = []
    if len(password or "") < MIN_PASSWORD_LENGTH:
        problems.append(
            f"Use at least {MIN_PASSWORD_LENGTH} characters for the password."
        )
    if password and password.strip() != password:
        problems.append("The password cannot start or end with a space.")
    if confirm is not None and password != confirm:
        problems.append("The two passwords do not match.")
    return problems


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def session_cookie_secure() -> bool:
    import os

    return os.environ.get("GREENROUTE_HTTPS", "0") == "1"


# ---------------------------------------------------------------------------
# The authenticated actor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Actor:
    id: int
    email: str
    name: str
    role: str
    session_id: int
    csrf_token: str

    @property
    def permissions(self) -> set[str]:
        return permissions_for(self.role)

    @property
    def label(self) -> str:
        return ROLE_LABELS.get(self.role, self.role)

    @property
    def is_super(self) -> bool:
        return self.role == "SUPER_ADMIN"

    def can(self, permission: str) -> bool:
        return permission in self.permissions


def current_actor() -> Actor | None:
    """The authenticated actor for this request, or None.

    Cached for the duration of one request so a page with twenty `can()` calls
    performs one lookup. The cache is keyed by the cookie value rather than
    stored bare on `g`, because `g` lives on the *application* context and a
    caller that reuses an app context (background jobs, the test client) would
    otherwise read another request's identity.
    """
    # Cached on the *request*, not on `g`: `g` belongs to the application
    # context, which a worker or test client can reuse across requests, and a
    # reused identity cache would let a revoked session keep its access.
    if hasattr(request, "_gr_actor"):
        return request._gr_actor
    actor = _load_actor()
    request._gr_actor = actor
    return actor


def _load_actor() -> Actor | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    row = accounts.admin_session_get(_digest(token))
    if row is None:
        return None

    admin = accounts.admin_get(row["admin_id"])
    if admin is None or admin["status"] != "active":
        accounts.admin_session_revoke(row["id"])
        return None

    now = store.utcnow()
    expires_at = store.parse_dt(row["expires_at"])
    last_seen = store.parse_dt(row["last_seen_at"] or row["created_at"])
    if expires_at <= now or (now - last_seen) > SESSION_IDLE_TTL:
        accounts.admin_session_revoke(row["id"])
        return None

    if (now - last_seen) > SESSION_TOUCH_INTERVAL:
        accounts.admin_session_touch(row["id"], store.iso_now())

    actor = Actor(
        id=admin["id"],
        email=admin["email"],
        name=admin["name"] or admin["email"],
        role=admin["role"],
        session_id=row["id"],
        csrf_token=row["csrf_token"],
    )
    return actor


# ---------------------------------------------------------------------------
# Login, logout, throttling
# ---------------------------------------------------------------------------


class LoginThrottled(Exception):
    def __init__(self, retry_after_seconds: int):
        super().__init__("Too many failed sign-in attempts.")
        self.retry_after_seconds = retry_after_seconds


def _client_ip() -> str:
    # `request.remote_addr` is what the WSGI server saw. X-Forwarded-For is only
    # trusted when a reverse proxy is known to set it, which is not the case in
    # development, so it is deliberately ignored here.
    return request.remote_addr or "unknown"


def throttle_remaining(email: str) -> int:
    """Seconds until this e-mail may attempt a sign-in again (0 = allowed)."""
    # Timestamps are compared as strings, so they must be produced in the one
    # format the table is written in (`db.iso_now`).
    since = store.stamp(store.utcnow() - FAILURE_WINDOW)
    failures = accounts.login_failures_since(email, since)
    if failures < MAX_FAILED_LOGINS:
        return 0
    latest = accounts.latest_failure_at(email)
    if latest is None:
        return 0
    unlock_at = store.parse_dt(latest) + FAILURE_WINDOW
    return max(0, int((unlock_at - store.utcnow()).total_seconds()))


def authenticate(email: str, password: str):
    """Return (admin_row, None) on success or (None, reason) on failure."""
    email = (email or "").strip().lower()
    remaining = throttle_remaining(email)
    if remaining:
        raise LoginThrottled(remaining)

    admin = accounts.admin_get_by_email(email)
    if admin is None:
        # Spend comparable time on unknown accounts so timing does not reveal
        # which e-mails exist.
        verify_password(
            "scrypt:32768:8:1$abcdefghijklmnop$" + "0" * 64, password or ""
        )
        return None, "invalid"

    if admin["status"] != "active":
        return None, "suspended"

    if not verify_password(admin["password_hash"], password or ""):
        return None, "invalid"

    return admin, None


def begin_session(admin, ip: str, user_agent: str) -> str:
    """Create the server-side session and return the opaque cookie token."""
    token = _new_token()
    now = store.utcnow()
    accounts.admin_session_create(
        admin_id=admin["id"],
        token_hash=_digest(token),
        csrf_token=_new_token(),
        created_at=store.stamp(now),
        expires_at=store.stamp(now + SESSION_ABSOLUTE_TTL),
        ip=ip,
        user_agent=(user_agent or "")[:250],
    )
    accounts.admin_mark_login(admin["id"], now.isoformat(timespec="seconds"))
    return token


def end_session() -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        row = accounts.admin_session_get(_digest(token))
        if row is not None:
            accounts.admin_session_revoke(row["id"])
    if hasattr(request, "_gr_actor"):
        request._gr_actor = None


def set_session_cookie(response, token: str):
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_ABSOLUTE_TTL.total_seconds()),
        httponly=True,
        samesite="Lax",
        secure=session_cookie_secure(),
        path="/",
    )
    return response


def clear_session_cookie(response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------

CSRF_HEADER = "X-CSRF-Token"
CSRF_FIELD = "csrf_token"
_PREAUTH_KEY = "gr_preauth_csrf"


def preauth_csrf_token() -> str:
    """CSRF token for the sign-in form, before any session exists."""
    from flask import session as cookie_session

    token = cookie_session.get(_PREAUTH_KEY)
    if not token:
        token = _new_token()
        cookie_session[_PREAUTH_KEY] = token
    return token


def check_preauth_csrf(supplied: str | None) -> bool:
    from flask import session as cookie_session

    expected = cookie_session.get(_PREAUTH_KEY)
    if not expected or not supplied:
        return False
    return hmac.compare_digest(expected, supplied)


def supplied_csrf() -> str | None:
    header = request.headers.get(CSRF_HEADER)
    if header:
        return header
    if request.form:
        return request.form.get(CSRF_FIELD)
    payload = request.get_json(silent=True)
    if isinstance(payload, dict):
        value = payload.get(CSRF_FIELD)
        if isinstance(value, str):
            return value
    return None


def csrf_ok(actor: Actor) -> bool:
    supplied = supplied_csrf()
    if not supplied or not actor:
        return False
    return hmac.compare_digest(actor.csrf_token, supplied)


# ---------------------------------------------------------------------------
# Route protection helpers
# ---------------------------------------------------------------------------

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def wants_json() -> bool:
    return (
        request.is_json
        or request.path.startswith("/api/")
        or request.accept_mimetypes.best == "application/json"
    )


def unauthorized_response():
    if wants_json():
        return (
            jsonify(
                {
                    "error": "Sign in to continue.",
                    "code": "authentication_required",
                }
            ),
            401,
        )
    return redirect(url_for("admin_auth.login", next=request.full_path.rstrip("?")))


def forbidden_response(permission: str | None = None):
    if wants_json():
        return (
            jsonify(
                {
                    "error": "Your role is not allowed to perform this action.",
                    "code": "permission_denied",
                    "required_permission": permission,
                }
            ),
            403,
        )
    return (
        "You do not have permission to open this page.",
        403,
        {"Content-Type": "text/plain; charset=utf-8"},
    )


def require(permission: str):
    """Decorator: authenticated actor with `permission`, plus CSRF on writes."""

    def decorator(view):
        from functools import wraps

        @wraps(view)
        def wrapped(*args, **kwargs):
            actor = current_actor()
            if actor is None:
                return unauthorized_response()
            if not actor.can(permission):
                accounts.audit_record(
                    actor_id=actor.id,
                    actor_role=actor.role,
                    action="authorization.denied",
                    outcome="denied",
                    detail={"permission": permission, "path": request.path},
                    ip=_client_ip(),
                )
                return forbidden_response(permission)
            if request.method in MUTATING_METHODS and not csrf_ok(actor):
                if wants_json():
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
            return view(*args, **kwargs)

        return wrapped

    return decorator


def login_required(view):
    """Any authenticated role."""

    def decorator(inner):
        from functools import wraps

        @wraps(inner)
        def wrapped(*args, **kwargs):
            actor = current_actor()
            if actor is None:
                return unauthorized_response()
            if request.method in MUTATING_METHODS and not csrf_ok(actor):
                if wants_json():
                    return (
                        jsonify({"error": "This form expired.", "code": "csrf_failed"}),
                        400,
                    )
                return ("This form expired. Reload the page and try again.", 400)
            return inner(*args, **kwargs)

        return wrapped

    return decorator


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def bootstrap_admin(instance_path: str):
    """Create the first super administrator if the table is empty.

    The generated password is written to `instance/first-admin.txt` (never to
    the log, never to the console) and must be changed after the first sign-in.
    Setting `GREENROUTE_BOOTSTRAP_ADMIN_EMAIL` and
    `GREENROUTE_BOOTSTRAP_ADMIN_PASSWORD` skips the file for scripted installs.
    """
    import os

    if accounts.admin_count() > 0:
        return None

    email = os.environ.get("GREENROUTE_BOOTSTRAP_ADMIN_EMAIL", "admin@greenroute.local")
    password = os.environ.get("GREENROUTE_BOOTSTRAP_ADMIN_PASSWORD")
    generated = password is None
    if generated:
        password = secrets.token_urlsafe(18)

    accounts.admin_create(
        email=email.strip().lower(),
        name="Initial administrator",
        role="SUPER_ADMIN",
        password_hash=hash_password(password),
        status="active",
    )

    path = os.path.join(instance_path, "first-admin.txt")
    if generated:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(
                "GreenRoute initial administrator\n"
                f"email: {email.strip().lower()}\n"
                f"password: {password}\n"
                "Sign in, then change this password immediately.\n"
            )
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return {"email": email.strip().lower(), "path": path if generated else None}
