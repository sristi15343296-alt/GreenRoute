# Security

This describes the controls that exist in the code, how they were verified, and what
is still open. It is a development-stage system: no deployment hardening, no
penetration test and no independent review has been performed.

---

## 1. Administrator authentication

| Control | Implementation |
|---|---|
| Password storage | scrypt with a per-password salt (`auth.hash_password` / `auth.verify_password`) |
| Sessions | Server-side rows in `admin_sessions`; the cookie carries a `secrets.token_urlsafe(32)` token and only its SHA-256 is stored |
| Cookie flags | `HttpOnly`, `SameSite=Lax`, and `Secure` when `GREENROUTE_HTTPS=1` |
| Expiry | 8 hours absolute, 45 minutes idle, both enforced on every request |
| Revocation | Sign-out sets `revoked_at`; a revoked or expired token is rejected immediately |
| CSRF | Per-session token, required in `X-CSRF-Token` on every state-changing request; the login form carries its own token |
| Throttling | Five failed attempts per e-mail or address in fifteen minutes pause sign-in for that pair |
| Bootstrap | Only when `admins` is empty. The generated password is written to the gitignored `instance/first-admin.txt` and printed once |

## 2. Authorisation

Four roles map to fifteen permissions in `auth.ROLE_PERMISSIONS`:

| Role | Count | Notes |
|---|---|---|
| SUPER_ADMIN | 15 | Includes `admins.manage` and `settings.manage` |
| ADMIN | 13 | Cannot manage administrators or workspace settings |
| EMERGENCY_OPERATOR | 10 | Dispatch, cancel, create, assign; no export, no audit |
| VIEWER | 5 | Read-only |

`app.ENDPOINT_PERMISSIONS` maps every administrative endpoint to its permission;
`enforce_admin_access` runs before the view. An endpoint registered without an entry
fails the test suite, so a new route cannot quietly become public. The driver API and
the sign-in routes are the only public endpoints.

Live telemetry reads (`/api/live/positions`, `/api/live/sessions/<id>/track`) require
`trips.view`, so VIEWER and above may read positions and nobody outside the admin
roles can.

## 3. Driver API

- A unit authenticates with `Authorization: Bearer token-<call sign slug>`; the
  server resolves it against the vehicle registry on every request.
- Identity is never taken from the request body. `trip_id` on telemetry is optional
  and, when present, must belong to the caller.
- Telemetry is accepted only for an ACTIVE emergency session.
- The driver API ignores cookies and CSRF entirely, so a browser session cannot be
  used to call it and a unit token cannot administer the site.

## 4. Telemetry privacy

| Concern | Control |
|---|---|
| Who can read positions | Admin roles with `trips.view`; a crew only ever reads its own response |
| Coordinates in logs | Request bodies are not logged; the audit log records counts and identifiers, not coordinates (asserted by a test) |
| Retention | `telemetry_fixes` pruned after `GREENROUTE_TELEMETRY_RETENTION_DAYS` (default 14) on every accepted batch |
| Deletion | Deleting a response cascades its fixes and latest position |
| Ordinary drivers | No public-driver tracking exists. There is no endpoint that returns any location to an entity other than the owning unit or an authenticated operator |

## 5. Telemetry integrity

| Attack | Mitigation | Residual risk |
|---|---|---|
| Forged coordinates from a valid token | Server-side range, null-point, accuracy, clock and speed plausibility checks | A stolen unit token allows plausible forgeries until it is rotated |
| Replay | `client_fix_id` uniqueness; a replayed fix with a new id but an old timestamp is refused as stale | — |
| Out-of-order overwrite | SQL `WHERE` clause on `vehicle_positions` keeps the newest position | — |
| Cross-unit impersonation | Token, not body, names the vehicle; `get_trip_for_unit` scopes the response | — |
| GPS spoofing | Heuristic only: impossible jumps and implied speeds are rejected, `source` is labelled, `quality` is surfaced to operators | **Not detected reliably.** The UI never presents a position as verified truth |

Operators can watch for a `poor` quality label, `manual`/`simulated` sources in a live
response, unexplained gaps followed by bursts, or a position outside the response's
area. None of these is proof of tampering.

## 6. Transport and deployment

- Development runs over plain HTTP on loopback. `python app.py` is Flask's debug
  server: never expose it.
- For anything reachable, run a real WSGI server behind TLS, set `SECRET_KEY` to a
  random value, set `GREENROUTE_HTTPS=1`, and keep `debug=False`.
- The app prints a startup warning when it is using the built-in development
  `SECRET_KEY`, which is public in this repository.
- No CORS headers are set, no third-party scripts are loaded from the admin pages
  except the map libraries from public CDNs, and those see only tile coordinates.

## 7. Audit

`audit_log` records sign-ins, refusals, every lifecycle transition, administrator
changes and the watchdog sweep, with actor id, role, IP and a JSON detail blob.
Database triggers reject `UPDATE` and `DELETE` on the table, so the trail can only
grow. `emergency_transitions` records the same lifecycle moves keyed by session.

## 8. Known gaps

1. **No unit token rotation.** A token is derived from the call sign; changing it
   means renaming the vehicle. Acceptable for a controlled fleet, not for a public
   one.
2. **No rate limiting on the driver API.** A holder of a valid token can post as fast
   as it likes; the server rejects bad fixes but does not throttle.
3. **No dependency vulnerability scanning in CI.** Versions are pinned in
   `requirements.txt` and `package-lock.json`, and both should be reviewed
   periodically.
4. **No TLS in the repository.** Termination is a deployment concern.
5. **Location is foreground-only.** That is a privacy property as much as a
   limitation: there is no background tracking and no permission for one.
6. **Spoofing detection is heuristic**, as stated above.
7. **The throttle key includes the client address**, which is `127.0.0.1` for every
   user when the app sits behind a proxy that does not forward the real address.

If you find a security problem, follow `.github/SECURITY.md` rather than opening a
public issue with reproduction details.
