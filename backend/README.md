# GREEN ROUTE — backend and operations console

The Flask application that serves the administrative console, the driver API used by
the crew app, and all persistence. There is no separate build step and no ORM.

Full product documentation, architecture and setup: [`../README.md`](../README.md) and
[`../docs/`](../docs).

## Run

```bash
cd backend
python -m venv .venv                       # once
source .venv/bin/activate                  # Windows: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py                              # http://127.0.0.1:5000
```

With `FLASK_APP=app`, the equivalent explicit form is
`flask --app app run --host 127.0.0.1 --port 5000 --no-reload`.

On first start, with an empty `admins` table, the application creates
`admin@greenroute.local`, prints its password once and writes it to
`instance/first-admin.txt`. Sign in, create your own `SUPER_ADMIN` account under
**Administrators**, then disable the bootstrap account.

Optional demo data:

```bash
python seed_demo.py                             # responses, vehicles, personnel
python seed_driver_demo.py --unit MEDIC-12      # one open response for that unit
```

## Tests

```bash
python -m unittest discover -s tests            # 163 tests, ~80 s
```

The suite uses temporary SQLite databases and simulated coordinates; it never touches
`instance/greenroute.sqlite` and never contacts a real provider or vehicle.

## Layout

| Path | Contents |
|---|---|
| `app.py` | Application factory, screens, admin JSON API, access enforcement |
| `db.py` | Schema, idempotent migrations, all SQL |
| `auth.py`, `admin_store.py` | Accounts, sessions, roles, throttling, audit |
| `lifecycle.py` | Transition rules and atomic application |
| `telemetry.py` | GPS validation, health, deviation, recalculation |
| `routing.py`, `geocoding.py` | OSRM adapter with cache; Nominatim and Photon |
| `blueprints/` | Admin auth, administrator management, driver API, route API |
| `templates/`, `static/` | Jinja pages and assets for the console |
| `tests/` | Backend suite |

## Configuration

Environment variables and their defaults are listed in `.env.example` and in the root
README. `instance/` is gitignored: it holds the database, sessions, audit history, the
bootstrap password and vehicle positions.
