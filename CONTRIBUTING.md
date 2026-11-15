# Contributing

GREEN ROUTE is one product in one repository: the Flask server and dispatcher console in
`backend/`, the Expo crew app in `driver-app/`, and the reference material in `docs/`.

Keep changes focused. This codebase values a small diff that preserves the existing
contracts more than a rewrite that improves them.

## Before you change anything

1. Read `README.md`, then the document for the area: `docs/architecture.md`,
   `docs/api-reference.md`, `docs/database.md`, `docs/security.md`.
2. Create a branch from `main` with a short descriptive name.
3. Run the suite for the component you are about to touch, so a failure later is yours
   and not the baseline.

## Rules the project depends on

- **Do not commit secrets or operational data.** No `.env`, no database file, no
  `backend/instance/`, no unit tokens, no real coordinates.
- **Do not present a straight line as a road route**, or a stale position as a live one.
  Both are enforced in the interface and both are easy to undo by accident.
- **Do not change lifecycle semantics without saying so.** A response is closed by a
  person or by the twelve-hour ceiling. Losing GPS never closes one.
- **Keep endpoints in `app.ENDPOINT_PERMISSIONS`.** A route without an entry fails the
  RBAC test, which is deliberate.
- **Do not describe OSRM as traffic-aware.** It routes on a static road graph.
- **Preserve the driver API's contract.** The phone ships separately; a renamed field is
  a broken install. Additive changes belong in `docs/api-reference.md` in the same pull
  request.

## Style

- Python: four-space indentation, focused helpers, standard library where practical,
  bound SQL parameters only.
- JavaScript: no bundler, no framework. One file per page in `backend/static/js/`.
- TypeScript: keep the pure rules in `src/outbox.ts` and `src/location.ts`
  dependency-injected so they stay testable without a device.
- Comments explain *why*. A comment that restates the code is noise.
- Reuse the existing design tokens rather than introducing a second visual system.

## Verification before a pull request

```bash
# Backend
cd backend
python -m unittest discover -s tests
for file in static/js/*.js; do node --check "$file"; done

# Crew app (if touched)
cd ../driver-app
npx tsc --noEmit
npx jest
```

CI runs the same commands in one workflow (`.github/workflows/checks.yml`). Report what
you ran and what you did not. "I did not open the page in a browser" is a useful
sentence; a claim you did is not.

## Commits and pull requests

- One concern per commit, present tense, imperative: `Add telemetry retention sweep`.
- The pull request template asks for the checks you ran and whether the change touches
  a position, a route or a lifecycle transition.
- Do not force-push a branch others may have based work on, and do not rewrite history
  that is already on `main`.

## Security

Report security problems privately, per `.github/SECURITY.md`, not in a public issue.
