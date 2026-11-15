"""Give one unit an open response, so the crew phone has something to show.

The admin database ships with responses that are either complete or assigned to
nobody. A phone signing in as a unit with no assignment sees an empty Home, which
looks like a broken integration rather than an empty queue.

This script does the smallest thing that fixes that:

    python seed_driver_demo.py --unit MEDIC-12

It takes the newest open response with no vehicle, assigns it to the named unit,
resolves and stores its route, and prints the unit code to type into the phone.

Nothing is deleted. Run it twice and it will report that the unit already has an
open response. To undo, clear `vehicle_id` on that trip in the admin UI.
"""

from __future__ import annotations

import argparse
import re
import sys

import app as app_module
import db as store
import routing


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.strip().lower())


def find_vehicle(call_sign: str):
    wanted = slug(call_sign)
    for vehicle in store.list_vehicles():
        if slug(vehicle["call_sign"]) == wanted:
            return vehicle
    return None


def assign_open_trip(vehicle):
    existing = store.unit_open_trips(vehicle["id"])
    if existing:
        return existing[0], False

    row = store.get_db().execute(
        """
        SELECT * FROM trips
        WHERE vehicle_id IS NULL
          AND status IN ('scheduled', 'accepted', 'in_transit', 'on_scene')
        ORDER BY id DESC LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None, False

    with store.get_db():
        store.get_db().execute(
            "UPDATE trips SET vehicle_id = ? WHERE id = ? AND vehicle_id IS NULL",
            (vehicle["id"], row["id"]),
        )
    store.add_manual_event(
        row["id"],
        "assigned",
        f"Assigned to {vehicle['call_sign']} for the crew phone demo.",
    )
    return store.get_trip(row["id"]), True


DEMO_ORIGIN = ("Marol Fire Station, Mumbai", 19.1136, 72.8697)
DEMO_DESTINATION = ("Saki Naka Industrial Estate, Mumbai", 19.0994, 72.8891)


def create_demo_trip(vehicle):
    """A response that actually has a shape to draw.

    Only used when the assigned response carries no coordinates, which is the
    common state of the seeded dataset: without this the crew screen would show
    the honest "no map" panel and look unintegrated.
    """
    trip_id = store.create_trip(
        origin=DEMO_ORIGIN[0],
        destination=DEMO_DESTINATION[0],
        priority="critical",
        status="scheduled",
        distance_km=None,
        duration_min=None,
        origin_lat=DEMO_ORIGIN[1],
        origin_lng=DEMO_ORIGIN[2],
        destination_lat=DEMO_DESTINATION[1],
        destination_lng=DEMO_DESTINATION[2],
        emergency_type="fire",
        dispatch_at=store.iso_now(),
        instructions="Report to the gate on the north side.",
        vehicle_id=vehicle["id"],
    )
    store.add_manual_event(
        trip_id,
        "assigned",
        f"Demo response created for the crew phone ({vehicle['call_sign']}).",
    )
    return store.get_trip(trip_id)


def ensure_route(trip):
    if trip["origin_lat"] is None or trip["destination_lat"] is None:
        return "no coordinates on this response; skipped routing"
    if store.active_route(trip["id"]) is not None:
        return "route already stored"
    try:
        resolved = routing.resolve_route(
            (trip["origin_lat"], trip["origin_lng"]),
            (trip["destination_lat"], trip["destination_lng"]),
        )
    except routing.RoutingError as error:
        resolved = routing.straight_line(
            (trip["origin_lat"], trip["origin_lng"]),
            (trip["destination_lat"], trip["destination_lng"]),
        )
        store.save_route(trip["id"], resolved, reason="seed-fallback")
        return f"provider unavailable ({error}); stored a straight line"

    store.save_route(trip["id"], resolved, reason="seed")
    return f"stored {len(resolved['geometry'])} points from {resolved['provider']}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", required=True, help="call sign, e.g. MEDIC-12")
    args = parser.parse_args(argv)

    with app_module.app.app_context():
        vehicle = find_vehicle(args.unit)
        if vehicle is None:
            print(f"No vehicle registry entry matches {args.unit!r}.", file=sys.stderr)
            print("Known units:", ", ".join(v["call_sign"] for v in store.list_vehicles()), file=sys.stderr)
            return 1

        trip, created = assign_open_trip(vehicle)
        if trip is None:
            print(
                "Every open response already has a vehicle. Create one in the admin, then rerun.",
                file=sys.stderr,
            )
            return 1

        note = ensure_route(trip)
        if store.active_route(trip["id"]) is None and (
            trip["origin_lat"] is None or trip["destination_lat"] is None
        ):
            # Nothing mappable was waiting, so open one that is.
            trip = create_demo_trip(vehicle)
            note = ensure_route(trip)

        print(f"unit        {vehicle['call_sign']} ({vehicle['vehicle_type']})")
        print(f"unit code   token-{slug(vehicle['call_sign'])}")
        print(f"response    {trip['reference']} · {trip['status']}")
        print(f"assigned    {'yes, just now' if created else 'already had one'}")
        print(f"route       {note}")
        print()
        print("In the phone: sign in with call sign", vehicle["call_sign"],
              "and any 4-digit PIN you choose.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
