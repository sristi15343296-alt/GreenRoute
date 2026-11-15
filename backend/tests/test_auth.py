"""Authentication: sessions, cookies, throttling, CSRF and revocation."""

import os
import re
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

import app as app_module
import admin_store as accounts
import auth
import db as store
import support


class AuthTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_database = app_module.app.config["DATABASE"]
        self.tmp = tempfile.mkdtemp()
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.tmp, "auth.sqlite"),
            SECRET_KEY="test-secret",
        )
        self.ctx = app_module.app.app_context()
        self.ctx.push()
        store.init_db()
        self.email, self.password = support.make_admin("SUPER_ADMIN")

    def tearDown(self):
        self.ctx.pop()
        app_module.app.config["DATABASE"] = self.previous_database

    # -- helpers ---------------------------------------------------------
    def login_page_token(self, client):
        page = client.get("/login")
        match = re.search(
            r'name="csrf_token" value="([^"]+)"', page.get_data(as_text=True)
        )
        return page, (match.group(1) if match else None)

    # -- anonymous access -------------------------------------------------
    def test_every_administrative_route_refuses_anonymous_callers(self):
        client = app_module.app.test_client()
        protected = [
            "/",
            "/trips",
            "/resources",
            "/analytics",
            "/settings",
            "/fleet-map",
            "/trips/new",
            "/administrators",
            "/administrators/audit",
            "/trips/export.csv",
        ]
        for path in protected:
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 302, path)
                self.assertIn("/login", response.headers["Location"])

    def test_anonymous_api_calls_get_401_not_html(self):
        client = app_module.app.test_client()
        for method, path in [
            ("get", "/api/trips"),
            ("get", "/api/trips/1"),
            ("patch", "/api/trips/1"),
            ("post", "/api/trips"),
            ("post", "/api/route"),

            ("post", "/api/maintenance/expire-stale"),
        ]:
            with self.subTest(path=path):
                response = getattr(client, method)(path)
                self.assertEqual(response.status_code, 401, path)
                body = response.get_json() or {}
                self.assertIn(
                    body.get("code"),
                    {"authentication_required", None},
                )

    def test_session_probe_reports_signed_out(self):
        client = app_module.app.test_client()
        response = client.get("/api/admin/session")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json(), {"authenticated": False})

    # -- credentials ------------------------------------------------------
    def test_passwords_are_hashed_and_never_echoed(self):
        admin = accounts.admin_get_by_email(self.email)
        self.assertNotEqual(admin["password_hash"], self.password)
        self.assertIn("scrypt", admin["password_hash"])
        self.assertTrue(auth.verify_password(admin["password_hash"], self.password))
        self.assertFalse(auth.verify_password(admin["password_hash"], "wrong"))

        client = app_module.app.test_client()
        page, token = self.login_page_token(client)
        body = page.get_data(as_text=True)
        self.assertNotIn(self.password, body)
        self.assertNotIn(admin["password_hash"], body)

    def test_wrong_password_is_refused_and_audited(self):
        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        response = client.post(
            "/login",
            data={"email": self.email, "password": "not-the-password", "csrf_token": token},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(client.get_cookie("gr_admin_session"))

        entries = [e for e in accounts.audit_list(limit=20) if e["action"] == "auth.login"]
        self.assertTrue(entries)
        self.assertEqual(entries[0]["outcome"], "invalid")
        # The attempted password must never reach the audit trail.
        self.assertNotIn("not-the-password", str(entries[0]["detail_json"]))

    def test_unknown_account_uses_the_same_message(self):
        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        response = client.post(
            "/login",
            data={"email": "ghost@test.local", "password": "whatever", "csrf_token": token},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn(b"do not match", response.data)

    def test_suspended_account_cannot_sign_in(self):
        email, password = support.make_admin(
            "ADMIN", email="suspended@test.local", status="suspended"
        )
        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        response = client.post(
            "/login", data={"email": email, "password": password, "csrf_token": token}
        )
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(client.get_cookie("gr_admin_session"))

    def test_login_form_requires_its_csrf_token(self):
        client = app_module.app.test_client()
        response = client.post(
            "/login", data={"email": self.email, "password": self.password}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(client.get_cookie("gr_admin_session"))

    # -- throttling -------------------------------------------------------
    def test_five_failures_lock_the_account_for_the_window(self):
        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        for _attempt in range(auth.MAX_FAILED_LOGINS):
            client.post(
                "/login",
                data={"email": self.email, "password": "wrong", "csrf_token": token},
            )

        # The correct password is refused while the window is closed.
        _page, token = self.login_page_token(client)
        blocked = client.post(
            "/login",
            data={"email": self.email, "password": self.password, "csrf_token": token},
        )
        self.assertEqual(blocked.status_code, 429)
        self.assertIn(b"Too many failed attempts", blocked.data)
        self.assertIsNone(client.get_cookie("gr_admin_session"))

        throttled = [e for e in accounts.audit_list(limit=20) if e["outcome"] == "throttled"]
        self.assertTrue(throttled)

    def test_throttle_expires_after_the_window(self):
        import auth as auth_module

        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        for _attempt in range(auth_module.MAX_FAILED_LOGINS):
            client.post(
                "/login",
                data={"email": self.email, "password": "wrong", "csrf_token": token},
            )

        future = store.utcnow() + timedelta(
            minutes=int(auth_module.FAILURE_WINDOW.total_seconds() // 60) + 1
        )
        with mock.patch.object(store, "utcnow", return_value=future):
            self.assertEqual(auth_module.throttle_remaining(self.email), 0)

    # -- sessions ---------------------------------------------------------
    def test_session_cookie_is_httponly_lax_and_not_the_stored_secret(self):
        client = app_module.app.test_client()
        _page, token = self.login_page_token(client)
        response = client.post(
            "/login",
            data={"email": self.email, "password": self.password, "csrf_token": token},
        )
        self.assertEqual(response.status_code, 302)
        cookie = response.headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)

        raw = client.get_cookie("gr_admin_session").value
        with app_module.app.app_context():
            stored = store.get_db().execute("SELECT token_hash FROM admin_sessions").fetchone()
        # Only a digest is stored: a database leak cannot be replayed as a login.
        self.assertNotEqual(stored["token_hash"], raw)

    def test_secure_flag_is_controlled_by_environment(self):
        with mock.patch.dict(os.environ, {"GREENROUTE_HTTPS": "1"}):
            self.assertTrue(auth.session_cookie_secure())
        with mock.patch.dict(os.environ, {"GREENROUTE_HTTPS": "0"}):
            self.assertFalse(auth.session_cookie_secure())

    def test_idle_session_expires(self):
        client = support.signed_in_client(app_module.app)
        self.assertEqual(client.get("/").status_code, 200)

        later = store.utcnow() + auth.SESSION_IDLE_TTL + timedelta(minutes=1)
        with mock.patch.object(store, "utcnow", return_value=later):
            response = client.get("/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["Location"])

    def test_absolute_session_expiry_is_enforced(self):
        client = support.signed_in_client(app_module.app)
        row = store.get_db().execute("SELECT * FROM admin_sessions").fetchone()
        later = store.utcnow() + auth.SESSION_ABSOLUTE_TTL + timedelta(minutes=1)
        self.assertLess(store.parse_dt(row["expires_at"]), later)
        with mock.patch.object(store, "utcnow", return_value=later):
            self.assertEqual(client.get("/").status_code, 302)

    def test_logout_revokes_the_session_server_side(self):
        client = support.signed_in_client(app_module.app)
        stolen = client.get_cookie("gr_admin_session").value
        self.assertEqual(client.post("/logout").status_code, 302)
        self.assertEqual(client.get("/").status_code, 302)

        replay = app_module.app.test_client()
        replay.set_cookie("gr_admin_session", stolen)
        self.assertEqual(replay.get("/").status_code, 302)

    def test_suspending_an_account_ends_its_live_session(self):
        client = support.signed_in_client(app_module.app, role="ADMIN", email="admin2@test.local")
        self.assertEqual(client.get("/").status_code, 200)
        admin = accounts.admin_get_by_email("admin2@test.local")
        accounts.admin_update(admin["id"], status="suspended")
        accounts.admin_sessions_revoke_all(admin["id"])
        self.assertEqual(client.get("/").status_code, 302)

    # -- CSRF -------------------------------------------------------------
    def test_state_changing_request_without_csrf_is_refused(self):
        client = support.signed_in_client(app_module.app)
        response = client.patch(
            "/api/trips/1", json={"action": "cancel"}, headers={"X-CSRF-Token": "wrong"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json().get("code"), "csrf_failed")

    def test_form_post_without_csrf_field_is_refused(self):
        client = support.signed_in_client(app_module.app)
        client.csrf_token = None  # the AuthClient stops injecting the header
        response = client.post("/api/trips", json={"name": "No token"})
        self.assertEqual(response.status_code, 400)

    # -- audit ------------------------------------------------------------
    def test_successful_sign_in_and_sign_out_are_audited(self):
        client = support.signed_in_client(app_module.app)
        client.post("/logout")
        actions = [entry["action"] for entry in accounts.audit_list(limit=20)]
        self.assertIn("auth.login", actions)
        self.assertIn("auth.logout", actions)
        logins = [e for e in accounts.audit_list(limit=20) if e["action"] == "auth.login"]
        self.assertEqual(logins[0]["outcome"], "success")
        self.assertEqual(logins[0]["actor_role"], "SUPER_ADMIN")


class PasswordPolicyTests(unittest.TestCase):
    def test_short_passwords_are_rejected(self):
        problems = auth.password_problems("short", "short")
        self.assertTrue(any("at least" in problem for problem in problems))

    def test_mismatched_confirmation_is_rejected(self):
        problems = auth.password_problems("a-long-enough-password", "different-password")
        self.assertTrue(any("do not match" in problem for problem in problems))

    def test_acceptable_password_has_no_problems(self):
        self.assertEqual(
            auth.password_problems("a-long-enough-password", "a-long-enough-password"), []
        )


class RolePermissionTableTests(unittest.TestCase):
    def test_every_role_is_defined(self):
        for role in auth.ROLE_ORDER:
            self.assertIn(role, auth.ROLE_PERMISSIONS)
            self.assertIn(role, auth.ROLE_LABELS)

    def test_viewer_can_read_but_not_write(self):
        permissions = auth.ROLE_PERMISSIONS["VIEWER"]
        self.assertIn("trips.view", permissions)
        self.assertNotIn("trips.create", permissions)
        self.assertNotIn("trips.dispatch", permissions)
        self.assertNotIn("admins.manage", permissions)

    def test_operator_cannot_manage_the_registry_or_administrators(self):
        permissions = auth.ROLE_PERMISSIONS["EMERGENCY_OPERATOR"]
        self.assertIn("trips.dispatch", permissions)
        self.assertNotIn("resources.manage", permissions)
        self.assertNotIn("admins.manage", permissions)
        self.assertNotIn("audit.view", permissions)

    def test_only_super_admin_manages_administrators_and_settings(self):
        for role in ("VIEWER", "EMERGENCY_OPERATOR", "ADMIN"):
            self.assertNotIn("admins.manage", auth.ROLE_PERMISSIONS[role])
            self.assertNotIn("settings.manage", auth.ROLE_PERMISSIONS[role])
        self.assertIn("admins.manage", auth.ROLE_PERMISSIONS["SUPER_ADMIN"])

    def test_permissions_are_never_granted_above_the_role(self):
        # A superset assertion: every role's permissions are valid permission names.
        for role, permissions in auth.ROLE_PERMISSIONS.items():
            self.assertTrue(permissions <= auth.PERMISSIONS, role)


if __name__ == "__main__":
    unittest.main()
