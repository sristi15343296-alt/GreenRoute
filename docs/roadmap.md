# Development roadmap

What is finished, what is deliberately not started, and what would be worth doing
next. Phase D is **not authorized and not begun**: nothing in the repository
implements it, and no dependency, migration or endpoint exists for it.

---

## Completed

### Phase A — backend foundation and routing
Server-side routing through an OSRM adapter, route cache and route history, the driver
API with ownership and idempotent transitions, stored geometry consumed by the phone,
demo seeding. See `docs/phase-a.md`.

### Phase B — authentication and the emergency lifecycle
Administrator accounts with scrypt hashes, server-side sessions, CSRF, login
throttling, four roles mapped to fifteen permissions enforced per endpoint, one
lifecycle state machine with atomic transitions, and an append-only audit log. See
`docs/phase-b.md`.

### Phase C — live GPS tracking and telemetry
Foreground location on the phone, an authenticated ingestion API, GPS validation and
quality labelling, duplicate and out-of-order protection, a latest-position table
separate from a bounded history, LIVE/DELAYED/STALE/LOST health, route deviation with
controlled recalculation, an admin live overlay, retention, and the correction of the
Phase B watchdog so that losing GPS never ends an emergency. See `docs/phase-c.md`.

---

## Not started (and not authorized)

These are Phase D and Phase E topics. They are listed so the boundary is explicit, not
as a plan that has been agreed:

- Proximity alerts to ordinary drivers within 500 metres.
- Ordinary driver discovery and a public driver client.
- Push notifications to drivers.
- Traffic-signal pre-emption of any kind.
- Multi-agency tenancy.

No table, endpoint, migration or dependency for any of the above exists.

---

## Engineering work worth doing before that

Ordered by what would hurt least to fix early. None of it is implemented.

1. **Tell the crew's phone about a recalculated route.** Today the admin map follows a
   new route while the phone keeps the old one. A route version on the assignment,
   with the phone reloading when it changes, closes the gap with no new transport.
2. **Background location as an explicit, documented feature.** `expo-task-manager`
   plus `startLocationUpdatesAsync`, an Android foreground service, and a clear
   permission story. It is a product decision as much as an engineering one: it
   changes what operators can assume about a parked crew.
3. **Scheduled maintenance.** The sweep endpoint exists but nothing calls it. A cron
   entry outside the app (or a small scheduler in deployment) is enough.
4. **A database with concurrent writers before 1,000 active vehicles.** Only the
   storage functions in `db.py` would move; the event-id contract, payloads and client
   stay as they are.
5. **Rate limiting and token rotation for units.** A per-unit request budget and a
   token that is not derived from the call sign.
6. **CI.** A workflow that runs the backend suite and the phone's `tsc`/`jest` exists
   in `.github/workflows/checks.yml` but has not been executed on GitHub.
7. **A licence.** MIT or Apache-2.0 are the obvious candidates; neither has been
   chosen, so the repository currently grants no reuse rights.
8. **Push transport, if polling ever stops being enough.** The payload is already
   push-shaped (`{event_id, positions[]}`); see `docs/phase-c.md` §11.
