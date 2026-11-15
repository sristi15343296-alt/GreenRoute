"""Focused tests for address validation, lookup and coordinate persistence."""

import os
import sqlite3
import tempfile
import unittest
from unittest import mock

import app as app_module
import support
import db as store
import geocoding


def candidate(name, lat, lng, importance=0.2, place_rank=30):
    return {
        "display_name": name,
        "lat": lat,
        "lng": lng,
        "type": "place",
        "place_rank": place_rank,
        "importance": importance,
        "country_code": "in",
        "provider_ref": name,
    }


class GeocodingUnitTests(unittest.TestCase):
    def test_coordinate_ranges_are_validated(self):
        self.assertTrue(geocoding.coordinate_is_valid(31.33, 75.58))
        self.assertFalse(geocoding.coordinate_is_valid(91, 75))
        self.assertFalse(geocoding.coordinate_is_valid(31, 181))
        self.assertFalse(geocoding.coordinate_is_valid("not-a-number", 75))
        self.assertFalse(geocoding.coordinate_is_valid(0, 0))

    def test_nearby_candidate_disambiguates_destination(self):
        candidates = [
            candidate("Chitra Hospital, Kerala, India", 9.59, 76.52, 0.6),
            candidate("Chitra Hospital, Jalandhar, Punjab, India", 31.29, 75.63, 0.1),
        ]
        result = geocoding.choose_candidate(candidates, (31.33, 75.58))
        self.assertEqual(result["status"], "resolved")
        self.assertIn("Jalandhar", result["display_name"])

    def test_far_apart_candidates_are_ambiguous(self):
        candidates = [
            candidate("Alpha, India", 31.33, 75.58, 0.1),
            candidate("Alpha, United Kingdom", 52.4, -1.5, 0.1),
        ]
        result = geocoding.choose_candidate(candidates)
        self.assertEqual(result["status"], "ambiguous")
        self.assertNotIn("lat", result)

    def test_no_candidates_is_not_found(self):
        self.assertEqual(geocoding.choose_candidate([])["status"], "not_found")


def photon_feature(
    name="Civil Hospital",
    lat=31.3265,
    lng=75.5792,
    osm_id="7866569666",
    osm_value="hospital",
):
    return {
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "properties": {
            "osm_type": "N",
            "osm_id": osm_id,
            "osm_key": "amenity",
            "osm_value": osm_value,
            "name": name,
            "housenumber": "12",
            "street": "Civil Lines",
            "district": "Civil Lines",
            "city": "Jalandhar",
            "county": "Jalandhar",
            "state": "Punjab",
            "postcode": "144001",
            "country": "India",
            "countrycode": "IN",
        },
    }


class SuggestionUnitTests(unittest.TestCase):
    def setUp(self):
        geocoding.clear_suggestion_cache()

    def test_photon_candidate_uses_real_coordinate_order_and_address(self):
        suggestion = geocoding._photon_candidate(photon_feature())
        self.assertIsNotNone(suggestion)
        self.assertEqual(suggestion["lat"], 31.3265)
        self.assertEqual(suggestion["lng"], 75.5792)
        self.assertEqual(suggestion["place_id"], "N7866569666")
        self.assertEqual(suggestion["kind"], "Hospital")
        self.assertEqual(suggestion["primary"], "Civil Hospital")
        self.assertIn("12 Civil Lines", suggestion["formatted_address"])
        self.assertIn("Jalandhar", suggestion["formatted_address"])
        self.assertIn("144001", suggestion["formatted_address"])

    def test_duplicate_place_results_are_removed(self):
        duplicate = photon_feature(name="Civil Hospital", osm_id="999")
        with mock.patch(
            "geocoding._request_photon",
            return_value=[photon_feature(), duplicate, {"geometry": None}],
        ) as request:
            suggestions = geocoding.suggest("Civil Hospital")
        request.assert_called_once()
        self.assertEqual(len(suggestions), 1)
        self.assertIn("Civil Hospital", suggestions[0]["formatted_address"])

    def test_short_query_does_not_call_provider(self):
        with mock.patch("geocoding._request_photon") as request:
            self.assertEqual(geocoding.suggest("Ci"), [])
        request.assert_not_called()


class TripGeocodingApiTests(unittest.TestCase):
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

    def make_trip(self, origin="Jalandhar City", destination="Amritsar"):
        return store.create_trip(
            origin=origin,
            destination=destination,
            priority="high",
            status="in_transit",
        )

    def test_success_persists_coordinates_and_serialises_them(self):
        trip_id = self.make_trip()
        calls = []

        def fake_geocode(address, near=None):
            calls.append((address, near))
            if "jalandhar" in address.lower():
                return {
                    "status": "resolved",
                    "lat": 31.3323762,
                    "lng": 75.576889,
                    "display_name": "Jalandhar, Punjab, India",
                    "provider": "nominatim",
                }
            return {
                "status": "resolved",
                "lat": 31.6356659,
                "lng": 74.8787496,
                "display_name": "Amritsar, Punjab, India",
                "provider": "nominatim",
            }

        with mock.patch("geocoding.geocode", side_effect=fake_geocode):
            response = self.client.post(f"/api/trips/{trip_id}/geocode")
            self.assertEqual(response.status_code, 200)
            payload = response.get_json()
            self.assertEqual(payload["lookup"]["status"], "resolved")
            self.assertTrue(payload["trip"]["has_coordinates"])
            self.assertEqual(payload["trip"]["origin_coords"], [31.3323762, 75.576889])
            self.assertEqual(
                payload["trip"]["destination_coords"], [31.6356659, 74.8787496]
            )
            self.assertEqual(calls[1][1], (31.3323762, 75.576889))
            self.assertEqual(len(store.get_db().execute("SELECT * FROM geocode_cache").fetchall()), 2)

            # A second request reuses the cached resolutions.
            before = len(calls)
            second = self.client.post(f"/api/trips/{trip_id}/geocode")
            self.assertEqual(second.status_code, 200)
            self.assertEqual(len(calls), before)

        row = store.get_trip(trip_id)
        self.assertAlmostEqual(row["origin_lat"], 31.3323762)
        self.assertAlmostEqual(row["destination_lng"], 74.8787496)
        self.assertEqual(row["geocode_status"], "resolved")

        listing = self.client.get("/api/trips").get_json()
        trip = next(item for item in listing["trips"] if item["id"] == trip_id)
        self.assertTrue(trip["has_coordinates"])

    def test_ambiguous_result_keeps_trip_unresolved_with_message(self):
        trip_id = self.make_trip(origin="Ludiana", destination="Amritsar")

        def fake_geocode(address, near=None):
            if address == "Ludiana":
                return {
                    "status": "ambiguous",
                    "message": "The address matches more than one place.",
                }
            return {
                "status": "resolved",
                "lat": 31.63,
                "lng": 74.87,
                "display_name": "Amritsar, India",
                "provider": "nominatim",
            }

        with mock.patch("geocoding.geocode", side_effect=fake_geocode):
            response = self.client.post(f"/api/trips/{trip_id}/geocode")

        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["lookup"]["status"], "ambiguous")
        self.assertIn("more than one", payload["lookup"]["message"])
        trip = payload["trip"]
        self.assertFalse(trip["has_coordinates"])
        self.assertEqual(trip["geocode_status"], "ambiguous")
        self.assertIsNotNone(trip["geocode_message"])
        row = store.get_trip(trip_id)
        self.assertIsNone(row["origin_lat"])

    def test_provider_failure_is_reported_without_coordinates(self):
        trip_id = self.make_trip()

        with mock.patch(
            "geocoding.geocode",
            side_effect=geocoding.GeocodeError(
                "unavailable", "The public geocoder could not be reached."
            ),
        ):
            response = self.client.post(f"/api/trips/{trip_id}/geocode")

        payload = response.get_json()
        self.assertEqual(payload["lookup"]["status"], "unavailable")
        self.assertFalse(payload["trip"]["has_coordinates"])
        self.assertIn("could not be reached", payload["trip"]["geocode_message"])

    def test_invalid_near_coordinate_and_empty_address(self):
        invalid = self.client.get(
            "/api/geocode", query_string={"address": "Amritsar", "near_lat": "oops", "near_lng": "74"}
        )
        self.assertEqual(invalid.status_code, 400)

        empty = self.client.get("/api/geocode", query_string={"address": ""})
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.get_json()["status"], "missing_address")

    def test_lookup_respects_disabled_setting(self):
        store.save_settings({"geocoding_enabled": "0"})
        trip_id = self.make_trip()
        response = self.client.post(f"/api/trips/{trip_id}/geocode")
        self.assertEqual(response.status_code, 403)

    def test_save_coordinates_marks_resolved_and_migration_adds_columns(self):
        trip_id = self.make_trip()
        store.save_coordinates(
            trip_id,
            (31.3323762, 75.576889),
            (31.6356659, 74.8787496),
        )
        row = store.get_trip(trip_id)
        payload = store.serialise_trip(row)
        self.assertTrue(payload["has_coordinates"])
        self.assertEqual(payload["geocode_status"], "resolved")

        database = store.get_db()
        for column in ("geocode_status", "geocode_message", "geocoded_at"):
            database.execute(f"ALTER TABLE trips DROP COLUMN {column}")
        store.init_db()
        columns = {row["name"] for row in store.get_db().execute("PRAGMA table_info(trips)")}
        self.assertTrue({"geocode_status", "geocode_message", "geocoded_at"} <= columns)
        self.assertIsNotNone(store.get_trip(trip_id))


class SuggestionApiTests(unittest.TestCase):
    def setUp(self):
        geocoding.clear_suggestion_cache()
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

    def test_suggestions_are_returned_with_coordinates_and_metadata(self):
        suggestion = geocoding._photon_candidate(photon_feature())
        with mock.patch("geocoding.suggest", return_value=[suggestion]) as suggest:
            response = self.client.get(
                "/api/locations/suggest",
                query_string={"q": "Civil Hospital", "near_lat": "31.33", "near_lng": "75.58", "limit": "6"},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["provider"], "photon")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["suggestions"][0]["place_id"], "N7866569666")
        self.assertEqual(payload["suggestions"][0]["lat"], 31.3265)
        self.assertIn("Jalandhar", payload["suggestions"][0]["formatted_address"])
        suggest.assert_called_once_with("Civil Hospital", (31.33, 75.58), 6)

    def test_short_query_returns_too_short_without_provider_call(self):
        with mock.patch("geocoding.suggest") as suggest:
            response = self.client.get("/api/locations/suggest", query_string={"q": "Ci"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "too_short")
        self.assertEqual(response.get_json()["suggestions"], [])
        suggest.assert_not_called()

    def test_empty_result_is_not_fabricated(self):
        with mock.patch("geocoding.suggest", return_value=[]):
            response = self.client.get("/api/locations/suggest", query_string={"q": "zzzz nowhere"})
        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "not_found")
        self.assertEqual(payload["suggestions"], [])
        self.assertIn("No matching places", payload["message"])

    def test_provider_failures_map_to_retryable_status_codes(self):
        cases = [("rate_limited", 429), ("unavailable", 503), ("invalid_response", 503)]
        for provider_status, expected_code in cases:
            with self.subTest(provider_status=provider_status):
                with mock.patch(
                    "geocoding.suggest",
                    side_effect=geocoding.GeocodeError(provider_status, "Provider failure"),
                ):
                    response = self.client.get(
                        "/api/locations/suggest", query_string={"q": "Civil Hospital"}
                    )
                self.assertEqual(response.status_code, expected_code)
                payload = response.get_json()
                self.assertEqual(payload["suggestions"], [])
                self.assertEqual(payload["status"], provider_status)
                self.assertIn("Provider failure", payload["error"])

    def test_disabled_setting_and_invalid_near_coordinates(self):
        store.save_settings({"geocoding_enabled": "0"})
        disabled = self.client.get("/api/locations/suggest", query_string={"q": "Civil Hospital"})
        self.assertEqual(disabled.status_code, 403)

        store.save_settings({"geocoding_enabled": "1"})
        app_module.g.settings = store.get_settings()
        invalid = self.client.get(
            "/api/locations/suggest",
            query_string={"q": "Civil Hospital", "near_lat": "north", "near_lng": "75"},
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.get_json()["suggestions"], [])

    def test_selected_coordinates_and_place_ids_persist_through_create_api(self):
        response = self.client.post(
            "/api/trips",
            json={
                "origin": "Civil Hospital, Civil Lines, Jalandhar, Punjab, India",
                "destination": "Amritsar, Punjab, India",
                "priority": "high",
                "status": "in_transit",
                "origin_lat": 31.3265,
                "origin_lng": 75.5792,
                "destination_lat": 31.6357,
                "destination_lng": 74.8787,
                "origin_place_id": "N7866569666",
                "destination_place_id": "N2456789012",
            },
        )
        self.assertEqual(response.status_code, 201)
        trip = response.get_json()["trip"]
        self.assertTrue(trip["has_coordinates"])
        self.assertEqual(trip["origin_coords"], [31.3265, 75.5792])
        self.assertEqual(trip["destination_coords"], [31.6357, 74.8787])
        self.assertEqual(trip["origin_place_id"], "N7866569666")
        self.assertEqual(trip["destination_place_id"], "N2456789012")

        row = store.get_trip(trip["id"])
        self.assertEqual(row["origin_place_id"], "N7866569666")
        self.assertEqual(row["destination_lat"], 31.6357)

    def test_manual_address_without_selection_stores_no_fabricated_coordinates(self):
        response = self.client.post(
            "/api/trips",
            json={
                "origin": "Civil Hospital, Jalandhar",
                "destination": "Amritsar",
                "priority": "high",
                "status": "in_transit",
            },
        )
        self.assertEqual(response.status_code, 201)
        trip = response.get_json()["trip"]
        self.assertFalse(trip["has_coordinates"])
        self.assertIsNone(trip["origin_coords"])
        self.assertIsNone(trip["origin_place_id"])


if __name__ == "__main__":
    unittest.main()
