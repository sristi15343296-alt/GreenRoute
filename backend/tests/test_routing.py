"""Routing seam: cache keys, failures, the fallback, and /api/route."""

import os
import tempfile
import unittest
from unittest import mock

import app as app_module
import support
import db as store
import routing


class RoutingUnitTests(unittest.TestCase):
    def test_cache_key_is_order_sensitive_and_rounded(self):
        a = routing.cache_key((19.11360001, 72.86970001), (19.0994, 72.8891))
        b = routing.cache_key((19.11360002, 72.86970004), (19.0994, 72.8891))
        c = routing.cache_key((19.0994, 72.8891), (19.1136, 72.8697))
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_invalid_pairs_are_rejected_before_a_provider_call(self):
        for pair in (None, [1], [91, 0], [0, 181], [0, 0], ["a", "b"]):
            with self.subTest(pair=pair):
                with self.assertRaises(routing.RoutingError):
                    routing.request_route(pair, (19.0, 72.0))

    def test_straight_line_fallback_is_a_two_point_honest_answer(self):
        fallback = routing.straight_line((19.1136, 72.8697), (19.0994, 72.8891))
        self.assertEqual(len(fallback["geometry"]), 2)
        self.assertEqual(fallback["provider"], "straight-line")
        self.assertIsNone(fallback["duration_s"])
        self.assertGreater(fallback["distance_m"], 1000)

    def test_provider_url_is_configurable(self):
        with mock.patch.dict(os.environ, {"GREENROUTE_ROUTE_URL": "http://osrm.internal/route/v1/driving"}):
            self.assertEqual(routing.provider_url(), "http://osrm.internal/route/v1/driving")


class RouteApiTests(unittest.TestCase):
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

    def make_trip(self):
        return store.create_trip(
            origin="Marol Fire Station, Mumbai",
            destination="Saki Naka Industrial Estate, Mumbai",
            priority="critical",
            status="in_transit",
            dispatch_at=store.iso_now(),
        )

    def test_bad_coordinates_are_rejected(self):
        response = self.client.post(
            "/api/route", json={"origin": [0, 0], "destination": [19.1, 72.8]}
        )
        self.assertEqual(response.status_code, 422)

    def test_provider_answer_is_returned_and_cached(self):
        answer = {
            "geometry": [[19.1136, 72.8697], [19.11, 72.87], [19.0994, 72.8891]],
            "distance_m": 3400.0,
            "duration_s": 660.0,
            "provider": "osrm",
        }
        with mock.patch.object(routing, "request_route", return_value=answer) as call:
            first = self.client.post(
                "/api/route",
                json={"origin": [19.1136, 72.8697], "destination": [19.0994, 72.8891]},
            )
            second = self.client.post(
                "/api/route",
                json={"origin": [19.1136, 72.8697], "destination": [19.0994, 72.8891]},
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(call.call_count, 1)  # second hit came from the cache
        body = first.get_json()["route"]
        self.assertEqual(body["distance_km"], 3.4)
        self.assertEqual(body["duration_min"], 11.0)
        self.assertFalse(body["degraded"])
        # The payload states its own limitation instead of leaving it implied.
        self.assertIn("free-flow", body["traffic"])

    def test_provider_failure_degrades_to_a_straight_line(self):
        with mock.patch.object(
            routing, "request_route", side_effect=routing.RoutingError("down")
        ):
            response = self.client.post(
                "/api/route",
                json={"origin": [19.1136, 72.8697], "destination": [19.0994, 72.8891]},
            )

        self.assertEqual(response.status_code, 200)
        route = response.get_json()["route"]
        self.assertTrue(route["degraded"])
        self.assertEqual(route["provider"], "straight-line")
        self.assertEqual(route["notice"], "down")

    def test_storing_on_a_trip_supersedes_the_previous_route(self):
        trip = self.make_trip()
        first = {
            "geometry": [[19.1136, 72.8697], [19.0994, 72.8891]],
            "distance_m": 3400.0,
            "duration_s": 660.0,
            "provider": "osrm",
        }
        second = {
            "geometry": [[19.1136, 72.8697], [19.1050, 72.8700], [19.0994, 72.8891]],
            "distance_m": 3600.0,
            "duration_s": 700.0,
            "provider": "osrm",
        }
        with mock.patch.object(routing, "request_route", return_value=first):
            self.client.post(
                "/api/route",
                json={
                    "origin": [19.1136, 72.8697],
                    "destination": [19.0994, 72.8891],
                    "trip_id": trip,
                },
            )
        with mock.patch.object(routing, "request_route", return_value=second):
            self.client.post(
                "/api/route",
                json={
                    # The crew moved, so this is a genuinely new compute.
                    "origin": [19.1150, 72.8720],
                    "destination": [19.0994, 72.8891],
                    "trip_id": trip,
                    "reason": "reroute",
                },
            )

        active = store.active_route(trip)
        self.assertEqual(len(active["geometry"]), 3)
        self.assertEqual(active["reason"], "reroute")
        rows = store.get_db().execute(
            "SELECT COUNT(*) AS total FROM emergency_routes WHERE trip_id = ?",
            (trip,),
        ).fetchone()
        self.assertEqual(rows["total"], 2)  # history is kept, not overwritten

        stored = store.get_trip(trip)
        self.assertEqual(stored["route_provider"], "osrm")
        self.assertIsNotNone(stored["route_json"])
        self.assertEqual(stored["distance_km"], 3.4)

    def test_storing_an_unrouted_trip_with_no_route_is_a_404(self):
        response = self.client.post(
            "/api/route",
            json={
                "origin": [19.1136, 72.8697],
                "destination": [19.0994, 72.8891],
                "trip_id": 999,
            },
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
