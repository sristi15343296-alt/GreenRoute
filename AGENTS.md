# AGENTS.md

Guidance for coding agents (and new contributors) working in this repository. It states
what the project is, how to verify a change, and which invariants must not be broken.
Human-facing guidance lives in `CONTRIBUTING.md`.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Flask 3 application: JSON API, Jinja admin console, SQLite schema (no ORM) |
| `driver-app/` | Expo / React Native (TypeScript) application used by the crew |
| `docs/` | Architecture, API reference, database, security, phase notes |
| `tools/` | Documentation build helper (internal, not part of the product) |

## Verify a change

```bash
# Backend
cd backend && .venv/Scripts/python.exe -m unittest discover -s tests   # 163 tests
for file in static/js/*.js; do node --check "$file"; done

# Driver app
cd driver-app && npx tsc --noEmit && npx jest                          # 97 tests
```

Run the suite for the component you touched, not both by default. CI runs the same
commands (`.github/workflows/checks.yml`).

## Invariants

- **Lifecycle.** A response is closed by a person or by the twelve-hour activation
  ceiling. Losing GPS never closes one. Do not add automatic closures.
- **Driver API contract.** The phone ships separately; a renamed field is a broken
  install. Additive changes only, and document them in `docs/api-reference.md`.
- **Health labels.** LIVE / DELAYED / STALE / LOST / UNKNOWN are computed on the server
  from receipt time. Never render a position as live when its health says otherwise.
- **Geometry.** Provider road geometry or nothing. A straight line between two points is
  never presented as a route.
- **Permissions.** Every endpoint has an entry in `app.ENDPOINT_PERMISSIONS`; an
  unregistered route fails the RBAC test on purpose.
- **Ordering.** Position reads depend on SQL ordering, not Python sorting. Keep the
  `WHERE` predicates in `db.py` intact.
- **Phase gate.** Phase D (proximity alerts, ordinary-driver tracking, push
  notifications, traffic-signal control) is not authorized. Do not add code, tables,
  endpoints or dependencies for it.

## Never

- Commit `.env` files, `backend/instance/`, unit tokens, database backups or real
  coordinates.
- Weaken, skip or delete a test to make a change pass.
- Weaken authentication, CSRF or role checks to make a feature work.
- Rewrite published history or force-push `main`.

## Style

Python: 4 spaces, standard library first, bound SQL parameters only. JavaScript: no
framework and no bundler, one file per page in `backend/static/js/`. TypeScript: keep
rules in plain modules (`outbox.ts`, `location.ts`) that take storage, transport and a
clock by injection so they test without a device. Comments explain why, not what.
