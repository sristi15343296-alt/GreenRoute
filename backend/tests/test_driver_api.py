"""The crew phone's contract.

These tests pin the parts a device depends on: the token scheme, the shape the
phone's parser accepts, idempotent retries, and the fact that one unit can never
read another unit's response.
"""

import os
import tempfile
import unittest

import app as app_module
import db as store
import support


class DriverApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.tempdir.name, "test.sqlite"),
        )
        self.context = app_module.app.app_context()
        self.context.push()
        store.init_db()
        self.client = app_module.app.test_client()

        self.unit_id = store.create_vehicle(call_sign="MED-12", vehicle_type="ambulance")
        self.other_id = store.create_vehicle(call_sign="MED-13", vehicle_type="rescue_unit")
        self.token = support.issue_unit_token(self.unit_id)
        self.auth = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        self.context.pop()
        app_module.app.config["DATABASE"] = self.previous_database
        self.tempdir.cleanup()

    def make_trip(self, status="scheduled", vehicle_id=None):
        return store.create_trip(
            origin="Marol Fire Station, Mumbai",
            destination="Saki Naka Industrial Estate, Mumbai",
            priority="critical",
            status=status,
            distance_km=3.4,
            duration_min=11,
            dispatch_at=store.iso_now(),
            vehicle_id=vehicle_id if vehicle_id is not None else self.unit_id,
            emergency_type="fire",
        )

    # ---- authentication ---------------------------------------------------

    def test_missing_token_is_rejected(self):
        response = self.client.get("/api/driver/unit")
        self.assertEqual(response.status_code, 401)

    def test_unknown_unit_is_rejected(self):
        response = self.client.get(
            "/api/driver/unit", headers={"Authorization": "Bearer gr_unknown"}
        )
        self.assertEqual(response.status_code, 401)

    def test_issued_unit_code_authenticates(self):
        response = self.client.get("/api/driver/unit", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["call_sign"], "MED-12")

    def test_another_units_code_cannot_read_this_unit(self):
        other = support.issue_unit_token(self.other_id)
        response = self.client.get(
            "/api/driver/unit", headers={"Authorization": f"Bearer {other}"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["call_sign"], "MED-13")

    # ---- the shape the phone parses --------------------------------------

    def test_unit_payload_has_every_field_the_parser_requires(self):
        trip = self.make_trip()
        body = self.client.get("/api/driver/unit", headers=self.auth).get_json()

        for key in ("call_sign", "vehicle_type", "assignment", "queue_count", "server_time"):
            self.assertIn(key, body)

        assignment = body["assignment"]
        self.assertEqual(assignment["id"], trip)
        for key in (
            "id",
            "reference",
            "status",
            "status_label",
            "priority",
            "priority_label",
            "origin",
            "destination",
            "dispatch_at",
            "timeline",
            "next_actions",
        ):
            self.assertIn(key, assignment)
        self.assertEqual(assignment["next_actions"], ["accept"])

    def test_unit_with_no_open_response_returns_null_assignment(self):
        body = self.client.get("/api/driver/unit", headers=self.auth).get_json()
        self.assertIsNone(body["assignment"])
        self.assertEqual(body["queue_count"], 0)

    def test_assignments_lists_only_this_unit(self):
        mine = self.make_trip()
        self.make_trip(vehicle_id=self.other_id)

        body = self.client.get("/api/driver/assignments", headers=self.auth).get_json()
        self.assertEqual([trip["id"] for trip in body["assignments"]], [mine])
        self.assertEqual(body["count"], 1)

    def test_one_unit_cannot_read_another_units_response(self):
        foreign = self.make_trip(vehicle_id=self.other_id)
        response = self.client.get(
            f"/api/driver/trips/{foreign}", headers=self.auth
        )
        self.assertEqual(response.status_code, 404)

    # ---- transitions ------------------------------------------------------

    def transition(self, trip_id, to, event_id, expected="scheduled"):
        return self.client.post(
            f"/api/driver/trips/{trip_id}/transition",
            headers=self.auth,
            json={
                "to": to,
                "expected_status": expected,
                "client_event_id": event_id,
                "client_at": store.iso_now(),
            },
        )

    def test_accept_moves_the_response_and_is_visible_to_both_clients(self):
        trip = self.make_trip()
        response = self.transition(trip, "accepted", "evt-1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trip"]["status"], "accepted")

        # The admin screens read the same row, so they see it too.
        self.assertEqual(store.get_trip(trip)["status"], "accepted")

    def test_replaying_the_same_event_id_does_not_apply_twice(self):
        trip = self.make_trip()
        self.transition(trip, "accepted", "evt-1")
        replay = self.transition(trip, "accepted", "evt-1")

        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.get_json()["replayed"])
        events = [
            row["kind"]
            for row in store.get_db().execute(
                "SELECT kind FROM trip_events WHERE trip_id = ?", (trip,)
            )
        ]
        self.assertEqual(events.count("accepted"), 1)

    def test_stale_expected_status_is_a_conflict_not_an_overwrite(self):
        trip = self.make_trip(status="accepted")
        response = self.transition(trip, "in_transit", "evt-2", expected="scheduled")

        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual(body["current_status"], "accepted")
        self.assertEqual(store.get_trip(trip)["status"], "accepted")

    def test_action_not_legal_from_current_status_is_refused(self):
        trip = self.make_trip()
        response = self.transition(trip, "completed", "evt-3")
        self.assertEqual(response.status_code, 409)

    def test_unknown_target_is_rejected(self):
        trip = self.make_trip()
        response = self.transition(trip, "teleported", "evt-4")
        self.assertEqual(response.status_code, 422)

    def test_transition_requires_an_event_id(self):
        trip = self.make_trip()
        response = self.client.post(
            f"/api/driver/trips/{trip}/transition",
            headers=self.auth,
            json={"to": "accepted"},
        )
        self.assertEqual(response.status_code, 422)

    def test_full_sequence_drives_the_shared_lifecycle(self):
        trip = self.make_trip()
        self.transition(trip, "accepted", "e1")
        self.transition(trip, "in_transit", "e2", expected="accepted")
        self.transition(trip, "on_scene", "e3", expected="in_transit")
        final = self.transition(trip, "completed", "e4", expected="on_scene")

        self.assertEqual(final.get_json()["trip"]["status"], "completed")
        self.assertTrue(store.get_trip(trip)["completed_at"] is not None)

    # ---- crew reports -----------------------------------------------------

    def test_issue_is_recorded_without_changing_status(self):
        trip = self.make_trip(status="accepted")
        response = self.client.post(
            f"/api/driver/trips/{trip}/issue",
            headers=self.auth,
            json={"category": "access", "note": "Gate locked"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trip"]["status"], "accepted")
        events = [row["kind"] for row in store.get_db().execute(
            "SELECT kind FROM trip_events WHERE trip_id = ?", (trip,)
        )]
        self.assertIn("issue", events)

    def test_backup_is_recorded_without_changing_status(self):
        trip = self.make_trip(status="in_transit")
        response = self.client.post(
            f"/api/driver/trips/{trip}/backup",
            headers=self.auth,
            json={"reason": "Second casualty"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trip"]["status"], "in_transit")

    def test_crew_report_on_a_foreign_response_is_refused(self):
        foreign = self.make_trip(vehicle_id=self.other_id)
        response = self.client.post(
            f"/api/driver/trips/{foreign}/issue",
            headers=self.auth,
            json={"category": "access"},
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
