"""Focused tests for the response lifecycle, availability and status exports."""

import os
import tempfile
import unittest
from datetime import timedelta

import app as app_module
import support
import db as store


class TripStatusTestCase(unittest.TestCase):
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
        self.client = support.signed_in_client(app_module.app)

    def tearDown(self):
        self.context.pop()
        app_module.app.config["DATABASE"] = self.previous_database
        self.tempdir.cleanup()

    def make_trip(self, status="scheduled", vehicle_id=None, duration_min=120):
        return store.create_trip(
            origin="Civil Hospital, Jalandhar",
            destination="Amritsar, Punjab",
            priority="high",
            status=status,
            duration_min=duration_min,
            dispatch_at=store.iso_now(),
            vehicle_id=vehicle_id,
        )

    def advance(self, trip_id, *actions):
        for action in actions:
            store.update_status(trip_id, action)

    def test_full_driver_sequence(self):
        trip_id = self.make_trip()
        self.advance(trip_id, "accept")
        accepted = store.get_trip(trip_id)
        self.assertEqual(accepted["status"], "accepted")
        self.assertIsNone(accepted["started_at"])

        self.advance(trip_id, "depart")
        en_route = store.get_trip(trip_id)
        self.assertEqual(en_route["status"], "in_transit")
        self.assertIsNotNone(en_route["started_at"])

        self.advance(trip_id, "arrive")
        on_scene = store.get_trip(trip_id)
        self.assertEqual(on_scene["status"], "on_scene")
        self.assertIsNone(on_scene["completed_at"])

        self.advance(trip_id, "complete")
        completed = store.get_trip(trip_id)
        self.assertEqual(completed["status"], "completed")
        self.assertIsNotNone(completed["completed_at"])
        self.assertEqual(
            [event["kind"] for event in store.trip_events(trip_id)],
            ["created", "accepted", "departed", "arrived", "completed"],
        )

    def test_existing_complete_from_en_route_still_works(self):
        trip_id = self.make_trip()
        self.advance(trip_id, "start", "complete")
        completed = store.get_trip(trip_id)
        self.assertEqual(completed["status"], "completed")
        self.assertIsNotNone(completed["completed_at"])

    def test_operator_override_start_skips_acceptance(self):
        trip_id = self.make_trip()
        self.advance(trip_id, "start")
        trip = store.get_trip(trip_id)
        self.assertEqual(trip["status"], "in_transit")
        self.assertIsNotNone(trip["started_at"])

    def test_cancel_is_terminal_from_every_open_state(self):
        open_sequences = {
            "scheduled": (),
            "accepted": ("accept",),
            "in_transit": ("start",),
            "on_scene": ("start", "arrive"),
        }
        for label, actions in open_sequences.items():
            with self.subTest(status=label):
                trip_id = self.make_trip()
                self.advance(trip_id, *actions)
                self.advance(trip_id, "cancel")
                cancelled = store.get_trip(trip_id)
                self.assertEqual(cancelled["status"], "cancelled")
                self.assertIsNotNone(cancelled["cancelled_at"])
                with self.assertRaises(ValueError):
                    store.update_status(trip_id, "cancel")

    def test_illegal_transitions_are_rejected_with_a_message(self):
        cases = {
            "acceptFromEnRoute": ("start", "accept"),
            "departFromScheduled": ("depart",),
            "arriveFromAccepted": ("accept", "arrive"),
            "completeFromScheduled": ("complete",),
            "completeFromAccepted": ("accept", "complete"),
        }
        for label, actions in cases.items():
            with self.subTest(case=label):
                trip_id = self.make_trip()
                with self.assertRaises(ValueError) as caught:
                    self.advance(trip_id, *actions)
                self.assertTrue(str(caught.exception).strip())

    def test_open_count_includes_accepted_and_on_scene(self):
        accepted_id = self.make_trip()
        self.advance(accepted_id, "accept")
        on_scene_id = self.make_trip()
        self.advance(on_scene_id, "start", "arrive")
        self.make_trip()
        completed_id = self.make_trip()
        self.advance(completed_id, "start", "complete")
        cancelled_id = self.make_trip()
        self.advance(cancelled_id, "cancel")

        counts = store.status_counts()
        self.assertEqual(counts["accepted"], 1)
        self.assertEqual(counts["on_scene"], 1)
        self.assertEqual(counts["open"], 3)
        self.assertEqual(counts["all"], 5)

        summary = store.dashboard_summary()
        self.assertEqual(summary["accepted"], 1)
        self.assertEqual(summary["on_scene"], 1)
        self.assertEqual(summary["open"], 3)

    def test_vehicle_on_scene_is_not_reported_available(self):
        vehicle_id = store.create_vehicle(
            call_sign="MEDIC-77",
            vehicle_type="ambulance",
            status="available",
        )
        trip_id = self.make_trip(vehicle_id=vehicle_id, duration_min=120)
        self.advance(trip_id, "start", "arrive")

        availability = store.resource_availability(
            dispatch_at=(store.utcnow() + timedelta(minutes=30)).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            duration_min=60,
        )
        vehicle = next(
            item for item in availability["vehicles"] if item["id"] == vehicle_id
        )
        self.assertFalse(vehicle["available"])
        self.assertIn("Assigned to", vehicle["reason"])

    def test_vehicle_assigned_at_creation_starts_scheduled(self):
        vehicle_id = store.create_vehicle(
            call_sign="MEDIC-88",
            vehicle_type="ambulance",
            status="available",
        )
        form = {
            "name": "Crewed response",
            "emergency_type": "medical",
            "origin": "Civil Hospital, Jalandhar",
            "destination": "Amritsar, Punjab",
            "priority": "high",
            "status": "in_transit",
            "dispatch_at": "2026-11-10T12:00",
            "vehicle_id": str(vehicle_id),
            "status_explicit": "0",
        }
        response = self.client.post("/trips/new", data=form)
        self.assertEqual(response.status_code, 302)
        trip = store.list_trips()[0]
        self.assertEqual(trip["status"], "scheduled")
        self.assertEqual(trip["vehicle_id"], vehicle_id)

        second_vehicle = store.create_vehicle(
            call_sign="MEDIC-89",
            vehicle_type="ambulance",
            status="available",
        )
        explicit = dict(
            form,
            name="Explicit response",
            vehicle_id=str(second_vehicle),
            status_explicit="1",
        )
        response = self.client.post("/trips/new", data=explicit)
        self.assertEqual(response.status_code, 302)
        latest = store.list_trips()[0]
        self.assertEqual(latest["status"], "in_transit")

    def test_register_filter_and_csv_use_new_statuses_and_labels(self):
        accepted_id = self.make_trip()
        self.advance(accepted_id, "accept")
        on_scene_id = self.make_trip()
        self.advance(on_scene_id, "start", "arrive")

        self.assertEqual(len(store.list_trips(status="accepted")), 1)
        self.assertEqual(len(store.list_trips(status="on_scene")), 1)
        with self.assertRaises(ValueError):
            store.list_trips(status="on_scène")

        response = self.client.get("/trips/export.csv")
        self.assertEqual(response.status_code, 200)
        body = response.data.decode("utf-8-sig")
        self.assertIn("Accepted", body)
        self.assertIn("On scene", body)

        detail = self.client.get(f"/trips/{on_scene_id}/export.csv")
        self.assertEqual(detail.status_code, 200)
        self.assertIn("On scene", detail.data.decode("utf-8-sig"))


if __name__ == "__main__":
    unittest.main()
