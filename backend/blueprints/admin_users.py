"""Administrator management and the audit trail.

Only SUPER_ADMIN may change administrators; ADMIN (and above) may read the audit
log. Three invariants are enforced here, not in the template:

1. the last active SUPER_ADMIN cannot be suspended, demoted or deleted;
2. an administrator cannot change their own role or suspend themselves, so a
   mistake cannot lock the workspace out of its own controls;
3. every change writes an audit row before the response is returned.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

import admin_store as accounts
import auth

admin_users = Blueprint("admin_users", __name__)


def _wants_json() -> bool:
    return request.is_json or request.path.startswith("/api/")


def _fail(message, status=422, **extra):
    if _wants_json():
        payload = {"error": message}
        payload.update(extra)
        return jsonify(payload), status
    return message, status


@admin_users.get("/administrators")
@auth.require("admins.manage")
def administrators():
    actor = auth.current_actor()
    admins = [dict(row) for row in accounts.admin_list()]
    for admin in admins:
        admin.pop("password_hash", None)
        admin["sessions"] = len(
            accounts.admin_sessions_for_admin(admin["id"], active_only=True)
        )
    return render_template(
        "admin_users.html",
        current_nav="administrators",
        page_title="Administrators",
        page_subtitle="Accounts, roles and active sessions for this workspace.",
        admins=admins,
        roles=[
            (role, auth.ROLE_LABELS[role], sorted(auth.ROLE_PERMISSIONS[role]))
            for role in auth.ROLE_ORDER
        ],
        statuses=auth.ADMIN_STATUSES,
        actor=actor,
        min_password_length=auth.MIN_PASSWORD_LENGTH,
    )


@admin_users.post("/administrators")
@auth.require("admins.manage")
def create_administrator():
    actor = auth.current_actor()
    payload = request.get_json(silent=True) or request.form
    email = (payload.get("email") or "").strip().lower()
    name = (payload.get("name") or "").strip() or None
    role = (payload.get("role") or "VIEWER").strip()
    password = payload.get("password") or ""
    confirm = payload.get("password_confirm")
    if confirm is None:
        confirm = password

    problems = []
    if "@" not in email or len(email) < 5 or " " in email:
        problems.append("Enter a valid e-mail address.")
    if role not in auth.ROLE_PERMISSIONS:
        problems.append("Choose a valid role.")
    problems.extend(auth.password_problems(password, confirm))
    if accounts.admin_get_by_email(email) is not None:
        problems.append("An account with that e-mail already exists.")
    if problems:
        return _fail(problems[0], errors=problems)

    admin_id = accounts.admin_create(
        email=email,
        name=name,
        role=role,
        password_hash=auth.hash_password(password),
        status="active",
    )
    accounts.audit_record(
        actor_id=actor.id,
        actor_role=actor.role,
        action="admin.create",
        detail={"email": email, "role": role, "admin_id": admin_id},
        ip=request.remote_addr,
    )
    if _wants_json():
        return jsonify({"admin": {"id": admin_id, "email": email, "role": role}}), 201
    return redirect(url_for("admin_users.administrators"))


@admin_users.post("/administrators/<int:admin_id>/role")
@auth.require("admins.manage")
def change_role(admin_id):
    actor = auth.current_actor()
    target = accounts.admin_get(admin_id)
    if target is None:
        return _fail("Account not found.", 404)

    payload = request.get_json(silent=True) or request.form
    role = (payload.get("role") or "").strip()
    if role not in auth.ROLE_PERMISSIONS:
        return _fail("Choose a valid role.")

    if admin_id == actor.id:
        return _fail("You cannot change your own role.", 403)
    if (
        target["role"] == "SUPER_ADMIN"
        and role != "SUPER_ADMIN"
        and accounts.active_super_admin_count() <= 1
    ):
        return _fail("The workspace needs at least one active super administrator.", 409)

    accounts.admin_update(admin_id, role=role)
    accounts.audit_record(
        actor_id=actor.id,
        actor_role=actor.role,
        action="admin.role_change",
        detail={"admin_id": admin_id, "from": target["role"], "to": role},
        ip=request.remote_addr,
    )
    if _wants_json():
        return jsonify({"ok": True, "role": role})
    return redirect(url_for("admin_users.administrators"))


@admin_users.post("/administrators/<int:admin_id>/status")
@auth.require("admins.manage")
def change_status(admin_id):
    actor = auth.current_actor()
    target = accounts.admin_get(admin_id)
    if target is None:
        return _fail("Account not found.", 404)

    payload = request.get_json(silent=True) or request.form
    status = (payload.get("status") or "").strip()
    if status not in auth.ADMIN_STATUSES:
        return _fail("Choose a valid account status.")

    if admin_id == actor.id:
        return _fail("You cannot change your own account status.", 403)
    if (
        target["role"] == "SUPER_ADMIN"
        and status != "active"
        and accounts.active_super_admin_count() <= 1
    ):
        return _fail("The workspace needs at least one active super administrator.", 409)

    accounts.admin_update(admin_id, status=status)
    if status != "active":
        # Suspension must end live sessions immediately, not at the next expiry.
        accounts.admin_sessions_revoke_all(admin_id)
    accounts.audit_record(
        actor_id=actor.id,
        actor_role=actor.role,
        action="admin.status_change",
        detail={"admin_id": admin_id, "to": status},
        ip=request.remote_addr,
    )
    if _wants_json():
        return jsonify({"ok": True, "status": status})
    return redirect(url_for("admin_users.administrators"))


@admin_users.post("/administrators/<int:admin_id>/password")
@auth.require("admins.manage")
def reset_password(admin_id):
    actor = auth.current_actor()
    target = accounts.admin_get(admin_id)
    if target is None:
        return _fail("Account not found.", 404)

    payload = request.get_json(silent=True) or request.form
    password = payload.get("password") or ""
    confirm = payload.get("password_confirm")
    if confirm is None:
        confirm = password
    problems = auth.password_problems(password, confirm)
    if problems:
        return _fail(problems[0], errors=problems)

    accounts.admin_set_password(admin_id, auth.hash_password(password))
    accounts.audit_record(
        actor_id=actor.id,
        actor_role=actor.role,
        action="admin.password_reset",
        detail={"admin_id": admin_id},
        ip=request.remote_addr,
    )
    if _wants_json():
        return jsonify({"ok": True})
    return redirect(url_for("admin_users.administrators"))


@admin_users.get("/administrators/audit")
@auth.require("audit.view")
def audit_log():
    actor = auth.current_actor()
    try:
        limit = min(500, max(1, int(request.args.get("limit", 200))))
    except (TypeError, ValueError):
        limit = 200
    trip_id = request.args.get("trip_id")
    trip_id = int(trip_id) if trip_id and trip_id.isdigit() else None
    entries = accounts.audit_list(limit=limit, trip_id=trip_id)
    return render_template(
        "audit.html",
        current_nav="audit",
        page_title="Audit log",
        page_subtitle="Every administrative action and sign-in attempt, newest first.",
        entries=entries,
        limit=limit,
        trip_filter=trip_id,
        actor=actor,
    )
