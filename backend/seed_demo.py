"""Populate GreenRoute with demo trips and response resources.

Usage:
    python seed_demo.py                  # add the demo dataset
    python seed_demo.py --resources-only # add only missing vehicle/personnel records
    python seed_demo.py --clear          # remove only records created by this script

Created ids are stored in instance/demo-seed.json so that clearing never
touches records entered by a real operator.
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import app as application
import db

MANIFEST = os.path.join(application.app.instance_path, "demo-seed.json")

# Real Indian logistics lanes with recorded coordinates. Ages spread the records
# over the last two weeks so the register and analytics ranges have real history.
DEMO_TRIPS = [
    ("Mumbai Port (JNPT), Maharashtra", "Pune Distribution Centre, Maharashtra", "high", "in_transit", 148.0, 190, 19.0760, 72.8777, 18.5204, 73.8567, 2),
    ("Pune Distribution Centre, Maharashtra", "Nashik Warehouse, Maharashtra", "high", "on_scene", 210.0, 240, 18.5204, 73.8567, 19.9975, 73.7898, 5),
    ("Delhi Gateway, Delhi", "Jaipur Logistics Park, Rajasthan", "critical", "in_transit", 281.0, 300, 28.6139, 77.2090, 26.9124, 75.7873, 7),
    ("Gurugram Hub, Haryana", "Agra Terminal, Uttar Pradesh", "critical", "accepted", 178.0, 210, 28.4595, 77.0266, 27.1767, 78.0081, 12),
    ("Bengaluru Warehouse, Karnataka", "Chennai Freight Hub, Tamil Nadu", "normal", "in_transit", 349.0, 360, 12.9716, 77.5946, 13.0827, 80.2707, 15),
    ("Ahmedabad Depot, Gujarat", "Surat Terminal, Gujarat", "normal", "completed", 265.0, 270, 23.0225, 72.5714, 21.1702, 72.8311, 26),
    ("Hyderabad Distribution Centre, Telangana", "Nagpur Cross-dock, Maharashtra", "normal", "completed", 501.0, 480, 17.3850, 78.4867, 21.1458, 79.0882, 40),
    ("Kolkata Freight Yard, West Bengal", "Bhubaneswar Hub, Odisha", "high", "completed", 442.0, 450, 22.5726, 88.3639, 20.2961, 85.8245, 58),
    ("Kochi Port, Kerala", "Coimbatore Depot, Tamil Nadu", "high", "completed", 190.0, 240, 9.9312, 76.2673, 11.0168, 76.9558, 76),
    ("Lucknow Terminal, Uttar Pradesh", "Kanpur Warehouse, Uttar Pradesh", "critical", "scheduled", 82.0, 105, 26.8467, 80.9462, 26.4499, 80.3319, 99),
    ("Indore Consolidation, Madhya Pradesh", "Bhopal Hub, Madhya Pradesh", "normal", "scheduled", 195.0, 210, 22.7196, 75.8577, 23.2599, 77.4126, 130),
    ("Chandigarh Freight Centre, Punjab", "Ludhiana Depot, Punjab", "normal", "cancelled", 112.0, 150, 30.7333, 76.7794, 30.9010, 75.8573, 190),
]


DEMO_VEHICLES = [
    ("MEDIC-11", "ambulance", "MH-01-AB-1122", "Andheri Emergency Station, Mumbai", "available", "Advanced life support"),
    ("MEDIC-12", "ambulance", "MH-01-AB-1188", "Bandra Emergency Station, Mumbai", "available", "Basic life support"),
    ("ENGINE-4", "fire_engine", "MH-01-FE-0404", "Worli Fire Station, Mumbai", "available", "Pump and aerial ladder"),
    ("RESCUE-2", "rescue_unit", "MH-01-RU-0202", "Colaba Rescue Station, Mumbai", "available", "Heavy rescue and extraction"),
    ("HAZMAT-1", "hazmat_unit", "MH-01-HZ-0101", "Chembur Hazard Station, Mumbai", "available", "Chemical and hazardous material response"),
    ("COMMAND-1", "supervisor", "MH-01-CV-0001", "Mumbai Emergency Operations Centre", "maintenance", "Incident command vehicle"),
]

DEMO_PERSONNEL = [
    ("GR-201", "Meera Kulkarni", "paramedic", "Andheri Emergency Station, Mumbai", "on_duty"),
    ("GR-202", "Rohan Sawant", "emergency_driver", "Andheri Emergency Station, Mumbai", "on_duty"),
    ("GR-203", "Ayesha Khan", "paramedic", "Bandra Emergency Station, Mumbai", "on_duty"),
    ("GR-204", "Vikram Patil", "firefighter", "Worli Fire Station, Mumbai", "on_duty"),
    ("GR-205", "Neha Deshmukh", "firefighter", "Worli Fire Station, Mumbai", "on_duty"),
    ("GR-206", "Arjun Nair", "rescue_technician", "Colaba Rescue Station, Mumbai", "on_duty"),
    ("GR-207", "Sana Sheikh", "hazmat_specialist", "Chembur Hazard Station, Mumbai", "on_duty"),
    ("GR-208", "Kabir Rao", "supervisor", "Mumbai Emergency Operations Centre", "off_duty"),
]


def _timestamp(hours_ago):
    moment = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours_ago)
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def _load_manifest():
    if not os.path.exists(MANIFEST):
        return {}
    with open(MANIFEST, encoding="utf-8") as handle:
        return json.load(handle)


def seed_resources(known_vehicle_ids=None, known_personnel_ids=None):
    vehicle_ids = []
    personnel_ids = []
    known_vehicle_ids = set(known_vehicle_ids or [])
    known_personnel_ids = set(known_personnel_ids or [])
    existing_vehicles = {row["call_sign"]: row for row in db.list_vehicles()}
    existing_personnel = {row["employee_id"]: row for row in db.list_personnel()}
    for call_sign, vehicle_type, registration, base, status, notes in DEMO_VEHICLES:
        existing = existing_vehicles.get(call_sign)
        if existing:
            if existing["id"] in known_vehicle_ids:
                vehicle_ids.append(existing["id"])
            continue
        vehicle_ids.append(
            db.create_vehicle(
                call_sign=call_sign,
                vehicle_type=vehicle_type,
                registration=registration,
                base_location=base,
                status=status,
                notes=notes,
            )
        )
    for employee_id, name, role, base, status in DEMO_PERSONNEL:
        existing = existing_personnel.get(employee_id)
        if existing:
            if existing["id"] in known_personnel_ids:
                personnel_ids.append(existing["id"])
            continue
        personnel_ids.append(
            db.create_personnel(
                employee_id=employee_id,
                name=name,
                role=role,
                base_location=base,
                status=status,
            )
        )
    return vehicle_ids, personnel_ids


def seed():
    if os.path.exists(MANIFEST):
        raise SystemExit(
            "Demo data is already seeded. Run 'python seed_demo.py --resources-only' "
            "or 'python seed_demo.py --clear' first."
        )

    created_ids = []
    with application.app.app_context():
        database = application.app.config["DATABASE"]
        for origin, destination, priority, status, distance, duration, olat, olng, dlat, dlng, age in DEMO_TRIPS:
            trip_id = db.create_trip(
                origin=origin,
                destination=destination,
                priority=priority,
                status="scheduled",
                distance_km=distance,
                duration_min=duration,
                origin_lat=olat,
                origin_lng=olng,
                destination_lat=dlat,
                destination_lng=dlng,
            )
            if status in {"accepted", "on_scene"}:
                db.update_status(trip_id, "accept")
            if status == "on_scene":
                db.update_status(trip_id, "depart")
                db.update_status(trip_id, "arrive")
            if status in {"in_transit", "completed"}:
                db.update_status(trip_id, "start")
            if status == "completed":
                db.update_status(trip_id, "complete")
            elif status == "cancelled":
                db.update_status(trip_id, "cancel")

            created = _timestamp(age)
            accepted_at = _timestamp(age - 1) if status in {"accepted", "on_scene"} else None
            started = _timestamp(age - 1) if status in {"in_transit", "completed", "on_scene"} else None
            arrived_at = _timestamp(age - 2) if status == "on_scene" else None
            closed = _timestamp(age - 2) if status in {"completed", "cancelled"} else None

            connection = sqlite3.connect(database)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            with connection:
                connection.execute(
                    "UPDATE trips SET created_at = ?, started_at = ?, completed_at = ?, cancelled_at = ? WHERE id = ?",
                    (
                        created,
                        started,
                        closed if status == "completed" else None,
                        closed if status == "cancelled" else None,
                        trip_id,
                    ),
                )
                for event in connection.execute(
                    "SELECT id, kind FROM trip_events WHERE trip_id = ? ORDER BY id", (trip_id,)
                ).fetchall():
                    when = {
                        "created": created,
                        "accepted": accepted_at,
                        "started": started,
                        "departed": started,
                        "arrived": arrived_at,
                        "completed": closed,
                        "cancelled": closed,
                    }.get(event["kind"], created)
                    connection.execute(
                        "UPDATE trip_events SET created_at = ? WHERE id = ?", (when, event["id"])
                    )
            created_ids.append(trip_id)

        vehicle_ids, personnel_ids = seed_resources()

    os.makedirs(application.app.instance_path, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "created_at": db.iso_now(),
                "ids": created_ids,
                "vehicle_ids": vehicle_ids,
                "personnel_ids": personnel_ids,
            },
            handle,
            indent=2,
        )

    print(
        f"Seeded {len(created_ids)} demo trips and {len(vehicle_ids)} vehicles / "
        f"{len(personnel_ids)} personnel records."
    )


def seed_only_resources():
    manifest = _load_manifest()
    with application.app.app_context():
        vehicle_ids, personnel_ids = seed_resources(
            manifest.get("vehicle_ids", []), manifest.get("personnel_ids", [])
        )
    manifest.update(
        {
            "created_at": manifest.get("created_at", db.iso_now()),
            "ids": manifest.get("ids", []),
            "vehicle_ids": vehicle_ids,
            "personnel_ids": personnel_ids,
        }
    )
    os.makedirs(application.app.instance_path, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"Seeded {len(vehicle_ids)} vehicles and {len(personnel_ids)} personnel records.")


def clear():
    if not os.path.exists(MANIFEST):
        raise SystemExit("No demo seed manifest found; nothing to clear.")
    with open(MANIFEST, encoding="utf-8") as handle:
        manifest = json.load(handle)
    ids = [int(value) for value in manifest.get("ids", [])]
    vehicle_ids = [int(value) for value in manifest.get("vehicle_ids", [])]
    personnel_ids = [int(value) for value in manifest.get("personnel_ids", [])]
    if not ids and not vehicle_ids and not personnel_ids:
        os.remove(MANIFEST)
        print("Demo manifest was empty; removed it.")
        return

    with application.app.app_context():
        connection = sqlite3.connect(application.app.config["DATABASE"])
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        with connection:
            removed = 0
            if ids:
                placeholders = ",".join("?" for _ in ids)
                removed = connection.execute(
                    f"DELETE FROM trips WHERE id IN ({placeholders})", ids
                ).rowcount
            removed_vehicles = 0
            if vehicle_ids:
                placeholders = ",".join("?" for _ in vehicle_ids)
                removed_vehicles = connection.execute(
                    f"DELETE FROM vehicles WHERE id IN ({placeholders}) "
                    "AND id NOT IN (SELECT vehicle_id FROM trips WHERE vehicle_id IS NOT NULL)",
                    vehicle_ids,
                ).rowcount
            removed_personnel = 0
            if personnel_ids:
                placeholders = ",".join("?" for _ in personnel_ids)
                removed_personnel = connection.execute(
                    f"DELETE FROM personnel WHERE id IN ({placeholders}) "
                    "AND id NOT IN (SELECT personnel_id FROM trip_crew)",
                    personnel_ids,
                ).rowcount
        connection.close()

    os.remove(MANIFEST)
    print(
        f"Removed {removed} demo trips, {removed_vehicles} vehicles and "
        f"{removed_personnel} personnel. Real records were left untouched."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clear", action="store_true", help="remove only the seeded demo records")
    parser.add_argument(
        "--resources-only",
        action="store_true",
        help="add missing demo vehicle and personnel records without touching trips",
    )
    arguments = parser.parse_args()
    if arguments.clear:
        clear()
    elif arguments.resources_only:
        seed_only_resources()
    else:
        seed()
