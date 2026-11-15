"""Phase C: telemetry validation, storage ordering, health, deviation, live API.

Every test here runs against a throwaway SQLite database and simulated
coordinates. No physical device is involved, and nothing is sent to a real unit.
"""

import os
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

import app as app_module
import auth
import db as store
import lifecycle
import routing
import support
import telemetry


def operator_actor(role="EMERGENCY_OPERATOR", admin_id=99):
    return auth.Actor(
        id=admin_id,
        email=f"{role.lower()}@test.local",
        name=role.title(),
        role=role,
        session_id=1,
        csrf_token="csrf",
    )


def route_stub(distance_m=1450.0, provider="osrm"):
    """A short, deliberately straight polyline: this is a stub, not a road."""
    return {
        "provider": provider,
        "geometry": [[19.1136, 72.8697], [19.1060, 72.8790], [19.0994, 72.8891]],
        "distance_m": distance_m,
        "duration_s": 420,
    }


class TelemetryTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(tempfile.mkdtemp(), "telemetry.sqlite"),
            SECRET_KEY="test-secret",
        )
        self.ctx = app_module.app.app_context()
        self.ctx.push()
        store.init_db()
        self.actor = operator_actor()

        self.unit_id = store.create_vehicle(call_sign="MEDIC-77", vehicle_type="ambulance")
        # The unit credential is the random code issued in Resources; telemetry
        # never authenticates on the call sign.
        self.token = support.issue_unit_token(self.unit_id)

        self.trip_id = store.create_trip(
            origin="Marol",
            destination="Saki Naka",
            priority="high",
            status="in_transit",
            destination_lat=19.0994,
            destination_lng=72.8891,
            vehicle_id=self.unit_id,
        )
        self.phone = app_module.app.test_client()

    def tearDown(self):
        self.ctx.pop()
        app_module.app.config["DATABASE"] = self.previous_database

    # -- helpers ---------------------------------------------------------

    def headers(self, token=None):
        return {"Authorization": f"Bearer {token or self.token}"}

    def fix(self, lat=19.1136, lng=72.8697, seconds_ago=0, **overrides):
        device_time = store.utcnow() - timedelta(seconds=seconds_ago)
        body = {
            "lat": lat,
            "lng": lng,
            "accuracy_m": 8.0,
            "heading_deg": 210.0,
            "speed_mps": 12.5,
            "device_time": device_time.isoformat().replace("+00:00", "Z"),
        }
        body.update(overrides)
        return body

    def post(self, fixes, trip_id=None, token=None):
        payload = {"fixes": fixes}
        if trip_id is not None:
            payload["trip_id"] = trip_id
        return self.phone.post(
            "/api/driver/telemetry", json=payload, headers=self.headers(token)
        )

    # -- C.2 authentication and ownership --------------------------------

    def test_unauthenticated_upload_is_refused(self):
        response = self.phone.post("/api/driver/telemetry", json={"fixes": [self.fix()]})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(store.telemetry_counts()["fixes"], 0)

    def test_unknown_token_is_refused(self):
        response = self.post([self.fix()], token="not-a-unit-token")
        self.assertEqual(response.status_code, 401)

    def test_telemetry_for_another_units_response_is_not_found(self):
        other_unit = store.create_vehicle(call_sign="MEDIC-78", vehicle_type="ambulance")
        other_trip = store.create_trip(
            origin="A",
            destination="B",
            priority="high",
            status="in_transit",
            vehicle_id=other_unit,
        )
        response = self.post([self.fix()], trip_id=other_trip)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error_code"], "not_your_response")
        self.assertIsNone(store.latest_position(other_trip))

    def test_completed_session_refuses_telemetry(self):
        lifecycle.apply(self.trip_id, "complete", self.actor)
        # Naming the response explicitly reaches the session check; without it the
        # unit simply has no open response left.
        response = self.post([self.fix()], trip_id=self.trip_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error_code"], "session_not_trackable")

    def test_cancelled_session_refuses_telemetry(self):
        lifecycle.apply(self.trip_id, "cancel", self.actor, reason="Stand down")
        response = self.post([self.fix()], trip_id=self.trip_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error_code"], "session_not_trackable")

    def test_unit_without_a_response_is_a_conflict(self):
        lifecycle.apply(self.trip_id, "complete", self.actor)
        response = self.post([self.fix()])
        # The completed trip is no longer an open response, so nothing is open.
        self.assertEqual(response.status_code, 409)
        self.assertIn(
            response.get_json()["error_code"], {"no_active_response", "session_not_trackable"}
        )

    # -- C.4 validation --------------------------------------------------

    def test_valid_fix_is_stored_and_acknowledged(self):
        response = self.post([self.fix()])
        self.assertEqual(response.status_code, 200)
        body = response.get_json()["telemetry"]
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(body["health"]["status"], "LIVE")
        self.assertEqual(body["latest"]["lat"], 19.1136)
        self.assertEqual(store.telemetry_counts()["positions"], 1)

    def test_out_of_range_coordinates_are_rejected(self):
        response = self.post([self.fix(lat=91.0)])
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "invalid_coordinates")

    def test_null_island_is_rejected(self):
        response = self.post([self.fix(lat=0.0, lng=0.0)])
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "invalid_coordinates")

    def test_absurd_accuracy_is_rejected(self):
        response = self.post([self.fix(accuracy_m=5000)])
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "accuracy_out_of_range")

    def test_future_timestamp_is_rejected(self):
        future = (store.utcnow() + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        response = self.post([self.fix(device_time=future)])
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "future_timestamp")

    def test_ancient_buffered_fix_is_rejected(self):
        response = self.post([self.fix(seconds_ago=1800)])
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "stale_timestamp")

    def test_bad_heading_and_speed_are_rejected(self):
        self.assertEqual(
            self.post([self.fix(heading_deg=360.0)]).get_json()["error_code"], "invalid_field"
        )
        self.assertEqual(
            self.post([self.fix(speed_mps=-3.0)]).get_json()["error_code"], "invalid_field"
        )

    def test_missing_fields_are_rejected(self):
        response = self.phone.post(
            "/api/driver/telemetry", json={"fixes": [{"lat": 19.0}]}, headers=self.headers()
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error_code"], "missing_field")

    def test_empty_and_oversized_batches_are_rejected(self):
        empty = self.phone.post(
            "/api/driver/telemetry", json={"fixes": []}, headers=self.headers()
        )
        self.assertEqual(empty.status_code, 400)
        oversized = self.post([self.fix() for _ in range(telemetry.MAX_BATCH + 1)])
        self.assertEqual(oversized.status_code, 413)

    def test_payload_must_be_json(self):
        response = self.phone.post(
            "/api/driver/telemetry", data="not json", headers=self.headers()
        )
        self.assertEqual(response.status_code, 400)

    # -- C.4 ordering, duplicates, retries --------------------------------

    def test_older_fix_cannot_replace_a_newer_position(self):
        self.post([self.fix(lat=19.1150, seconds_ago=0)])
        stale = self.post([self.fix(lat=19.0000, seconds_ago=90)])
        # Nothing in the batch was usable, so the request itself is a 422.
        self.assertEqual(stale.status_code, 422)
        self.assertEqual(stale.get_json()["error_code"], "out_of_order")
        outcome = stale.get_json()["telemetry"]["outcomes"][0]
        self.assertFalse(outcome["accepted"])
        self.assertEqual(outcome["code"], "out_of_order")
        self.assertEqual(store.latest_position(self.trip_id)["lat"], 19.1150)

    def test_retried_fix_is_a_duplicate_not_a_second_row(self):
        first = self.fix(client_fix_id="MEDIC-77:1", sequence=1)
        self.post([first])
        again = self.post([first])
        body = again.get_json()["telemetry"]
        self.assertEqual(body["duplicates"], 1)
        self.assertEqual(store.telemetry_counts()["fixes"], 1)
        self.assertEqual(body["rejected"], 0)

    def test_batch_continues_after_one_bad_fix(self):
        body = self.post(
            [
                self.fix(lat=91.0, client_fix_id="bad", sequence=1),
                self.fix(lat=19.1136, client_fix_id="good", sequence=2),
            ]
        ).get_json()["telemetry"]
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(body["rejected"], 1)
        self.assertEqual(store.latest_position(self.trip_id)["lat"], 19.1136)

    def test_impossible_jump_is_rejected(self):
        self.post([self.fix(lat=19.1136, lng=72.8697, seconds_ago=30)])
        jump = self.post([self.fix(lat=19.2500, lng=72.8697, seconds_ago=20)])
        self.assertEqual(jump.get_json()["telemetry"]["outcomes"][0]["code"], "impossible_jump")
        self.assertEqual(store.latest_position(self.trip_id)["lat"], 19.1136)

    def test_sql_upsert_never_applies_an_older_fix(self):
        # The ordering rule lives in the SQL `WHERE`, so this asserts the storage
        # layer directly: write the newer fix first, then try the older one.
        base = self.fix(lat=19.1136, lng=72.8697, sequence=5)
        newer = telemetry.parse_fix(base, now=store.utcnow())
        newer_id = store.record_telemetry_fix(
            trip_id=self.trip_id,
            session_id=None,
            vehicle_id=self.unit_id,
            fix=newer,
            quality="good",
        )["id"]
        self.assertTrue(
            store.upsert_latest_position(
                trip_id=self.trip_id,
                session_id=None,
                vehicle_id=self.unit_id,
                fix=newer,
                quality="good",
                fix_id=newer_id,
            )
        )

        older = telemetry.parse_fix(
            self.fix(lat=19.1000, seconds_ago=20, sequence=4), now=store.utcnow()
        )
        older_id = store.record_telemetry_fix(
            trip_id=self.trip_id,
            session_id=None,
            vehicle_id=self.unit_id,
            fix=older,
            quality="good",
        )["id"]
        self.assertFalse(
            store.upsert_latest_position(
                trip_id=self.trip_id,
                session_id=None,
                vehicle_id=self.unit_id,
                fix=older,
                quality="good",
                fix_id=older_id,
            )
        )
        self.assertEqual(store.latest_position(self.trip_id)["lat"], 19.1136)
        self.assertEqual(store.latest_position(self.trip_id)["last_fix_id"], newer_id)

    # -- C.4/C.6 quality and health --------------------------------------

    def test_poor_accuracy_is_stored_but_labelled(self):
        body = self.post([self.fix(accuracy_m=400)]).get_json()["telemetry"]
        self.assertEqual(body["latest"]["quality"], "poor")
        self.assertEqual(body["health"]["quality"], "poor")

    def test_health_bands_follow_the_server_clock(self):
        body = self.post([self.fix()]).get_json()["telemetry"]
        position = store.latest_position(self.trip_id)
        now = store.utcnow()
        self.assertEqual(telemetry.health(position, "ACTIVE", now=now)["status"], "LIVE")
        self.assertEqual(
            telemetry.health(position, "ACTIVE", now=now + timedelta(seconds=30))["status"],
            "DELAYED",
        )
        self.assertEqual(
            telemetry.health(position, "ACTIVE", now=now + timedelta(seconds=100))["status"],
            "STALE",
        )
        self.assertEqual(
            telemetry.health(position, "ACTIVE", now=now + timedelta(seconds=400))["status"],
            "LOST",
        )
        self.assertEqual(body["health"]["status"], "LIVE")

    def test_no_position_reports_unknown_rather_than_zero(self):
        state = telemetry.health(None, "ACTIVE")
        self.assertEqual(state["status"], "UNKNOWN")
        self.assertIsNone(state["age_seconds"])

    def test_upload_touches_session_last_seen(self):
        session_row = store.emergency_session_for_trip(self.trip_id)
        old = store.stamp(store.utcnow() - timedelta(minutes=10))
        store.get_db().execute(
            "UPDATE emergency_sessions SET last_seen_at = ? WHERE id = ?",
            (old, session_row["id"]),
        )
        store.get_db().commit()
        before = store.emergency_session_for_trip(self.trip_id)["last_seen_at"]
        self.post([self.fix()])
        after = store.emergency_session_for_trip(self.trip_id)["last_seen_at"]
        self.assertIsNotNone(after)
        self.assertNotEqual(before, after)

    def test_driver_status_endpoint_reports_tracking(self):
        self.post([self.fix()])
        body = self.phone.get("/api/driver/telemetry", headers=self.headers()).get_json()
        self.assertTrue(body["telemetry"]["tracking"])
        self.assertEqual(body["telemetry"]["health"]["status"], "LIVE")

    # -- C.7 deviation and recalculation ---------------------------------

    def _seed_route(self):
        store.save_route(self.trip_id, route_stub(), reason="initial")

    def test_on_route_position_does_not_recalculate(self):
        self._seed_route()
        with mock.patch("routing.resolve_route", side_effect=AssertionError("no call")) as spy:
            self.post([self.fix()])
            spy.assert_not_called()

    def test_meaningful_deviation_recalculates_once(self):
        self._seed_route()
        far = self.fix(lat=19.0500, lng=72.8200, sequence=1)
        with mock.patch("routing.resolve_route", return_value=route_stub(990.0)) as resolver:
            body = self.post([far]).get_json()["telemetry"]
            self.assertTrue(body["recalculation"]["recalculated"])
            self.assertGreater(body["route"]["deviation_m"], telemetry.DEVIATION_THRESHOLD_M)
            routes = store.get_db().execute(
                "SELECT COUNT(*) AS n FROM emergency_routes WHERE trip_id = ?", (self.trip_id,)
            ).fetchone()["n"]
            self.assertEqual(routes, 2)
            resolver.assert_called_once()

            # A second off-route fix immediately afterwards is inside the cooldown.
            second = self.post(
                [self.fix(lat=19.0501, lng=72.8201, sequence=2)]
            ).get_json()["telemetry"]
            self.assertFalse(second["recalculation"]["recalculated"])
            self.assertEqual(second["recalculation"]["reason"], "cooldown")
            self.assertEqual(resolver.call_count, 1)

    def test_recalculation_preserves_the_superseded_route(self):
        self._seed_route()
        with mock.patch("routing.resolve_route", return_value=route_stub(500.0)):
            self.post([self.fix(lat=19.0500, lng=72.8200, sequence=1)])
        rows = store.get_db().execute(
            "SELECT id, superseded_by FROM emergency_routes WHERE trip_id = ? ORDER BY id",
            (self.trip_id,),
        ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["superseded_by"], rows[1]["id"])
        self.assertIsNone(rows[1]["superseded_by"])

    def test_routing_failure_degrades_quality_and_keeps_the_route(self):
        self._seed_route()
        original = store.active_route(self.trip_id)["geometry"]
        with mock.patch(
            "routing.resolve_route", side_effect=routing.RoutingError("provider down")
        ):
            self.post([self.fix(lat=19.0500, lng=72.8200, sequence=1)])
        trip = store.get_trip(self.trip_id)
        self.assertEqual(trip["route_quality"], "degraded")
        self.assertEqual(store.active_route(self.trip_id)["geometry"], original)

    def test_low_accuracy_position_cannot_trigger_a_recalculation(self):
        self._seed_route()
        with mock.patch("routing.resolve_route", side_effect=AssertionError("no call")) as spy:
            body = self.post(
                [self.fix(lat=19.0500, lng=72.8200, accuracy_m=500, sequence=1)]
            ).get_json()["telemetry"]
            self.assertFalse(body["recalculation"]["recalculated"])
            self.assertEqual(body["recalculation"]["reason"], "low_accuracy")
            spy.assert_not_called()

    # -- C.11 watchdog ---------------------------------------------------

    def test_gps_silence_never_ends_the_emergency(self):
        self.post([self.fix()])
        later = store.utcnow() + timedelta(minutes=10)
        with self.ctx.app.test_request_context():
            lifecycle.expire_stale(later)
        session_row = store.emergency_session_for_trip(self.trip_id)
        self.assertEqual(session_row["state"], "ACTIVE")
        self.assertEqual(store.get_trip(self.trip_id)["status"], "in_transit")

    def test_sweep_endpoint_reports_warnings_without_changing_state(self):
        self.post([self.fix()])
        store.get_db().execute(
            "UPDATE vehicle_positions SET received_at = ? WHERE trip_id = ?",
            (store.stamp(store.utcnow() - timedelta(minutes=6)), self.trip_id),
        )
        store.get_db().commit()
        admin = support.signed_in_client(app_module.app, role="EMERGENCY_OPERATOR")
        body = admin.post("/api/maintenance/expire-stale").get_json()
        self.assertEqual(body["expired"], [])
        self.assertTrue(
            any(w["trip_id"] == self.trip_id and w["status"] == "LOST" for w in body["telemetry_warnings"])
        )
        self.assertEqual(store.emergency_session_for_trip(self.trip_id)["state"], "ACTIVE")

    def test_overtime_session_is_closed_by_the_ceiling(self):
        session_row = store.emergency_session_for_trip(self.trip_id)
        old = store.stamp(store.utcnow() - timedelta(hours=13))
        store.get_db().execute(
            "UPDATE emergency_sessions SET activated_at = ?, last_seen_at = ? WHERE id = ?",
            (old, old, session_row["id"]),
        )
        store.get_db().commit()
        expired = lifecycle.expire_overtime()
        self.assertIn(self.trip_id, expired)
        self.assertEqual(store.emergency_session_for_trip(self.trip_id)["state"], "EXPIRED")

    # -- C.8 live monitoring API -----------------------------------------

    def test_live_positions_requires_authentication(self):
        anonymous = app_module.app.test_client()
        response = anonymous.get("/api/live/positions")
        self.assertIn(response.status_code, (302, 401))

    def test_viewer_can_read_live_positions(self):
        self.post([self.fix()])
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        body = admin.get("/api/live/positions").get_json()
        self.assertEqual(body["active_count"], 1)
        entry = body["positions"][0]
        self.assertEqual(entry["trip_id"], self.trip_id)
        self.assertEqual(entry["position"]["lat"], 19.1136)
        self.assertEqual(entry["health"]["status"], "LIVE")
        self.assertEqual(entry["call_sign"], "MEDIC-77")

    def test_live_positions_cursor_returns_only_newer_state(self):
        self.post([self.fix(sequence=1)])
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        first = admin.get("/api/live/positions").get_json()
        self.assertEqual(first["active_count"], 1)
        cursor = first["event_id"]
        self.assertGreater(cursor, 0)
        self.assertEqual(admin.get(f"/api/live/positions?since={cursor}").get_json()["active_count"], 0)
        self.post([self.fix(lat=19.1130, lng=72.8700, sequence=2)])
        again = admin.get(f"/api/live/positions?since={cursor}").get_json()
        self.assertEqual(again["active_count"], 1)
        self.assertGreater(again["event_id"], cursor)

    def test_completed_response_leaves_the_live_list(self):
        self.post([self.fix()])
        lifecycle.apply(self.trip_id, "complete", self.actor)
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        self.assertEqual(admin.get("/api/live/positions").get_json()["active_count"], 0)

    def test_track_endpoint_returns_trail_and_health(self):
        for index in range(3):
            self.post([self.fix(lat=19.1136 + index * 0.0004, sequence=index + 1)])
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        body = admin.get(f"/api/live/sessions/{self.trip_id}/track").get_json()
        self.assertEqual(len(body["trail"]), 3)
        self.assertEqual(body["session_state"], "ACTIVE")
        self.assertEqual(body["health"]["status"], "LIVE")

    def test_track_endpoint_404s_for_unknown_response(self):
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        self.assertEqual(admin.get("/api/live/sessions/99999/track").status_code, 404)

    # -- C.10 privacy ----------------------------------------------------

    def test_coordinates_are_not_written_to_the_audit_log(self):
        self.post([self.fix()])
        admin = support.signed_in_client(app_module.app, role="VIEWER")
        admin.get("/api/live/positions")
        rows = store.get_db().execute("SELECT detail_json FROM audit_log").fetchall()
        for row in rows:
            self.assertNotIn("19.1136", row["detail_json"] or "")


class TelemetryRetentionTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_database = app_module.app.config["DATABASE"]
        app_module.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(tempfile.mkdtemp(), "retention.sqlite"),
            SECRET_KEY="test-secret",
        )
        self.ctx = app_module.app.app_context()
        self.ctx.push()
        store.init_db()

    def tearDown(self):
        self.ctx.pop()
        app_module.app.config["DATABASE"] = self.previous_database

    def test_prune_removes_only_expired_fixes(self):
        unit = store.create_vehicle(call_sign="MEDIC-79", vehicle_type="ambulance")
        trip = store.create_trip(
            origin="A", destination="B", priority="high", status="in_transit", vehicle_id=unit
        )
        store.get_db().execute(
            """
            INSERT INTO telemetry_fixes
                (trip_id, session_id, vehicle_id, lat, lng, accuracy_m,
                 device_time, received_at, quality, source)
            VALUES (?, NULL, ?, 19.0, 72.0, 5, ?, ?, 'good', 'gps')
            """,
            (
                trip,
                unit,
                store.stamp(store.utcnow() - timedelta(days=30)),
                store.stamp(store.utcnow() - timedelta(days=30)),
            ),
        )
        store.get_db().commit()
        removed = store.prune_telemetry(
            store.stamp(store.utcnow() - timedelta(days=telemetry.retention_days()))
        )
        self.assertEqual(removed, 1)
        self.assertEqual(store.telemetry_counts()["fixes"], 0)


if __name__ == "__main__":
    unittest.main()
