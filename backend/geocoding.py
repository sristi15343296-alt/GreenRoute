"""Server-side address geocoding for GreenRoute.

Nominatim is used as the public OpenStreetMap geocoder. Requests are
serialised to at most one per second, identified with a configurable
User-Agent, and callers are expected to cache results. The client never
invents a location: no match and ambiguous matches are distinct outcomes.
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict

PROVIDER = "nominatim"
ATTRIBUTION = "Nominatim / OpenStreetMap contributors"
SUGGESTION_PROVIDER = "photon"
SUGGESTION_ATTRIBUTION = "Photon / OpenStreetMap contributors"

NOMINATIM_URL = os.environ.get(
    "GREENROUTE_NOMINATIM_URL",
    "https://nominatim.openstreetmap.org/search",
).strip()
USER_AGENT = os.environ.get(
    "GREENROUTE_GEOCODING_USER_AGENT",
    "GreenRoute/1.0 (local operations console)",
).strip()
EMAIL = os.environ.get("GREENROUTE_GEOCODING_EMAIL", "").strip()
MIN_INTERVAL = max(
    1.0,
    float(os.environ.get("GREENROUTE_GEOCODING_MIN_INTERVAL", "1.1")),
)
TIMEOUT = max(3.0, float(os.environ.get("GREENROUTE_GEOCODING_TIMEOUT", "12")))
CONTEXT_RADIUS_KM = max(
    1.0,
    float(os.environ.get("GREENROUTE_GEOCODING_CONTEXT_KM", "150")),
)
MAX_RESULTS = 5

# Photon is the autocomplete provider because public Nominatim explicitly
# prohibits search-as-you-type traffic. It is OSM-backed, key-free and can be
# self-hosted through GREENROUTE_PHOTON_URL without changing this integration.
PHOTON_URL = os.environ.get(
    "GREENROUTE_PHOTON_URL",
    "https://photon.komoot.io/api/",
).strip()
SUGGESTION_MIN_LENGTH = 3
SUGGESTION_LIMIT = 8
SUGGESTION_CACHE_TTL = max(
    30.0,
    float(os.environ.get("GREENROUTE_SUGGESTION_CACHE_TTL", "300")),
)
SUGGESTION_CACHE_SIZE = max(
    32,
    int(os.environ.get("GREENROUTE_SUGGESTION_CACHE_SIZE", "256")),
)
PHOTON_MIN_INTERVAL = max(
    0.25,
    float(os.environ.get("GREENROUTE_PHOTON_MIN_INTERVAL", "0.4")),
)
PHOTON_TIMEOUT = max(
    3.0,
    float(os.environ.get("GREENROUTE_PHOTON_TIMEOUT", "8")),
)

_REQUEST_LOCK = threading.Lock()
_LAST_REQUEST_AT = 0.0

_PHOTON_LOCK = threading.Lock()
_LAST_PHOTON_REQUEST_AT = 0.0
_SUGGESTION_CACHE = OrderedDict()
_SUGGESTION_CACHE_LOCK = threading.Lock()


class GeocodeError(Exception):
    """An upstream provider failure that should be reported to the operator."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def normalise_address(value):
    return " ".join(str(value or "").split()).strip()


def coordinate_is_valid(lat, lng):
    try:
        lat = float(lat)
        lng = float(lng)
    except (TypeError, ValueError):
        return False
    return (
        math.isfinite(lat)
        and math.isfinite(lng)
        and -90.0 <= lat <= 90.0
        and -180.0 <= lng <= 180.0
        and not (abs(lat) < 1e-9 and abs(lng) < 1e-9)
    )


def haversine_km(first, second):
    lat1, lng1 = math.radians(float(first[0])), math.radians(float(first[1]))
    lat2, lng2 = math.radians(float(second[0])), math.radians(float(second[1]))
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    )
    return 6371.0088 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def context_key(near):
    """Cache key for the disambiguation context, not the exact coordinate."""
    if not near or not coordinate_is_valid(near[0], near[1]):
        return ""
    return f"{round(float(near[0]), 1):.1f},{round(float(near[1]), 1):.1f}"


def _wait_for_rate_limit():
    global _LAST_REQUEST_AT
    with _REQUEST_LOCK:
        elapsed = time.monotonic() - _LAST_REQUEST_AT
        if elapsed < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - elapsed)
        _LAST_REQUEST_AT = time.monotonic()


def _request_nominatim(address, near=None):
    params = {
        "q": address,
        "format": "jsonv2",
        "limit": str(MAX_RESULTS),
        "addressdetails": "1",
        "accept-language": "en",
    }
    if EMAIL:
        params["email"] = EMAIL
    if near and coordinate_is_valid(near[0], near[1]):
        lat, lng = float(near[0]), float(near[1])
        # Bias the public search toward the recorded origin without excluding
        # a legitimate longer-distance destination.
        params["viewbox"] = f"{lng - 0.9},{lat + 0.9},{lng + 0.9},{lat - 0.9}"
        params["bounded"] = "0"

    url = NOMINATIM_URL + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en",
        },
    )
    _wait_for_rate_limit()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise GeocodeError(
                "rate_limited",
                "The public geocoder is rate limiting requests. Try again shortly.",
            ) from error
        raise GeocodeError(
            "unavailable",
            f"The public geocoder returned HTTP {error.code}. Try again later.",
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GeocodeError(
            "unavailable",
            "The public geocoder could not be reached. Check the network and try again.",
        ) from error

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GeocodeError(
            "invalid_response",
            "The public geocoder returned an unreadable response.",
        ) from error
    if not isinstance(payload, list):
        raise GeocodeError(
            "invalid_response",
            "The public geocoder returned an unexpected response.",
        )
    return payload


def _candidate(raw):
    if not isinstance(raw, dict):
        return None
    try:
        lat = float(raw.get("lat"))
        lng = float(raw.get("lon"))
    except (TypeError, ValueError):
        return None
    if not coordinate_is_valid(lat, lng):
        return None
    display_name = normalise_address(raw.get("display_name"))
    if not display_name:
        return None
    address = raw.get("address") if isinstance(raw.get("address"), dict) else {}
    country_code = str(address.get("country_code") or "").strip().lower()
    try:
        importance = float(raw.get("importance") or 0)
    except (TypeError, ValueError):
        importance = 0.0
    try:
        place_rank = int(raw.get("place_rank") or 0)
    except (TypeError, ValueError):
        place_rank = 0
    return {
        "lat": lat,
        "lng": lng,
        "display_name": display_name,
        "type": str(raw.get("type") or ""),
        "place_rank": place_rank,
        "importance": importance,
        "country_code": country_code,
        "provider_ref": str(raw.get("place_id") or ""),
    }


def _distance_between(first, second):
    return haversine_km(
        (first["lat"], first["lng"]),
        (second["lat"], second["lng"]),
    )


def choose_candidate(candidates, near=None):
    """Choose a defensible result, or refuse to choose an ambiguous one."""
    if not candidates:
        return {
            "status": "not_found",
            "message": "No matching location was found for this address.",
        }

    if near and coordinate_is_valid(near[0], near[1]):
        nearby = [
            item for item in candidates
            if haversine_km((near[0], near[1]), (item["lat"], item["lng"]))
            <= CONTEXT_RADIUS_KM
        ]
        if nearby:
            nearby.sort(key=lambda item: (_distance_between(
                {"lat": near[0], "lng": near[1]}, item
            ), -item["importance"]))
            return {"status": "resolved", **nearby[0]}

    best = max(candidates, key=lambda item: (item["importance"], -item["place_rank"]))
    if len(candidates) > 1:
        spread = max(_distance_between(best, item) for item in candidates)
        second_importance = max(
            (item["importance"] for item in candidates if item is not best),
            default=0.0,
        )
        dominant = (
            best["importance"] >= 0.15
            and best["importance"] >= second_importance * 2
        )
        if spread > 25.0 and not dominant:
            return {
                "status": "ambiguous",
                "message": (
                    "The address matches more than one place. Add a city, "
                    "region or landmark."
                ),
                "candidates": [
                    {
                        "display_name": item["display_name"],
                        "lat": item["lat"],
                        "lng": item["lng"],
                    }
                    for item in candidates[:3]
                ],
            }

    return {"status": "resolved", **best}


_PHOTON_KIND_LABELS = {
    "hospital": "Hospital",
    "clinic": "Clinic",
    "doctors": "Medical practice",
    "pharmacy": "Pharmacy",
    "school": "School",
    "college": "College",
    "university": "University",
    "city": "City",
    "town": "Town",
    "village": "Village",
    "locality": "Locality",
    "street": "Street",
    "house": "Address",
    "residential": "Residential area",
    "commercial": "Commercial area",
}


def _dedupe_address_parts(parts):
    cleaned = []
    seen = set()
    for part in parts:
        value = normalise_address(part)
        folded = value.casefold()
        if value and folded not in seen:
            seen.add(folded)
            cleaned.append(value)
    return cleaned


def _photon_kind(properties):
    osm_key = str(properties.get("osm_key") or "").strip().lower()
    osm_value = str(properties.get("osm_value") or properties.get("type") or "").strip().lower()
    if osm_key == "healthcare":
        return "Healthcare"
    if osm_value in _PHOTON_KIND_LABELS:
        return _PHOTON_KIND_LABELS[osm_value]
    if osm_key == "highway" and osm_value:
        return "Road"
    return osm_value.replace("_", " ").title() or "Place"


def _photon_address(properties):
    """Build a readable, de-duplicated address from Photon properties."""
    primary = normalise_address(
        properties.get("name")
        or properties.get("street")
        or properties.get("city")
        or properties.get("county")
        or properties.get("country")
    )
    street = normalise_address(
        " ".join(
            str(properties.get(key) or "").strip()
            for key in ("housenumber", "street")
            if str(properties.get(key) or "").strip()
        )
    )
    parts = [primary]
    if street and street.casefold() != primary.casefold():
        parts.append(street)
    for key in ("district", "locality", "city", "county", "state", "postcode", "country"):
        value = normalise_address(properties.get(key))
        if value:
            parts.append(value)
    parts = _dedupe_address_parts(parts)
    formatted = ", ".join(parts)[:300]
    secondary = ", ".join(parts[1:])[:240]
    return primary or formatted, secondary, formatted


def _photon_candidate(feature):
    if not isinstance(feature, dict):
        return None
    geometry = feature.get("geometry")
    properties = feature.get("properties")
    if not isinstance(geometry, dict) or not isinstance(properties, dict):
        return None
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
        return None
    try:
        lng = float(coordinates[0])
        lat = float(coordinates[1])
    except (TypeError, ValueError):
        return None
    if not coordinate_is_valid(lat, lng):
        return None
    primary, secondary, formatted = _photon_address(properties)
    if not formatted:
        return None
    osm_type = str(properties.get("osm_type") or "").strip().upper()
    osm_id = str(properties.get("osm_id") or "").strip()
    place_id = (osm_type + osm_id) if osm_type and osm_id else str(properties.get("id") or "")
    country_code = str(properties.get("countrycode") or "").strip().lower()
    return {
        "place_id": place_id,
        "name": primary,
        "primary": primary,
        "secondary": secondary,
        "formatted_address": formatted,
        "lat": lat,
        "lng": lng,
        "kind": _photon_kind(properties),
        "osm_type": osm_type,
        "osm_value": str(properties.get("osm_value") or "").strip(),
        "country_code": country_code,
        "provider": SUGGESTION_PROVIDER,
    }


def _wait_for_photon_rate_limit():
    global _LAST_PHOTON_REQUEST_AT
    with _PHOTON_LOCK:
        elapsed = time.monotonic() - _LAST_PHOTON_REQUEST_AT
        if elapsed < PHOTON_MIN_INTERVAL:
            time.sleep(PHOTON_MIN_INTERVAL - elapsed)
        _LAST_PHOTON_REQUEST_AT = time.monotonic()


def _request_photon(query, near=None, limit=SUGGESTION_LIMIT):
    params = {
        "q": query,
        "limit": str(limit),
        "lang": "en",
    }
    if near and coordinate_is_valid(near[0], near[1]):
        params["lat"] = f"{float(near[0]):.6f}"
        params["lon"] = f"{float(near[1]):.6f}"
    url = PHOTON_URL + ("&" if "?" in PHOTON_URL else "?") + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en",
        },
    )
    _wait_for_photon_rate_limit()
    try:
        with urllib.request.urlopen(request, timeout=PHOTON_TIMEOUT) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise GeocodeError(
                "rate_limited",
                "Location search is receiving too many requests. Try again shortly.",
            ) from error
        raise GeocodeError(
            "unavailable",
            f"Location search returned HTTP {error.code}. Try again later.",
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise GeocodeError(
            "unavailable",
            "Location search could not be reached. Check the network and try again.",
        ) from error
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GeocodeError(
            "invalid_response",
            "Location search returned an unreadable response.",
        ) from error
    if not isinstance(payload, dict) or not isinstance(payload.get("features"), list):
        raise GeocodeError(
            "invalid_response",
            "Location search returned an unexpected response.",
        )
    return payload["features"]


def _suggestion_cache_key(query, near, limit):
    return f"{query.casefold()}|{context_key(near)}|{limit}"


def _cached_suggestions(key):
    now = time.monotonic()
    with _SUGGESTION_CACHE_LOCK:
        entry = _SUGGESTION_CACHE.get(key)
        if not entry:
            return None
        if entry[0] <= now:
            _SUGGESTION_CACHE.pop(key, None)
            return None
        _SUGGESTION_CACHE.move_to_end(key)
        return [dict(item) for item in entry[1]]


def _store_suggestions(key, suggestions):
    now = time.monotonic()
    with _SUGGESTION_CACHE_LOCK:
        _SUGGESTION_CACHE[key] = (now + SUGGESTION_CACHE_TTL, [dict(item) for item in suggestions])
        _SUGGESTION_CACHE.move_to_end(key)
        while len(_SUGGESTION_CACHE) > SUGGESTION_CACHE_SIZE:
            _SUGGESTION_CACHE.popitem(last=False)


def clear_suggestion_cache():
    with _SUGGESTION_CACHE_LOCK:
        _SUGGESTION_CACHE.clear()


def suggest(query, near=None, limit=SUGGESTION_LIMIT):
    """Return ranked Photon suggestions, including real coordinates and IDs."""
    query = normalise_address(query)
    if len(query) < SUGGESTION_MIN_LENGTH:
        return []
    try:
        limit = max(1, min(SUGGESTION_LIMIT, int(limit)))
    except (TypeError, ValueError):
        limit = SUGGESTION_LIMIT

    key = _suggestion_cache_key(query, near, limit)
    cached = _cached_suggestions(key)
    if cached is not None:
        return cached

    features = _request_photon(query, near, limit)
    suggestions = []
    seen_places = set()
    seen_coordinates = set()
    for feature in features:
        suggestion = _photon_candidate(feature)
        if not suggestion:
            continue
        coordinate_key = f"{suggestion['lat']:.5f},{suggestion['lng']:.5f}"
        place_key = suggestion["place_id"] or coordinate_key
        if place_key in seen_places or coordinate_key in seen_coordinates:
            continue
        seen_places.add(place_key)
        seen_coordinates.add(coordinate_key)
        suggestions.append(suggestion)
        if len(suggestions) >= limit:
            break
    _store_suggestions(key, suggestions)
    return suggestions


def geocode(address, near=None):
    """Resolve one address. Returns a status dict, never invented coordinates."""
    address = normalise_address(address)
    if len(address) < 2:
        return {
            "status": "missing_address",
            "message": "The recorded address is too short to look up.",
        }
    try:
        raw_results = _request_nominatim(address, near)
    except GeocodeError as error:
        # Public endpoints occasionally drop an otherwise healthy connection.
        # Retry one transient failure; the rate limiter still spaces requests.
        if error.status != "unavailable":
            raise
        raw_results = _request_nominatim(address, near)
    candidates = [item for item in (_candidate(raw) for raw in raw_results) if item]
    result = choose_candidate(candidates, near)
    result["address"] = address
    result["provider"] = PROVIDER
    result["attribution"] = ATTRIBUTION
    return result
