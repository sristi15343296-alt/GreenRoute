"""The emergency lifecycle: legality, authority, atomicity and audit."""

import os
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

import app as app_module
import admin_store as accounts
import auth
import db as store
import lifecycle
import support


def operator_actor(role="EMERGENCY_OPERATOR", admin_id=99):
    return auth.Actor(
        id=admin_id,
        email=f"{role.lower()}@test.local",
        name=role.title(),
        role=role,
        session_id=1,
        csrf_token="csrf",
    )


class LifecycleTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(tempfile.mkdtemp(), "lifecycle.sqlite"),
            SECRET_KEY="test-secret",
        )
        self.ctx = app_module.app.app_context()
        self.ctx.push()
        store.init_db()
        self.actor = operator_actor()

    def tearDown(self):
        self.ctx.pop()
        app_module.app.config["DATABASE"] = self.previous_database

    def make_trip(self, status="scheduled", **kwargs):
        return store.create_trip(
            origin="Civil Hospital",
            destination="Ring Road",
            priority="high",
            status=status,
            **kwargs,
        )

    def state(self, trip_id):
        return store.emergency_session_for_trip(trip_id)["state"]

    def history(self, trip_id):
        session = store.emergency_session_for_trip(trip_id)
        return [
            (row["action"], row["from_state"], row["to_state"])
            for row in store.emergency_transitions(session["id"])
        ]

    # -- vocabulary -------------------------------------------------------
    def test_every_state_maps_to_a_trip_status(self):
        for state in lifecycle.STATES:
            self.assertIn(state, lifecycle.TRIP_STATUS_FOR_STATE)
            status = lifecycle.TRIP_STATUS_FOR_STATE[state]
            self.assertIn(status, store.STATUS_ORDER)

    def test_every_trip_status_projects_back_to_a_state(self):
        for status in store.STATUS_ORDER:
            self.assertIn(lifecycle.state_for_status(status), lifecycle.STATES)

    def test_approaching_is_not_a_state(self):
        self.assertNotIn("APPROACHING", lifecycle.STATES)
        self.assertNotIn("APPROACHING", lifecycle.TRANSITIONS)

    def test_each_trip_action_has_exactly_one_transition_owner(self):
        """Two lifecycle actions must never share a trip action by accident."""
        seen = {}
        for transition in lifecycle.TRANSITIONS.values():
            seen.setdefault(transition.trip_action, []).append(transition.action)
        for trip_action, actions in seen.items():
            if trip_action == "cancel":
                # Cancel and expire are the same trip action with different
                # meanings, which is exactly why the state differs.
                self.assertEqual(sorted(actions), ["cancel", "expire"])
            else:
                self.assertEqual(len(actions), 1, f"{trip_action}: {actions}")

    # -- happy path -------------------------------------------------------
    def test_full_path_reaches_every_state_in_order(self):
        trip_id = self.make_trip()
        self.assertEqual(self.state(trip_id), lifecycle.CREATED)

        lifecycle.apply(trip_id, "verify", self.actor)
        self.assertEqual(self.state(trip_id), lifecycle.VERIFIED)
        self.assertEqual(store.get_trip(trip_id)["status"], "accepted")

        lifecycle.apply(trip_id, "depart", self.actor)
        self.assertEqual(self.state(trip_id), lifecycle.ACTIVE)
        self.assertEqual(store.get_trip(trip_id)["status"], "in_transit")

        lifecycle.apply(trip_id, "arrive", self.actor)
        self.assertEqual(self.state(trip_id), lifecycle.ON_SCENE)

        lifecycle.apply(trip_id, "complete", self.actor)
        self.assertEqual(self.state(trip_id), lifecycle.COMPLETED)

        self.assertEqual(
            self.history(trip_id),
            [
                ("create", None, "CREATED"),
                ("verify", "CREATED", "VERIFIED"),
                ("depart", "VERIFIED", "ACTIVE"),
                ("arrive", "ACTIVE", "ON_SCENE"),
                ("complete", "ON_SCENE", "COMPLETED"),
            ],
        )

    def test_operator_dispatch_override_goes_straight_to_active(self):
        trip_id = self.make_trip()
        lifecycle.apply(trip_id, "activate", self.actor)
        self.assertEqual(self.state(trip_id), lifecycle.ACTIVE)

    def test_activation_metadata_is_recorded(self):
        trip_id = self.make_trip()
        lifecycle.apply(trip_id, "verify", self.actor)
        lifecycle.apply(trip_id, "depart", self.actor)
        session = store.emergency_session_for_trip(trip_id)
        self.assertEqual(session["activated_by_kind"], "admin")
        self.assertEqual(session["activated_by_id"], str(self.actor.id))
        self.assertIsNotNone(session["activated_at"])
        self.assertIsNotNone(session["expires_at"])

    # -- illegal transitions ----------------------------------------------
    def test_illegal_transitions_are_refused_with_the_current_state(self):
        trip_id = self.make_trip()
        for action in ("depart", "arrive", "complete"):
            with self.subTest(action=action):
                with self.assertRaises(lifecycle.InvalidTransition) as caught:
                    lifecycle.apply(trip_id, action, self.actor)
                self.assertEqual(caught.exception.extra["current_state"], lifecycle.CREATED)

        lifecycle.apply(trip_id, "verify", self.actor)
        with self.assertRaises(lifecycle.InvalidTransition):
            lifecycle.apply(trip_id, "verify", self.actor)

        # The watchdog's action is never available to a person.
        with self.assertRaises(lifecycle.PermissionDenied):
            lifecycle.apply(trip_id, "expire", self.actor)

    def test_completed_response_cannot_become_active_again(self):
        trip_id = self.make_trip("in_transit")
        lifecycle.apply(trip_id, "complete", self.actor)
        for action in ("verify", "activate", "depart", "arrive", "complete"):
            with self.subTest(action=action):
                with self.assertRaises(lifecycle.InvalidTransition):
                    lifecycle.apply(trip_id, action, self.actor)
        self.assertEqual(store.get_trip(trip_id)["status"], "completed")

    def test_cancelled_response_cannot_be_restarted_by_an_old_request(self):
        trip_id = self.make_trip()
        lifecycle.apply(trip_id, "cancel", self.actor, reason="Stood down by control")
        self.assertEqual(self.state(trip_id), lifecycle.CANCELLED)

        for action in ("verify", "activate", "depart"):
            with self.subTest(action=action):
                with self.assertRaises(lifecycle.InvalidTransition):
                    lifecycle.apply(trip_id, action, self.actor)
        self.assertEqual(store.get_trip(trip_id)["status"], "cancelled")
        self.assertEqual(self.state(trip_id), lifecycle.CANCELLED)

    def test_cancellation_requires_a_reason(self):
        trip_id = self.make_trip()
        with self.assertRaises(lifecycle.ReasonRequired):
            lifecycle.apply(trip_id, "cancel", self.actor)
        self.assertEqual(store.get_trip(trip_id)["status"], "scheduled")

        lifecycle.apply(trip_id, "cancel", self.actor, reason="Crew reassigned")
        session = store.emergency_session_for_trip(trip_id)
        self.assertEqual(session["close_reason"], "Crew reassigned")

    # -- authority --------------------------------------------------------
    def test_a_viewer_cannot_drive_the_lifecycle(self):
        trip_id = self.make_trip("in_transit")
        viewer = operator_actor("VIEWER")
        with self.assertRaises(lifecycle.PermissionDenied):
            lifecycle.apply(trip_id, "complete", viewer)
        with self.assertRaises(lifecycle.PermissionDenied):
            lifecycle.apply(trip_id, "cancel", viewer, reason="I am allowed to read")

    def test_a_system_actor_cannot_verify_or_activate(self):
        trip_id = self.make_trip()
        with self.assertRaises(lifecycle.PermissionDenied):
            lifecycle.apply(trip_id, "verify", {"kind": "system", "id": "watchdog"})

    def test_available_actions_respect_state_and_role(self):
        trip_id = self.make_trip()
        self.assertEqual(
            lifecycle.available_actions(lifecycle.CREATED, self.actor), ["verify", "activate", "cancel"]
        )
        viewer = operator_actor("VIEWER")
        self.assertEqual(lifecycle.available_actions(lifecycle.CREATED, viewer), [])

    # -- concurrency ------------------------------------------------------
    def test_two_operators_acting_on_the_same_state_produce_one_change(self):
        trip_id = self.make_trip()
        lifecycle.apply(trip_id, "verify", self.actor, expected_state=lifecycle.CREATED)

        with self.assertRaises(lifecycle.Conflict) as caught:
            lifecycle.apply(trip_id, "activate", self.actor, expected_state=lifecycle.CREATED)
        self.assertEqual(caught.exception.extra["current_state"], lifecycle.VERIFIED)
        self.assertEqual(store.get_trip(trip_id)["status"], "accepted")

    def test_a_lost_race_at_the_database_level_is_reported_not_overwritten(self):
        trip_id = self.make_trip()
        # Simulate the other writer having already moved the row.
        store.update_status(trip_id, "accept")
        with self.assertRaises(store.StaleTransition) as caught:
            store.update_status(trip_id, "accept", expected_status="scheduled")
        self.assertEqual(caught.exception.current_status, "accepted")

    def test_a_failed_transition_leaves_no_partial_state(self):
        trip_id = self.make_trip("in_transit")
        before = len(store.trip_events(trip_id))
        with mock.patch.object(store, "_sync_session", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                store.update_status(trip_id, "arrive")
        # The status write is rolled back with the event and session rows.
        self.assertEqual(store.get_trip(trip_id)["status"], "in_transit")
        self.assertEqual(len(store.trip_events(trip_id)), before)

    # -- idempotency ------------------------------------------------------
    def test_a_replayed_client_event_is_applied_once(self):
        trip_id = self.make_trip()
        first = lifecycle.apply(
            trip_id, "verify", self.actor, client_event_id="evt-1"
        )
        self.assertEqual(first["status"], "accepted")
        history_before = self.history(trip_id)

        second = lifecycle.apply(trip_id, "verify", self.actor, client_event_id="evt-1")
        self.assertEqual(second["status"], "accepted")
        self.assertEqual(self.history(trip_id), history_before)

    # -- derived conditions ------------------------------------------------
    def test_approaching_is_derived_from_position_only(self):
        trip_id = self.make_trip(
            "in_transit",
            destination_lat=19.0994,
            destination_lng=72.8891,
        )
        trip = store.get_trip(trip_id)
        session = store.emergency_session_for_trip(trip_id)

        near = {"lat": 19.1000, "lng": 72.8893}
        far = {"lat": 19.1136, "lng": 72.8697}

        self.assertEqual(
            lifecycle.derive_condition(trip, session, near), "APPROACHING"
        )
        self.assertEqual(lifecycle.derive_condition(trip, session, far), "ACTIVE")
        self.assertEqual(lifecycle.derive_condition(trip, session, None), "ACTIVE")
        # The stored state never changes just because a fix arrived.
        self.assertEqual(self.state(trip_id), "ACTIVE")

    def test_approaching_is_not_reported_for_a_closed_response(self):
        trip_id = self.make_trip("completed", destination_lat=19.0994, destination_lng=72.8891)
        trip = store.get_trip(trip_id)
        session = store.emergency_session_for_trip(trip_id)
        self.assertEqual(
            lifecycle.derive_condition(trip, session, {"lat": 19.0995, "lng": 72.8891}),
            "COMPLETED",
        )

    # -- watchdog ---------------------------------------------------------
    def test_silent_unit_is_a_telemetry_warning_not_a_cancellation(self):
        # Phase C corrected this on purpose. Phase B closed the response after
        # 120 s of silence, which ended a real emergency whenever a phone lost
        # signal. Silence now degrades the *position*, never the response.
        trip_id = self.make_trip("in_transit")
        stale = store.stamp(store.utcnow() - timedelta(minutes=10))
        store.touch_session_last_seen(trip_id, stale)
        # Ten minutes en route with no fix at all: past the start-up grace.
        store.get_db().execute(
            "UPDATE emergency_sessions SET activated_at = ? WHERE trip_id = ?",
            (stale, trip_id),
        )
        store.get_db().commit()

        warnings = lifecycle.telemetry_warnings()
        # Never reported at all: "unknown", not "lost signal".
        self.assertTrue(
            any(w["trip_id"] == trip_id and w["status"] == "UNKNOWN" for w in warnings)
        )
        self.assertEqual(self.state(trip_id), "ACTIVE")
        self.assertEqual(store.get_trip(trip_id)["status"], "in_transit")
        self.assertIsNone(store.emergency_session_for_trip(trip_id)["close_reason"])

    def test_watchdog_leaves_a_fresh_session_alone(self):
        trip_id = self.make_trip("in_transit")
        store.touch_session_last_seen(trip_id, store.iso_now())
        self.assertEqual(lifecycle.expire_stale(), [])
        self.assertEqual(lifecycle.telemetry_warnings(), [])
        self.assertEqual(self.state(trip_id), "ACTIVE")

    def test_watchdog_is_idempotent(self):
        # The remaining automatic closure is the twelve-hour activation ceiling,
        # and calling the sweep twice must expire a session only once.
        trip_id = self.make_trip("in_transit")
        session = store.emergency_session_for_trip(trip_id)
        old = store.stamp(store.utcnow() - timedelta(hours=13))
        store.get_db().execute(
            "UPDATE emergency_sessions SET activated_at = ?, last_seen_at = ? WHERE id = ?",
            (old, old, session["id"]),
        )
        store.get_db().commit()

        first = lifecycle.expire_stale()
        second = lifecycle.expire_stale()
        self.assertEqual(first, [trip_id])
        self.assertEqual(second, [])
        self.assertEqual(self.state(trip_id), "EXPIRED")

    # -- future-phase gates -------------------------------------------------
    def test_only_active_sessions_may_track_or_alert(self):
        self.assertTrue(lifecycle.can_track("ACTIVE"))
        self.assertTrue(lifecycle.can_alert("ACTIVE"))
        for state in ("CREATED", "VERIFIED", "ON_SCENE", "COMPLETED", "CANCELLED", "EXPIRED"):
            with self.subTest(state=state):
                self.assertFalse(lifecycle.can_track(state))
                self.assertFalse(lifecycle.can_alert(state))

    # -- audit -------------------------------------------------------------
    def test_every_transition_writes_an_audit_entry(self):
        trip_id = self.make_trip()
        lifecycle.apply(trip_id, "verify", self.actor)
        lifecycle.apply(trip_id, "cancel", self.actor, reason="Duplicate call")

        entries = accounts.audit_for_trip(trip_id)
        actions = [entry["action"] for entry in entries]
        self.assertIn("emergency.verify", actions)
        self.assertIn("emergency.cancel", actions)
        verify_entry = next(e for e in entries if e["action"] == "emergency.verify")
        self.assertEqual(verify_entry["actor_id"], self.actor.id)
        self.assertEqual(verify_entry["actor_role"], self.actor.role)
        self.assertEqual(verify_entry["outcome"], "success")

    def test_audit_log_cannot_be_edited_or_deleted(self):
        accounts.audit_record(action="test.append_only")
        db = store.get_db()
        with self.assertRaises(Exception):
            with db:
                db.execute("UPDATE audit_log SET action = 'tampered'")
        with self.assertRaises(Exception):
            with db:
                db.execute("DELETE FROM audit_log")

    # -- driver API compatibility -------------------------------------------
    def test_the_crew_phone_still_drives_the_same_lifecycle(self):
        unit_id = store.create_vehicle(call_sign="MEDIC-77", vehicle_type="ambulance")
        trip_id = self.make_trip(vehicle_id=unit_id)

        client = app_module.app.test_client()
        headers = {"Authorization": f"Bearer {support.issue_unit_token(unit_id)}"}

        accepted = client.post(
            f"/api/driver/trips/{trip_id}/transition",
            json={"to": "accepted", "client_event_id": "evt-accept"},
            headers=headers,
        )
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        self.assertEqual(self.state(trip_id), "VERIFIED")

        departed = client.post(
            f"/api/driver/trips/{trip_id}/transition",
            json={"to": "in_transit", "client_event_id": "evt-depart"},
            headers=headers,
        )
        self.assertEqual(departed.status_code, 200)
        self.assertEqual(self.state(trip_id), "ACTIVE")
        # The driver's action is attributed to the unit, not to an administrator.
        session = store.emergency_session_for_trip(trip_id)
        self.assertEqual(session["activated_by_kind"], "unit")

        arrived = client.post(
            f"/api/driver/trips/{trip_id}/transition",
            json={"to": "on_scene", "client_event_id": "evt-arrive"},
            headers=headers,
        )
        self.assertEqual(arrived.status_code, 200)
        self.assertEqual(self.state(trip_id), "ON_SCENE")

        completed = client.post(
            f"/api/driver/trips/{trip_id}/transition",
            json={"to": "completed", "client_event_id": "evt-complete"},
            headers=headers,
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(self.state(trip_id), "COMPLETED")
        self.assertEqual(store.get_trip(trip_id)["status"], "completed")

    def test_the_phone_still_cannot_touch_another_units_response(self):
        mine = store.create_vehicle(call_sign="MEDIC-78", vehicle_type="ambulance")
        other = store.create_vehicle(call_sign="MEDIC-79", vehicle_type="ambulance")
        trip_id = self.make_trip(vehicle_id=mine)

        client = app_module.app.test_client()
        response = client.get(
            f"/api/driver/trips/{trip_id}",
            headers={"Authorization": f"Bearer {support.issue_unit_token(other)}"},
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
