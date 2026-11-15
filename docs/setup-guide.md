# Local setup guide

Two applications in one repository, one machine, one database. This guide takes a
clean checkout to a working admin console and a phone that can sign in as an emergency
unit. Commands run from the repository root unless they say otherwise.

---

## 1. What you need

| Requirement | Notes |
|---|---|
| Python 3.11 or newer | The code uses `zoneinfo` and modern type syntax |
| Node.js 20 or newer and npm | For the Expo driver app and its tests |
| An Android device or emulator, or iOS Simulator | For the phone app; the admin console does not need it |
| Internet access | Map tiles, OSRM, Nominatim and Photon are public services |

Nothing else. No database server, no container runtime, no broker.

---

## 2. Backend and admin console

```bash
cd backend
python -m venv .venv
```

Activate it:

```bash
# Git Bash / macOS / Linux
source .venv/bin/activate
# PowerShell
.\.venv\Scripts\Activate.ps1
```

Install dependencies and start the server:

```bash
python -m pip install -r requirements.txt
python app.py
```

`python app.py` binds `127.0.0.1:5000` and turns on Flask's debug reloader. The
equivalent explicit command is:

```bash
flask --app app run --host 127.0.0.1 --port 5000 --no-reload
```

The database is created on first boot at `instance/greenroute.sqlite`, including
every table, index and the newest column migrations. There is no separate migrate
step: `db.init_db()` is idempotent and runs on every start.

### The first administrator

If the `admins` table is empty, boot creates one:

- E-mail `admin@greenroute.local` (overridable with
  `GREENROUTE_BOOTSTRAP_ADMIN_EMAIL`).
- A random 24-character password, printed once to the console and written to
  `instance/first-admin.txt`.

`instance/` is gitignored, so neither the password nor the database reaches the
repository. Sign in at `http://127.0.0.1:5000/login`, then:

1. Open **Administrators** and create your own account with `SUPER_ADMIN`.
2. Sign out, sign in with the new account.
3. Change or disable the bootstrap account — its password is on disk in plain text.

To choose the bootstrap credentials instead, set both variables before the first
boot:

```bash
export GREENROUTE_BOOTSTRAP_ADMIN_EMAIL=ops@example.org
export GREENROUTE_BOOTSTRAP_ADMIN_PASSWORD='a long passphrase you keep'
python app.py
```

### Configuration

Copy `.env.example` to `.env` if your shell or process manager loads environment
files (the application itself reads the process environment only). The values that
matter locally:

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | development key | Signs session cookies. Set it before anyone else can reach the server; the app warns at startup when it is using the default. |
| `GREENROUTE_DB` | `instance/greenroute.sqlite` | SQLite file location |
| `GREENROUTE_PORT` | `5000` | Development port |
| `GREENROUTE_HTTPS` | `0` | Set to `1` to mark the session cookie `Secure` |
| `GREENROUTE_ROUTE_URL` | public OSRM | Routing endpoint; point it at your own OSRM for sustained use |
| `GREENROUTE_GEOCODING_EMAIL` | empty | Contact address for Nominatim's usage policy |
| `GREENROUTE_TELEMETRY_RETENTION_DAYS` | `14` | GPS history retention |
| `GREENROUTE_DEVIATION_M` | `150` | Off-route distance that counts |
| `GREENROUTE_RECALC_COOLDOWN_S` | `90` | Minimum gap between recalculations |

Every other supported variable is documented inline in `.env.example`.

### Demo data

Optional, and worth having for a first look:

```bash
python seed_demo.py                  # responses, vehicles, personnel
python seed_demo.py --clear          # removes only what the script created
python seed_driver_demo.py --unit MEDIC-12
```

`seed_demo.py` writes the ids it created to `instance/demo-seed.json` so `--clear`
never removes operator-entered records. `seed_driver_demo.py` assigns one open
response to a unit and stores its route, then prints the unit token to type into the
phone.

---

## 3. Driver application

```bash
cd driver-app
npm install
cp .env.example .env
```

Set `EXPO_PUBLIC_API_BASE` in `.env` to the backend that should serve the app. The
value is inlined at bundle time, so restart `expo start` after changing it.

**Android emulator** — the emulator cannot reach the host's `127.0.0.1`, so forward
the port instead of using the LAN address:

```bash
adb reverse tcp:5000 tcp:5000
# .env
EXPO_PUBLIC_API_BASE=http://127.0.0.1:5000
```

**Physical phone on the same Wi-Fi** — use the laptop's LAN address and make sure the
Flask server is reachable from the network. `python app.py` binds loopback only, so
either start it on all interfaces (only on a trusted network) or use a reverse proxy:

```bash
flask --app app run --host 0.0.0.0 --port 5000
# .env
EXPO_PUBLIC_API_BASE=http://192.168.1.23:5000
```

Then:

```bash
npx expo start
```

Press `a` for an Android device or emulator. `expo-location` is a native module: Expo
Go can load it, but if you use a custom development build you must rebuild after
`npm install` (`npx expo run:android`). Restart `expo start` after editing `.env`.

The app has a mock backend for frontend work, independent of Flask:

```bash
npm run mock        # http://127.0.0.1:5055
npm run mock:lan    # same, bound to the LAN for a physical phone
```

Pair a phone with a unit token. The token is `token-` followed by the call sign
lowercased with punctuation removed: `MEDIC-12` → `token-medic12`. The app shows the
unit's open response, its timeline, and the transition buttons the server allows.

### Location sharing

While a response is `in_transit`, the app asks for foreground location permission and
reports a fix every 10 seconds or 25 metres. The Home screen carries a badge that says
whether sharing is active, paused, buffered, blocked or stopped.

Tracking is foreground-only. A backgrounded or force-quit app stops reporting; the
admin map shows the unit as STALE or LOST and the response itself is untouched. There
is no background task and no permission for one.

---

## 4. Checking the installation

```bash
cd backend
.venv/Scripts/python.exe -m unittest discover -s tests      # or: python -m unittest ...
```

```bash
cd driver-app
npx tsc --noEmit
npx jest
```

A simulated vehicle, without a phone:

```bash
TOKEN=token-medic12   # the unit that owns an in_transit response
curl -X POST http://127.0.0.1:5000/api/driver/telemetry \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"fixes\":[{\"lat\":19.1170,\"lng\":72.8680,\"accuracy_m\":8,
       \"device_time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"client_fix_id\":\"MEDIC-12:1\",\"sequence\":1}]}"
```

Sign in and open `/fleet-map`: the unit appears with a LIVE badge within five seconds.

---

## 5. Common problems

| Symptom | Cause and fix |
|---|---|
| `ModuleNotFoundError: flask` | The virtual environment is not active, or dependencies were installed into a different interpreter. |
| Phone shows "Dispatch address is not configured" | `EXPO_PUBLIC_API_BASE` is empty, or `expo start` was not restarted after editing `.env`. |
| Phone cannot reach the backend | `python app.py` binds `127.0.0.1`; use `adb reverse` for an emulator or `--host 0.0.0.0` plus the LAN address for a phone. |
| `401` from `/api/driver/*` | The token does not match a vehicle call sign. `MEDIC-12` is `token-medic12`. |
| Sign-in fails after several attempts | Throttling: five failures in fifteen minutes pause sign-in for that e-mail and address. |
| Map is blank | Tiles come from OpenFreeMap over the internet; check the browser console for blocked requests. |
| Route preview says "provider unavailable" | OSRM did not answer. The app keeps the previous route and marks route quality degraded. |
| `409 session_not_trackable` from telemetry | The response is not `in_transit`, so the emergency session is not ACTIVE. |
| Location badge says "Location blocked" | Permission was denied. Enable it in the OS settings for the app, then reopen Home. |
