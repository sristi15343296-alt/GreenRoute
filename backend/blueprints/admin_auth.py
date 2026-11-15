"""Sign-in, sign-out and the "who am I" endpoint for the admin website.

The cookie carries an opaque token; the session itself lives in the database,
so signing out (or suspending an account) takes effect on the next request
rather than whenever a cookie happens to expire.
"""

from __future__ import annotations

from urllib.parse import urlparse

from flask import (
    Blueprint,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)

import admin_store as accounts
import auth

admin_auth = Blueprint("admin_auth", __name__)


def _safe_next(target: str | None) -> str:
    """Only ever redirect to a local path, never to another origin."""
    if not target:
        return url_for("dashboard")
    parsed = urlparse(target)
    if parsed.scheme or parsed.netloc:
        return url_for("dashboard")
    if not target.startswith("/"):
        return url_for("dashboard")
    return target


@admin_auth.route("/login", methods=["GET", "POST"])
def login():
    if auth.current_actor() is not None and request.method == "GET":
        return redirect(_safe_next(request.args.get("next")))

    next_target = request.args.get("next") or request.form.get("next")
    error = None
    status = 200
    email = ""

    if request.method == "POST":
        email = (request.form.get("email") or "").strip()
        password = request.form.get("password") or ""
        ip = request.remote_addr or "unknown"

        if not auth.check_preauth_csrf(request.form.get("csrf_token")):
            error = "This form expired. Reload the page and try again."
            status = 400
        else:
            try:
                admin, failure = auth.authenticate(email, password)
            except auth.LoginThrottled as throttled:
                minutes = max(1, throttled.retry_after_seconds // 60)
                error = (
                    "Too many failed attempts. Try again in about "
                    f"{minutes} minute{'s' if minutes != 1 else ''}."
                )
                status = 429
                accounts.audit_record(
                    action="auth.login",
                    outcome="throttled",
                    detail={"email": email},
                    ip=ip,
                )
            else:
                if admin is None:
                    accounts.record_login_attempt(email, ip, "failed")
                    accounts.audit_record(
                        action="auth.login",
                        outcome=failure,
                        detail={"email": email},
                        ip=ip,
                    )
                    error = "That e-mail and password do not match an active account."
                    status = 401
                else:
                    accounts.record_login_attempt(email, ip, "success")
                    token = auth.begin_session(
                        admin, ip, request.headers.get("User-Agent", "")
                    )
                    accounts.audit_record(
                        actor_id=admin["id"],
                        actor_role=admin["role"],
                        action="auth.login",
                        outcome="success",
                        ip=ip,
                    )
                    response = redirect(_safe_next(next_target))
                    return auth.set_session_cookie(response, token)

    return (
        render_template(
            "login.html",
            error=error,
            email=email,
            next_target=next_target or "",
            csrf_token=auth.preauth_csrf_token(),
            workspace_name=_workspace_name(),
        ),
        status,
    )


@admin_auth.post("/logout")
def logout():
    actor = auth.current_actor()
    if actor is not None and not auth.csrf_ok(actor):
        return ("This form expired. Reload the page and try again.", 400)
    if actor is not None:
        accounts.audit_record(
            actor_id=actor.id,
            actor_role=actor.role,
            action="auth.logout",
            ip=request.remote_addr or "unknown",
        )
    auth.end_session()
    response = redirect(url_for("admin_auth.login"))
    return auth.clear_session_cookie(response)


@admin_auth.get("/api/admin/session")
def session_info():
    actor = auth.current_actor()
    if actor is None:
        return jsonify({"authenticated": False}), 401
    return jsonify(
        {
            "authenticated": True,
            "name": actor.name,
            "email": actor.email,
            "role": actor.role,
            "role_label": actor.label,
            "permissions": sorted(actor.permissions),
            "csrf_token": actor.csrf_token,
        }
    )


def _workspace_name() -> str:
    from flask import has_app_context

    import db as store

    if not has_app_context():
        return "GreenRoute"
    try:
        return store.get_settings().get("workspace_name") or "GreenRoute"
    except Exception:  # noqa: BLE001 - the sign-in page must render even if the DB is down
        return "GreenRoute"
