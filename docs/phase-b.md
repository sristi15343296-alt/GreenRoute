# GREEN ROUTE — Phase B implementation report

Administrative security and the formal emergency lifecycle.

Status: **implemented and verified** in this workspace on 2026-11-15.
Companion documents: `docs/architecture.md` (system design),
`docs/internal/architecture-review-20261115T132249.html` (deepening opportunities).

This report separates what is **implemented and tested** from what is **planned**.
Anything untested is named as such.

---

## 1. Honest starting point

Before Phase B, verified in the repository:

- `app.py` exposed 25 administrative routes with **no authentication, no sessions,
  no roles and no CSRF protection**. Anyone able to reach the port could cancel a
  live response.
- `trips.status` was the only lifecycle state, guarded by hand-written `if`
  branches inside `db.update_status`; the phone and the admin each kept their own
  copy of the transition vocabulary.
- `update_status` read the row, then wrote it: a check-then-write race between two
  operators was possible.
- `trip_events` recorded *what* happened but not *who* did it.
- The driver API authenticated with a call-sign token and enforced unit ownership
  (`db.get_trip_for_unit`); that behaviour had to survive untouched.

Phase B changes all of that without renaming a single existing route or trip
status.

---

## 2. What was built

| Area | Files | State |
|---|---|---|
| Admin authentication, sessions, CSRF, throttling | `auth.py` | implemented |
| Roles and permissions | `auth.py` | implemented |
| Administrator + session + audit persistence | `admin_store.py` | implemented |
| Emergency lifecycle state machine | `lifecycle.py` | implemented |
| Atomic, session-aware transitions | `db.update_status`, `db._sync_session` | implemented |
| Additive schema + backfill | `db._migrate` | implemented |
| Sign-in / sign-out routes | `blueprints/admin_auth.py` | implemented |
| Administrator management + audit screen | `blueprints/admin_users.py` | implemented |
| Route-level enforcement | `app.enforce_admin_access` + `ENDPOINT_PERMISSIONS` | implemented |
| Lifecycle-aware admin transitions | `app.api_update_trip`, `api_bulk_trips` | implemented |
| Watchdog endpoint | `POST /api/maintenance/expire-stale` | implemented (no producer yet) |
| Login page, administrators page, audit page | `templates/login.html`, `admin_users.html`, `audit.html` | implemented |
| Role-aware navigation, sign-out, CSRF meta | `templates/base.html`, `partials/sidebar.html` | implemented |
| CSRF on every existing admin form | `resources.html`, `settings.html`, `trip_create.html` | implemented |
| CSRF header + 401 handling in the browser | `static/js/app.js` | implemented |
| Tests | `tests/test_auth.py`, `test_rbac.py`, `test_lifecycle.py`, `support.py` | implemented |

Not implemented in Phase B (by instruction): GPS capture, telemetry ingestion, the
500 m alert engine, Socket.IO, push notifications, signal preemption.

---

## 3. Authentication architecture

```
browser ──POST /login (email, password, pre-auth CSRF)──► Flask
                                                            │
                        scrypt verify (Werkzeug) ◄───────────┤
                                                            │
                 admin_sessions row: token_hash = sha256(random token)
                                                            │
      Set-Cookie: gr_admin_session=<token>; HttpOnly; SameSite=Lax [; Secure]
                                                            │
        every later request ── cookie ──► sha256 ──► session row lookup
                                                         │
                                    admin row (role, status) ──► Actor
```

Decisions and why:

| Decision | Reason |
|---|---|
| **Server-side sessions**, cookie holds an opaque random token | Sign-out, suspension and password change take effect immediately; a leaked database cannot be replayed as a login because only the SHA-256 digest is stored |
| **scrypt password hashing** (Werkzeug default, per-password salt) | Established, memory-hard, already a dependency; no plaintext or reversible form is ever stored |
| **Two expiry clocks**: 8 h absolute, 45 min idle | A forgotten tab cannot stay privileged forever, and an abandoned session dies quickly |
| **CSRF token per session**, compared with `hmac.compare_digest` | A cross-site form cannot ride an existing session; the token is in a `<meta>` tag for `fetch` and a hidden field for forms |
| **Pre-auth CSRF** for the login form itself | Prevents login CSRF (signing a victim into the attacker's account) |
| **Sliding-window throttling in the database** | Survives process restarts; 5 failures per 15 min per e-mail, and the correct password is refused while the window is closed |
| **Same response for unknown and wrong-password accounts** | No account enumeration; unknown accounts spend comparable time in a dummy verify |
| **`Secure` cookie flag controlled by `GREENROUTE_HTTPS=1`** | Local development over http keeps working; production must set it (see §10) |

Known limitation: throttling is keyed on the submitted e-mail, not on a network
address. Username spraying across many addresses is only slowed, not stopped; a
production deployment should add a per-IP bucket at the reverse proxy.

---

## 4. Roles and permissions

| Permission | SUPER_ADMIN | ADMIN | EMERGENCY_OPERATOR | VIEWER |
|---|:--:|:--:|:--:|:--:|
| `dashboard.view` | ✓ | ✓ | ✓ | ✓ |
| `trips.view` | ✓ | ✓ | ✓ | ✓ |
| `analytics.view` | ✓ | ✓ | ✓ | ✓ |
| `resources.view` | ✓ | ✓ | ✓ | ✓ |
| `settings.view` | ✓ | ✓ | ✓ | ✓ |
| `trips.create` | ✓ | ✓ | ✓ | — |
| `trips.dispatch` (verify / activate / arrive / complete) | ✓ | ✓ | ✓ | — |
| `trips.cancel` | ✓ | ✓ | ✓ | — |
| `trips.assign` | ✓ | ✓ | ✓ | — |
| `route.resolve` (`/api/route`) | ✓ | ✓ | ✓ | — |
| `trips.export` | ✓ | ✓ | — | — |
| `resources.manage` | ✓ | ✓ | — | — |
| `audit.view` | ✓ | ✓ | — | — |
| `settings.manage` | ✓ | — | — | — |
| `admins.manage` | ✓ | — | — | — |

Guarantees:

- Roles are read from the `admins` table on **every request**; the cookie carries
  no role. A demotion or suspension applies to the next request.
- The mapping from endpoint to permission lives in one dict
  (`app.ENDPOINT_PERMISSIONS`), and `tests/test_rbac.py` fails if a registered
  administrative endpoint has no permission — a new route cannot slip past the
  guard silently.
- `GET /settings` needs `settings.view`; `POST /settings` needs `settings.manage`
  (method-aware check in `_required_permission`).
- Client-supplied roles, permissions or headers are ignored; the payload is never
  read for authority (tested).

Administrator invariants (enforced in `blueprints/admin_users.py`):

1. only `SUPER_ADMIN` may change administrators;
2. nobody may change their own role or suspend themselves;
3. the workspace must keep at least one active `SUPER_ADMIN`;
4. suspending or re-hashing an account revokes **all** its live sessions.

---

## 5. The emergency lifecycle

### 5.1 States

```
                 verify                depart                arrive
  CREATED ─────────────► VERIFIED ─────────────► ACTIVE ──────────► ON_SCENE
     │                     │                       │  │               │
     │ activate            │ cancel                │  │ cancel        │ complete
     └──────────┬──────────┴──────────┬────────────┘  │               ▼
                ▼                     ▼               │           COMPLETED
             ACTIVE              CANCELLED ◄──────────┘
                                     ▲
                        expire       │
                  ACTIVE ────────────┘  (watchdog only: no telemetry for 120 s)
                                     │
                                     └──► EXPIRED
```

`APPROACHING` is **not** a state. It is derived from position
(`lifecycle.derive_condition`): an `ACTIVE` session whose last fix is within
800 m of the destination reports `APPROACHING` for that moment. It is never
stored, never transitioned into, and never sent to the client as a status.

### 5.2 Transition table

| Action | From | To | Trip status | Actor | Permission | Preconditions / side effects |
|---|---|---|---|---|---|---|
| `verify` | CREATED | VERIFIED | scheduled → accepted | admin | `trips.dispatch` | records `verified_at`, `verified_by_*` |
| `activate` | CREATED | ACTIVE | scheduled → in_transit | admin | `trips.dispatch` | Phase A operator override; records activation + `expires_at` (12 h cap) |
| `depart` | VERIFIED | ACTIVE | accepted → in_transit | admin, unit | `trips.dispatch` (admin) | the activation event for Phase C/D |
| `arrive` | ACTIVE | ON_SCENE | in_transit → on_scene | admin, unit | `trips.dispatch` (admin) | — |
| `complete` | ACTIVE, ON_SCENE | COMPLETED | → completed | admin, unit | `trips.dispatch` (admin) | sets `closed_at`; stops alerts |
| `cancel` | CREATED…ON_SCENE | CANCELLED | → cancelled | admin, unit, system | `trips.cancel` | **reason required**; sets `close_reason` |
| `expire` | ACTIVE | EXPIRED | → cancelled | system only | — | watchdog; reason recorded |

Failure responses (JSON):

| Case | HTTP | `code` |
|---|---|---|
| unknown action | 400 | `bad_request` (existing) |
| response not found | 404 | `not_found` |
| action illegal from the current state | 409 | `invalid_transition` (+ `current_state`, `allowed`) |
| caller is not the right kind of actor / lacks permission | 403 | `permission_denied` |
| someone else moved it first | 409 | `conflict` (+ `current_state`, `expected_state`) |
| cancel without a reason | 422 | `reason_required` |
| replayed `client_event_id` | 200 | the current trip, unchanged |

### 5.3 One source of truth

`trips.status` remains the authoritative column: every existing reader (register,
map, analytics, CSV, driver API) already depends on it. `emergency_sessions.state`
is its **projection**, written in the same transaction by the same function
(`db._sync_session`). There is exactly one writer — `db.update_status` — so the
two cannot disagree; `lifecycle.apply` repairs a drifted projection rather than
refusing the action.

`emergency_transitions` records every move with actor kind, actor id, role and
reason. `trip_events` keeps its human-readable log, unchanged in format.

---

## 6. Database changes

All additive. No column, table or row was deleted or rewritten.

```sql
CREATE TABLE admins (id, email UNIQUE, name, password_hash, role CHECK(...),
                     status CHECK('active','suspended'), created_at, updated_at,
                     last_login_at);
CREATE TABLE admin_sessions (id, admin_id → admins, token_hash UNIQUE, csrf_token,
                             created_at, expires_at, last_seen_at, ip, user_agent,
                             revoked_at);
CREATE TABLE admin_login_attempts (id, email, ip, outcome, attempted_at);
CREATE TABLE audit_log (id, at, actor_id, actor_role, action, outcome, trip_id,
                        session_id, ip, detail_json);
CREATE TABLE emergency_sessions (id, trip_id UNIQUE → trips, state CHECK(...),
                                 activated_at, activated_by_kind, activated_by_id,
                                 verified_at, verified_by_kind, verified_by_id,
                                 closed_at, close_reason, expires_at, last_seen_at,
                                 created_at, updated_at);
CREATE TABLE emergency_transitions (id, session_id → emergency_sessions, trip_id,
                                    action, from_state, to_state, actor_kind,
                                    actor_id, actor_role, reason, created_at);

CREATE INDEX idx_admin_sessions_admin, idx_login_attempts (email, attempted_at),
             idx_audit_at, idx_audit_trip, idx_sessions_state, idx_transitions_session;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log → RAISE(ABORT);
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log → RAISE(ABORT);
```

Backfill (runs on every boot, idempotent):

```sql
INSERT OR IGNORE INTO emergency_sessions (trip_id, state, created_at, updated_at)
SELECT id, CASE status WHEN 'scheduled' THEN 'CREATED' ... END, created_at, created_at
FROM trips;
```

The audit-log triggers make immutability a property of the database: application
code — and a future bug in it — cannot rewrite history. `tests/test_lifecycle.py`
asserts that both an `UPDATE` and a `DELETE` are refused.

### Migration process (repeatable, safe)

1. `db.init_db()` runs `SCHEMA` (`CREATE TABLE IF NOT EXISTS`) then `_migrate`,
   which adds missing columns and creates the Phase B tables with
   `IF NOT EXISTS` and backfills sessions with `INSERT OR IGNORE`.
2. It runs automatically on every boot, including against an existing database.
3. Before applying it to the development database in this workspace, a backup was
   taken: `instance/backup-before-phase-b-20261115T140226.sqlite`.
4. Verified after migration: `trips 16 → 16`, `trip_events 57 → 57`,
   `vehicles 6 → 6`, `personnel 8 → 8`, `settings 14 → 14`,
   `emergency_routes 1 → 1`; 16 sessions backfilled
   (14 COMPLETED, 1 ACTIVE, 1 CREATED).

### Recovery / rollback

- **Undo the code, keep the data:** every change is additive, so restoring the
  previous commit leaves the new tables in place and unread. Nothing breaks.
- **Undo the data:** stop the server, restore
  `instance/backup-before-phase-b-<timestamp>.sqlite` over
  `instance/greenroute.sqlite`, restart. You lose only activity recorded after
  the backup.
- **Lost administrator password:** delete the row and boot again —
  `auth.bootstrap_admin` recreates the first super administrator and writes
  `instance/first-admin.txt` only when the table is empty.

---

## 7. API contracts

### 7.1 Unchanged (compatibility preserved)

These still work exactly as in Phase A; the driver API is entirely unaffected by
cookie auth and CSRF:

```
GET  /api/driver/unit
GET  /api/driver/assignments
GET  /api/driver/trips/<id>
POST /api/driver/trips/<id>/transition
POST /api/driver/trips/<id>/issue
POST /api/driver/trips/<id>/backup

PATCH /api/trips/<id>            {action: accept|start|depart|arrive|complete|cancel}
POST  /api/trips/bulk            {action: complete|cancel, ids: [...]}
GET   /api/trips, /api/trips/<id>
POST  /api/trips
GET   /trips/export.csv, /trips/<id>/export.csv, /analytics/export.*
```

Behavioural additions to those endpoints:

| Endpoint | Addition |
|---|---|
| `PATCH /api/trips/<id>` | Body may now include `expected_state` and `reason`. Both optional. Responses for conflicts now carry `code`, `current_state` and `allowed` alongside `error` (the `error` key is unchanged, so existing `error.message` handling still works). `cancel` requires a `reason`. |
| `POST /api/trips/bulk` | May include `reason`; each item is applied through the lifecycle and audited |
| `POST /api/route` | Now requires an authenticated session with `route.resolve` (it is an administrative endpoint; the phone receives geometry from `/api/driver/*`) |

### 7.2 New

```
GET  /login                         sign-in page (public)
POST /login                         email, password, csrf_token, next
POST /logout                        CSRF-protected; revokes the session
GET  /api/admin/session             {authenticated, name, email, role, permissions, csrf_token}

GET  /administrators                SUPER_ADMIN only
POST /administrators                create {email, name, role, password, password_confirm}
POST /administrators/<id>/role      {role}
POST /administrators/<id>/status    {status: active|suspended}
POST /administrators/<id>/password  {password, password_confirm}
GET  /administrators/audit          audit.view; ?trip_id=&limit=

POST /api/maintenance/expire-stale  runs the watchdog; {expired: [...], count: n}
```

### 7.3 Status codes the admin UI now has to understand

| Code | Meaning | UI behaviour |
|---|---|---|
| 401 `authentication_required` | session missing or expired | `app.js` redirects to `/login?next=…` |
| 403 `permission_denied` | role not allowed | toast with the server message |
| 409 `conflict` | another operator moved the response | toast; page reload shows the new state |
| 409 `invalid_transition` | action illegal from the current state | toast |
| 422 `reason_required` | cancellation without a reason | the UI prompts before sending |
| 400 `csrf_failed` | stale form token | "reload the page" |

---

## 8. Concurrency and consistency

- **Atomic conditional write.** `db.update_status` performs
  `UPDATE trips SET status = ? ... WHERE id = ? AND status IN (<allowed>)` and
  checks `rowcount`. Two operators cancelling at the same moment produce one
  change and one `StaleTransition`, never a silent overwrite.
- **Optimistic concurrency for clients.** `expected_state` turns "I thought it was
  still CREATED" into a `409 conflict` that carries the authoritative state, so
  the UI can correct itself instead of overwriting.
- **One transaction per transition.** The status write, the timestamp column, the
  `trip_events` row, the `emergency_sessions` projection and the
  `emergency_transitions` row are written inside a single `with db:` block. A
  failure anywhere rolls all of them back — the response is never reported ACTIVE
  when the transaction failed. `tests/test_lifecycle.py` proves this by injecting a
  failure into the session writer and asserting the status did not change.
- **Idempotency.** Replayed `client_event_id`s are answered before validation and
  applied once (`client_events`, Phase A). Tested at both the driver and lifecycle
  levels.
- **Isolation level.** SQLite provides serialisable writes; the conditional
  `UPDATE` is the guard, not a read-then-write check.
- **What is *not* protected:** nothing prevents two operators from performing two
  *different legal* actions in quick succession (verify then cancel). That is a
  legitimate ordering, so the second action simply succeeds against the new state;
  the audit trail shows both, in order.

---

## 9. Audit logging

Every one of these writes an `audit_log` row:

| Action | Outcome values | Notes |
|---|---|---|
| `auth.login` | success, invalid, suspended, throttled | e-mail recorded, password never |
| `auth.logout` | success | — |
| `authorization.denied` | denied | includes the required permission and path |
| `emergency.verify` / `.activate` / `.depart` / `.arrive` / `.complete` / `.cancel` / `.expire` | success | from/to state, actor kind, reason |
| `emergency.expire_sweep` | success | ids closed by the watchdog |
| `admin.create` / `.role_change` / `.status_change` / `.password_reset` | success | target id, from/to |

Recorded for each row: `at`, `actor_id`, `actor_role`, `action`, `outcome`,
`trip_id`, `session_id`, `ip`, `detail_json`. Never recorded: passwords, password
hashes, session tokens, CSRF tokens, driver positions.

Readable at `/administrators/audit` (`audit.view`, i.e. ADMIN and above), and
immutable at the database level. `admin_store.audit_record` never raises, so a
failed audit write cannot undo a committed operation — it returns `False` instead.

---

## 10. Security controls, as implemented

| Control | Where | Verified by |
|---|---|---|
| Backend authentication on every admin route | `app.enforce_admin_access` | `test_every_administrative_route_refuses_anonymous_callers` |
| Backend authorization per endpoint | `ENDPOINT_PERMISSIONS` + `_required_permission` | `test_rbac.py`, `test_every_registered_admin_endpoint_has_a_permission` |
| Password hashing (scrypt, salted) | `auth.hash_password` | `test_passwords_are_hashed_and_never_echoed` |
| Session token stored only as a digest | `admin_store.admin_session_create` | `test_session_cookie_is_httponly_lax_and_not_the_stored_secret` |
| HttpOnly, SameSite=Lax, optional Secure | `auth.set_session_cookie` | same test + `test_secure_flag_is_controlled_by_environment` |
| Absolute + idle expiration | `auth._load_actor` | `test_idle_session_expires`, `test_absolute_session_expiry_is_enforced` |
| Server-side revocation on logout | `auth.end_session` | `test_logout_revokes_the_session_server_side` |
| Suspension ends live sessions | `admin_users.change_status` | `test_account_suspension_revokes_sessions_immediately` |
| Brute-force throttling | `auth.throttle_remaining` | `test_five_failures_lock_the_account_for_the_window`, `test_throttle_expires_after_the_window` |
| CSRF on every mutating admin request | `app.enforce_admin_access`, `auth.csrf_ok` | `test_state_changing_request_without_csrf_is_refused`, `test_form_post_without_csrf_field_is_refused` |
| Role tampering ignored | guard reads the database, not the payload | `test_role_supplied_by_the_client_is_ignored` |
| IDOR on administrators | `administrators/<id>` resolves the target server-side; self-changes refused | `test_administrators_cannot_change_their_own_account` |
| Last-super-admin protection | `active_super_admin_count()` | `test_last_active_super_admin_is_protected` |
| Immutable audit | SQLite triggers | `test_audit_log_cannot_be_edited_or_deleted` |
| Cross-unit isolation (phone) | `db.get_trip_for_unit` | `test_the_phone_still_cannot_touch_another_units_response` |

Production checklist (not yet done, and deliberately not done here):

- [ ] `GREENROUTE_HTTPS=1` and a real `SECRET_KEY` from the environment
- [ ] Serve behind a WSGI server (waitress/gunicorn) over TLS, not `flask run`
- [ ] Per-IP throttling at the proxy
- [ ] Rotate the bootstrap administrator password (it is written to
      `instance/first-admin.txt`, which is gitignored)
- [ ] Backups of `instance/greenroute.sqlite`

---

## 11. Test coverage

| Suite | Tests | Command |
|---|---|---|
| Backend (all) | **121** | `./.venv/Scripts/python.exe -m unittest discover -s tests` |
| ├ `test_auth.py` (new) | 27 | authentication, sessions, throttling, CSRF, audit |
| ├ `test_rbac.py` (new) | 11 | role matrix, tampering, invariants, permission coverage |
| ├ `test_lifecycle.py` (new) | 28 | state machine, concurrency, idempotency, watchdog, audit |
| ├ `test_driver_api.py` | 17 | Phase A driver contract, still green |
| ├ `test_routing.py` | 9 | Phase A routing, now authenticated |
| ├ `test_trip_status.py` | 9 | Phase A lifecycle screens/CSV |
| └ `test_geocoding.py` | 20 | Phase A geocoding |
| Phone | **78** | `npx jest` (and `npx tsc --noEmit` clean) |

Phase A regression checks specifically re-run: routing and route caching
(`test_routing.py`), route history (`emergency_routes` supersede test), driver
ownership and idempotent transitions (`test_driver_api.py`,
`test_lifecycle.py::test_the_crew_phone_still_drives_the_same_lifecycle`).

Browser verification (headless Chromium against the running dev server, with a
temporary account that was deleted afterwards):

| Step | Result |
|---|---|
| `GET /` while signed out | redirected to `/login?next=/` |
| sign in with valid credentials | dashboard rendered, all existing data visible |
| navigation | Audit log and Administrators links present for SUPER_ADMIN; identity shown in the sidebar |
| `/administrators` | rendered; all 8 forms carried a CSRF token |
| `/administrators/audit` | rendered; showed the sign-in row |
| `/trips/16` → "En route" | `PATCH /api/trips/16` → 200; session moved CREATED → ACTIVE; audit row `emergency.activate` with actor id and role |
| sign out | landed on `/login`; a follow-up request to `/administrators` was redirected |
| browser console | no errors (only pre-existing MapLibre sprite warnings) |

Not verified: any physical phone, iOS/Android push, real GPS, and behaviour behind
a TLS reverse proxy.

---

## 12. Known limitations

1. **Throttling is per e-mail**, not per network address (see §3).
2. **The session cookie is a bearer credential.** There is no device binding, MFA
   or step-up authentication; HTTPS is assumed.
3. **No administrator self-service password change screen.** A SUPER_ADMIN resets
   other accounts from `/administrators`; the bootstrap account's own password
   must be rotated by a super administrator created for that purpose (or by
   resetting the database admin row through `auth.hash_password`). Adding a
   "change my password" form is a small follow-up, not done here.
4. **No pagination on the audit screen** beyond a row-count selector (50–500).
5. **`ON_SCENE` still permits `complete`** and `CANCELLED`/`EXPIRED` are separate
   session states that both map to `trips.status = 'cancelled'` (Phase A had no
   separate column, and changing it would alter every existing report).
6. **The watchdog has no producer yet.** `POST /api/maintenance/expire-stale`
   exists, is tested with injected timestamps, and returns `[]` in production
   because nothing writes `session_last_seen` until Phase C.
7. **`/api/route` now requires a session.** Any external script that called it
   anonymously will receive `401`. This is intentional (it is an administrative
   endpoint) and is the only Phase A contract that changed.
8. **The admin UI's cancel flow now asks for a reason** (`window.prompt`). It is a
   deliberate friction, not an oversight, and it can be replaced by a proper modal
   later.

---

## 13. Extension points established for Phase C and D

Phase C (live GPS) and Phase D (500 m alerts) can be added **without touching the
state model**:

| Need | Provided now |
|---|---|
| Where telemetry may be accepted | `lifecycle.can_track(state)` — ACTIVE only |
| Where alerts may be generated | `lifecycle.can_alert(state)` — ACTIVE only |
| The activation event | `depart` / `activate` → session `activated_at`, `activated_by_*`, `emergency_transitions` row |
| Session liveness for the watchdog | `emergency_sessions.last_seen_at` + `db.touch_session_last_seen()` — Phase C writes it from the telemetry batch |
| Stale-session closure | `lifecycle.expire_stale()` + `POST /api/maintenance/expire-stale` |
| Route history per recalculation | `emergency_routes` + `superseded_by` (Phase A) |
| Where a fix would attach | `trip_id` on the session; no schema change needed to add `telemetry_fixes` |
| Stopping alerts on close | `COMPLETED`, `CANCELLED` and `EXPIRED` are all outside `can_alert`; `ALERT_GRACE_SECONDS = 120` is defined for the engine to expire outstanding alerts |
| Audit of a future engine action | `admin_store.audit_record(actor_role="SYSTEM", …)` |

Phase C prerequisites that are still open (unchanged by this phase):

1. hosting for Flask,
2. SQLite-now vs PostGIS-now,
3. Socket.IO vs polling for the admin map,
4. Expo Push with a development build vs in-app alerts only.

---

## 14. How to run

```bash
# from C:\Users\hp\Downloads\GreenRoute
./.venv/Scripts/python.exe -m flask --app app run --host 127.0.0.1 --port 5000 --no-reload

# first sign-in (generated on the first boot of a database with no admins)
#   email:    admin@greenroute.local
#   password: instance/first-admin.txt   <- gitignored, shown only here
```

Tests:

```bash
./.venv/Scripts/python.exe -m unittest discover -s tests          # 121 tests
cd "../driver-app"; npx tsc --noEmit; npx jest        # 78 tests
```

The crew phone needs no change: it authenticates with its bearer token and its six
endpoints behave exactly as before.
