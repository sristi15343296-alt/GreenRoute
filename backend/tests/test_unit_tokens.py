"""Unit credentials: issued by the console, hashed at rest, revocable.

These tests pin the properties the driver API depends on — a code authenticates
its own vehicle and nothing else, rotation kills the previous code, revocation
locks the unit out — and the migration behaviour for vehicles that predate the
change.
"""

import os
import tempfile
import unittest
from unittest import mock

import app as app_module
import db as store
import support
import unit_tokens


class UnitTokenTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.tempdir.name, "tokens.sqlite"),
        )
        self.context = app_module.app.app_context()
        self.context.push()
        store.init_db()
        self.client = app_module.app.test_client()
        self.unit_id = store.create_vehicle(call_sign="MED-12", vehicle_type="ambulance")

    def tearDown(self):
        self.context.pop()
        app_module.app.config["DATABASE"] = self.previous_database
        self.tempdir.cleanup()

    def unit_authentication(self, token):
        return self.client.get(
            "/api/driver/unit", headers={"Authorization": f"Bearer {token}"}
        )

    # ---- issue, use ---------------------------------------------------------

    def test_issued_code_authenticates_its_vehicle(self):
        token = support.issue_unit_token(self.unit_id)
        response = self.unit_authentication(token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["call_sign"], "MED-12")

    def test_a_code_is_not_the_call_sign(self):
        token = support.issue_unit_token(self.unit_id)
        self.assertTrue(token.startswith(unit_tokens.TOKEN_PREFIX))
        self.assertNotIn("med12", token.lower())
        self.assertGreaterEqual(len(token), 32)

    def test_codes_are_unique_across_units(self):
        second = store.create_vehicle(call_sign="MED-13", vehicle_type="rescue_unit")
        first_token = support.issue_unit_token(self.unit_id)
        second_token = support.issue_unit_token(second)
        self.assertNotEqual(first_token, second_token)

    def test_only_the_digest_is_stored(self):
        token = support.issue_unit_token(self.unit_id)
        row = store.get_db().execute(
            "SELECT token_hash, token_issued_at FROM vehicles WHERE id = ?",
            (self.unit_id,),
        ).fetchone()
        self.assertEqual(row["token_hash"], unit_tokens.digest(token))
        self.assertNotIn(token, row["token_hash"])
        self.assertTrue(row["token_issued_at"])

    def test_digest_is_not_exposed_by_the_vehicle_row(self):
        support.issue_unit_token(self.unit_id)
        vehicle = store.get_vehicle(self.unit_id)
        self.assertNotIn("token_hash", vehicle)
        self.assertTrue(vehicle["has_token"])

    def test_unknown_code_is_rejected(self):
        response = self.unit_authentication("gr_not-a-real-code")
        self.assertEqual(response.status_code, 401)

    def test_empty_bearer_is_rejected(self):
        response = self.client.get(
            "/api/driver/unit", headers={"Authorization": "Bearer "}
        )
        self.assertEqual(response.status_code, 401)

    # ---- rotation and revocation -------------------------------------------

    def test_rotation_invalidates_the_previous_code(self):
        first = support.issue_unit_token(self.unit_id)
        second = unit_tokens.issue(self.unit_id)
        self.assertNotEqual(first, second)
        self.assertEqual(self.unit_authentication(first).status_code, 401)
        self.assertEqual(self.unit_authentication(second).status_code, 200)

    def test_revoked_code_is_rejected_until_a_new_one_is_issued(self):
        token = support.issue_unit_token(self.unit_id)
        self.assertTrue(unit_tokens.revoke(self.unit_id))
        self.assertEqual(self.unit_authentication(token).status_code, 401)
        self.assertFalse(store.get_vehicle(self.unit_id)["has_token"])

        replacement = unit_tokens.issue(self.unit_id)
        self.assertEqual(self.unit_authentication(replacement).status_code, 200)
        self.assertEqual(self.unit_authentication(token).status_code, 401)

    def test_issue_for_a_missing_vehicle_returns_none(self):
        self.assertIsNone(unit_tokens.issue(999999))

    def test_revoke_for_a_missing_vehicle_is_false(self):
        self.assertFalse(unit_tokens.revoke(999999))

    # ---- the old call-sign scheme ------------------------------------------

    def test_call_sign_is_not_a_credential_by_default(self):
        response = self.unit_authentication("token-med12")
        self.assertEqual(response.status_code, 401)

    def test_legacy_flag_accepts_the_call_sign_form(self):
        with mock.patch.dict(os.environ, {unit_tokens.LEGACY_ENV: "1"}):
            response = self.unit_authentication("token-med12")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["call_sign"], "MED-12")

    def test_legacy_flag_still_rejects_an_unknown_call_sign(self):
        with mock.patch.dict(os.environ, {unit_tokens.LEGACY_ENV: "1"}):
            response = self.unit_authentication("token-fire99")
        self.assertEqual(response.status_code, 401)

    # ---- migration ----------------------------------------------------------

    def test_backfill_issues_codes_for_vehicles_without_one(self):
        support.issue_unit_token(self.unit_id)
        legacy_unit = store.create_vehicle(call_sign="FIRE-7", vehicle_type="fire_engine")

        issued = unit_tokens.backfill(self.tempdir.name)
        self.assertEqual([call_sign for call_sign, _ in issued], ["FIRE-7"])
        call_sign, token = issued[0]
        self.assertEqual(call_sign, "FIRE-7")
        self.assertEqual(self.unit_authentication(token).status_code, 200)

        path = os.path.join(self.tempdir.name, unit_tokens.TOKENS_FILENAME)
        with open(path, encoding="utf-8") as handle:
            contents = handle.read()
        self.assertIn(token, contents)
        self.assertIn("FIRE-7", contents)
        self.assertNotEqual(legacy_unit, self.unit_id)

    def test_backfill_leaves_existing_codes_alone(self):
        token = support.issue_unit_token(self.unit_id)
        self.assertEqual(unit_tokens.backfill(self.tempdir.name), [])
        self.assertEqual(self.unit_authentication(token).status_code, 200)


class UnitTokenConsoleTestCase(unittest.TestCase):
    """The Resources screen is where a code is issued, so that is what runs."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.tempdir.name, "console.sqlite"),
        )
        self.context = app_module.app.app_context()
        self.context.push()
        store.init_db()
        self.unit_id = store.create_vehicle(call_sign="MED-12", vehicle_type="ambulance")

    def tearDown(self):
        self.context.pop()
        app_module.app.config["DATABASE"] = self.previous_database
        self.tempdir.cleanup()

    def test_an_operator_can_issue_and_revoke_from_the_registry(self):
        client = support.signed_in_client(app_module.app, role="ADMIN")

        page = client.post(f"/resources/vehicles/{self.unit_id}/token")
        self.assertEqual(page.status_code, 200)
        body = page.get_data(as_text=True)
        self.assertIn("MED-12", body)
        self.assertIn(unit_tokens.TOKEN_PREFIX, body)

        self.assertTrue(store.get_vehicle(self.unit_id)["has_token"])

        revoked = client.post(f"/resources/vehicles/{self.unit_id}/token/revoke")
        self.assertEqual(revoked.status_code, 302)
        self.assertFalse(store.get_vehicle(self.unit_id)["has_token"])

    def test_a_viewer_cannot_issue_a_code(self):
        client = support.signed_in_client(app_module.app, role="VIEWER")
        response = client.post(f"/resources/vehicles/{self.unit_id}/token")
        self.assertEqual(response.status_code, 403)
        self.assertFalse(store.get_vehicle(self.unit_id)["has_token"])

    def test_issuing_for_a_missing_vehicle_is_404(self):
        client = support.signed_in_client(app_module.app, role="ADMIN")
        response = client.post("/resources/vehicles/999999/token")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
