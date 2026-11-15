"""Route resolution for GreenRoute.

One seam for every caller. The admin pages and the crew phones both ask this
module for a route instead of building provider URLs inside a template or a
browser script, which is where the two copies used to live.

The provider is an adapter, chosen by environment variable:

    GREENROUTE_ROUTE_URL   base URL of an OSRM-compatible /route/v1/driving

Defaults to the public OSRM demo server. That server is free and carries no
service guarantee, and its profile is free-flow: it does not know about live
traffic or about an emergency vehicle's priority. Treat the returned duration
as an estimate from a normal car, never as a promise.

Nothing here talks to a traffic-signal system. A "green route" is a recommended
path plus an advisory corridor around it; see docs/greenroute-architecture.md.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PROVIDER_URL = "https://router.project-osrm.org/route/v1/driving"

#: Seconds before a provider call is abandoned. A route that takes longer than
#: this is worth failing: the caller has a straight-line fallback.
TIMEOUT_SECONDS = 6.0

#: A cache hit is only reused while the road network is assumed unchanged.
CACHE_TTL_SECONDS = 24 * 60 * 60

#: Coordinates are rounded before they become a cache key, so two lookups a few
#: centimetres apart share an entry. 5 dp is about 1.1 m.
KEY_DP = 5


class RoutingError(RuntimeError):
    """The provider could not be asked, or answered with something unusable."""


def provider_url() -> str:
    return (os.environ.get("GREENROUTE_ROUTE_URL") or DEFAULT_PROVIDER_URL).rstrip("/")


def cache_key(origin, destination, profile: str = "driving") -> str:
    """Stable key for a coordinate pair. Order matters: A→B is not B→A."""
    def point(pair):
        lat, lng = pair
        return f"{round(float(lat), KEY_DP)},{round(float(lng), KEY_DP)}"

    return f"{profile}:{point(origin)}->{point(destination)}"


def _valid_pair(pair) -> bool:
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        return False
    try:
        lat, lng = float(pair[0]), float(pair[1])
    except (TypeError, ValueError):
        return False
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return False
    return not (lat == 0 and lng == 0)


def _flip(geometry):
    """OSRM speaks [lng, lat]; every consumer here speaks [lat, lng]."""
    return [[point[1], point[0]] for point in geometry]


def request_route(origin, destination, timeout: float = TIMEOUT_SECONDS, waypoints=None):
    """Ask the provider. Raises RoutingError on any failure.

    `waypoints` are optional intermediate stops, in order. The admin's create
    screen can carry several; the phone only ever needs two points.
    """
    if not _valid_pair(origin) or not _valid_pair(destination):
        raise RoutingError("Both endpoints need valid coordinates.")

    stops = [origin]
    for point in waypoints or []:
        if _valid_pair(point):
            stops.append(point)
    stops.append(destination)

    coords = ";".join(f"{float(lat_lng[1])},{float(lat_lng[0])}" for lat_lng in stops)
    query = urllib.parse.urlencode(
        {
            "overview": "full",
            "geometries": "geojson",
            "alternatives": "false",
            "steps": "false",
        }
    )
    url = f"{provider_url()}/{coords}?{query}"

    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise RoutingError(f"Route provider rejected the request ({error.code}).") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RoutingError("Route provider is unreachable.") from error

    try:
        parsed = json.loads(body)
    except ValueError as error:
        raise RoutingError("Route provider returned an unreadable answer.") from error

    if parsed.get("code") != "Ok":
        raise RoutingError(parsed.get("message") or "No route between those points.")

    routes = parsed.get("routes") or []
    if not routes:
        raise RoutingError("No route between those points.")

    route = routes[0]
    geometry = (route.get("geometry") or {}).get("coordinates") or []
    if len(geometry) < 2:
        raise RoutingError("Route provider returned a route with no shape.")

    distance_m = route.get("distance")
    duration_s = route.get("duration")
    if distance_m is None or duration_s is None:
        raise RoutingError("Route provider returned no distance or duration.")

    return {
        "geometry": _flip(geometry),
        "distance_m": float(distance_m),
        "duration_s": float(duration_s),
        "provider": "osrm",
    }


def resolve_route(origin, destination, waypoints=None):
    """Provider call with a database cache in front of it.

    Imported lazily so this module stays importable without a Flask app context,
    which is what makes it testable on its own.
    """
    key = cache_key(origin, destination)
    if waypoints:
        key = key + "|" + "|".join(
            f"{round(float(point[0]), KEY_DP)},{round(float(point[1]), KEY_DP)}"
            for point in waypoints
            if _valid_pair(point)
        )

    import db as store  # local import: avoids a circular import at module load

    cached = store.route_cache_get(key, CACHE_TTL_SECONDS)
    if cached is not None:
        return cached

    resolved = request_route(origin, destination, waypoints=waypoints)
    store.route_cache_put(key, resolved)
    return resolved


def straight_line(origin, destination):
    """The honest fallback when routing is unavailable.

    Deliberately a two-point geometry, not a pretend road: the UI says "direct
    line" rather than drawing something that looks like a route.
    """
    import geocoding

    return {
        "geometry": [
            [float(origin[0]), float(origin[1])],
            [float(destination[0]), float(destination[1])],
        ],
        "distance_m": geocoding.haversine_km(origin, destination) * 1000,
        "duration_s": None,
        "provider": "straight-line",
    }
