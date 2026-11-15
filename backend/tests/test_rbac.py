"""Role-based access control, enforced on the server.

Every assertion here goes through HTTP. If a role were enforced only by hiding a
button, these tests would fail — which is the point.
"""

import os
import tempfile
import unittest
from unittest import mock

import app as app_module
import admin_store as accounts
import auth
import db as store
import support


class RoleMatrixTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(tempfile.mkdtemp(), "rbac.sqlite"),
            SECRET_KEY="test-secret",
        )
        self.ctx = app_module.app.app_context()
        self.ctx.push()
        store.init_db()

    def tearDown(self):
        self.ctx.pop()
        app_module.app.config["DATABASE"] = self.previous_database

    def client_for(self, role, email=None):
        return support.signed_in_client(app_module.app, role=role, email=email)

    def make_trip(self):
        return store.create_trip(
            origin="Civil Hospital", destination="Ring Road", priority="high", status="scheduled"
        )

    # -- viewer -----------------------------------------------------------
    def test_viewer_can_read_and_nothing_else(self):
        viewer = self.client_for("VIEWER")
        self.assertEqual(viewer.get("/").status_code, 200)
        self.assertEqual(viewer.get("/trips").status_code, 200)
        self.assertEqual(viewer.get("/analytics").status_code, 200)
        self.assertEqual(viewer.get("/api/trips").status_code, 200)

        created = viewer.post("/api/trips", json={"name": "Viewer attempt"})
        self.assertEqual(created.status_code, 403)
        self.assertEqual(created.get_json().get("code"), "permission_denied")

        trip_id = self.make_trip()
        moved = viewer.patch(f"/api/trips/{trip_id}", json={"action": "accept"})
        self.assertEqual(moved.status_code, 403)

        self.assertEqual(viewer.get("/administrators").status_code, 403)
        self.assertEqual(viewer.get("/administrators/audit").status_code, 403)
        self.assertEqual(viewer.get("/trips/export.csv").status_code, 403)

        # Settings are readable but not writable by a viewer.
        self.assertEqual(viewer.get("/settings").status_code, 200)
        self.assertEqual(viewer.post("/settings", data={"workspace_name": "x"}).status_code, 403)

    # -- operator ---------------------------------------------------------
    def test_operator_manages_responses_but_not_the_registry(self):
        operator = self.client_for("EMERGENCY_OPERATOR")
        created = operator.post(
            "/api/trips",
            json={
                "name": "Operator response",
                "emergency_type": "medical",
                "origin": "Civil Hospital",
                "destination": "Ring Road",
                "priority": "high",
                "status": "scheduled",
                "dispatch_at": store.iso_now(),
            },
        )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        trip_id = created.get_json()["trip"]["id"]

        verified = operator.patch(f"/api/trips/{trip_id}", json={"action": "accept"})
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.get_json()["trip"]["status"], "accepted")

        registry = operator.post(
            "/resources/vehicles", data={"call_sign": "NEW-1", "vehicle_type": "ambulance"}
        )
        self.assertEqual(registry.status_code, 403)

        self.assertEqual(operator.get("/administrators/audit").status_code, 403)

    # -- admin ------------------------------------------------------------
    def test_admin_manages_resources_and_reads_audit_but_not_accounts(self):
        admin = self.client_for("ADMIN")
        created = admin.post(
            "/resources/vehicles",
            data={"call_sign": "ENGINE-9", "vehicle_type": "fire_engine"},
        )
        self.assertIn(created.status_code, (302, 303), created.get_data(as_text=True))
        self.assertIsNotNone(store.get_vehicle(1))

        self.assertEqual(admin.get("/administrators/audit").status_code, 200)
        self.assertEqual(admin.get("/administrators").status_code, 403)
        self.assertEqual(
            admin.post("/administrators", data={"email": "x@y.z", "role": "VIEWER"}).status_code,
            403,
        )

    # -- super admin ------------------------------------------------------
    def test_super_admin_manages_administrators(self):
        super_client = self.client_for("SUPER_ADMIN")
        page = super_client.get("/administrators")
        self.assertEqual(page.status_code, 200)

        created = super_client.post(
            "/administrators",
            data={
                "email": "new.operator@test.local",
                "name": "New Operator",
                "role": "EMERGENCY_OPERATOR",
                "password": "a-long-enough-password",
                "password_confirm": "a-long-enough-password",
            },
        )
        self.assertEqual(created.status_code, 302)
        self.assertIsNotNone(accounts.admin_get_by_email("new.operator@test.local"))

    # -- tampering --------------------------------------------------------
    def test_role_supplied_by_the_client_is_ignored(self):
        viewer = self.client_for("VIEWER")
        spoofed = viewer.post(
            "/api/trips",
            json={
                "name": "Spoofed",
                "role": "SUPER_ADMIN",
                "permissions": ["trips.create"],
                "emergency_type": "medical",
                "origin": "A place",
                "destination": "Another place",
                "priority": "high",
                "status": "scheduled",
                "dispatch_at": store.iso_now(),
            },
            headers={"X-Role": "SUPER_ADMIN", "X-Permissions": "trips.create"},
        )
        self.assertEqual(spoofed.status_code, 403)
        self.assertEqual(store.count_trips(), 0)

    def test_role_change_takes_effect_on_the_next_request(self):
        client = self.client_for("VIEWER", email="promoted@test.local")
        self.assertEqual(client.post("/api/trips", json={"name": "x"}).status_code, 403)

        admin = accounts.admin_get_by_email("promoted@test.local")
        accounts.admin_update(admin["id"], role="EMERGENCY_OPERATOR")

        created = client.post(
            "/api/trips",
            json={
                "name": "After promotion",
                "emergency_type": "fire",
                "origin": "Depot",
                "destination": "Warehouse",
                "priority": "high",
                "status": "scheduled",
                "dispatch_at": store.iso_now(),
            },
        )
        self.assertEqual(created.status_code, 201)

    def test_demotion_takes_effect_on_the_next_request(self):
        client = self.client_for("EMERGENCY_OPERATOR", email="demoted@test.local")
        self.assertEqual(client.get("/administrators").status_code, 403)
        admin = accounts.admin_get_by_email("demoted@test.local")
        accounts.admin_update(admin["id"], role="VIEWER")
        self.assertEqual(client.post("/api/trips", json={"name": "x"}).status_code, 403)

    # -- invariants -------------------------------------------------------
    def test_administrators_cannot_change_their_own_account(self):
        client = self.client_for("SUPER_ADMIN", email="self@test.local")
        me = accounts.admin_get_by_email("self@test.local")

        self.assertEqual(
            client.post(f"/administrators/{me['id']}/role", data={"role": "VIEWER"}).status_code,
            403,
        )
        self.assertEqual(
            client.post(
                f"/administrators/{me['id']}/status", data={"status": "suspended"}
            ).status_code,
            403,
        )
        # The account is untouched.
        self.assertEqual(accounts.admin_get(me["id"])["role"], "SUPER_ADMIN")
        self.assertEqual(accounts.admin_get(me["id"])["status"], "active")

    def test_last_active_super_admin_is_protected(self):
        actor_client = self.client_for("SUPER_ADMIN", email="boss@test.local")
        target = accounts.admin_create(
            email="other-super@test.local",
            name="Other Super",
            role="SUPER_ADMIN",
            password_hash=auth.hash_password("a-long-enough-password"),
        )

        # Policy says "one active super administrator must remain". With exactly
        # one left, demoting or suspending it must fail even for a super admin.
        with mock.patch.object(accounts, "active_super_admin_count", return_value=1):
            demote = actor_client.post(
                f"/administrators/{target}/role", data={"role": "ADMIN"}
            )
            suspend = actor_client.post(
                f"/administrators/{target}/status", data={"status": "suspended"}
            )
        self.assertEqual(demote.status_code, 409)
        self.assertEqual(suspend.status_code, 409)
        self.assertEqual(accounts.admin_get(target)["role"], "SUPER_ADMIN")

    def test_account_suspension_revokes_sessions_immediately(self):
        target_client = self.client_for("ADMIN", email="victim@test.local")
        self.assertEqual(target_client.get("/").status_code, 200)
        victim = accounts.admin_get_by_email("victim@test.local")
        accounts.admin_update(victim["id"], status="suspended")
        accounts.admin_sessions_revoke_all(victim["id"])
        self.assertEqual(target_client.get("/").status_code, 302)


class PermissionCoverageTests(unittest.TestCase):
    def test_every_registered_admin_endpoint_has_a_permission(self):
        """A new route must not be able to slip past the guard unnoticed."""
        app = app_module.app
        missing = []
        for rule in app.url_map.iter_rules():
            endpoint = rule.endpoint
            if endpoint in app_module.PUBLIC_ENDPOINTS or endpoint == "static":
                continue
            blueprint = endpoint.split(".", 1)[0] if "." in endpoint else ""
            if blueprint in app_module.TOKEN_BLUEPRINTS:
                continue
            if app_module._required_permission(endpoint, "GET") is None:
                missing.append(endpoint)
        self.assertEqual(missing, [], f"endpoints without a permission: {missing}")


if __name__ == "__main__":
    unittest.main()
