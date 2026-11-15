# Security policy

## Reporting a problem

Do not open a public issue with reproduction steps for a security problem.

Use GitHub's private reporting for this repository (Security → Advisories → *Report a
vulnerability*), or contact the maintainer through the address on their GitHub profile.

Please include:

- What the issue is and which part of the system it affects.
- How to reproduce it, with secrets and real coordinates replaced.
- What an attacker could do with it, as far as you can tell.

There is no bug bounty and no response-time commitment. This is a development project
maintained by one person; expect an acknowledgement rather than a service-level
agreement.

## Supported versions

Only the current `main` branch is maintained. There are no released versions.

## Known limitations that are not vulnerabilities

These are documented properties of the current implementation, not reports:

- Location sharing is foreground-only by design, and there is no background task or
  permission for one.
- GPS spoofing is detected heuristically. A holder of a valid unit token can report
  plausible forged positions until that token stops resolving to a vehicle.
- The development server (`python app.py`) is Flask's debug server over plain HTTP on
  loopback. Exposing it is a deployment mistake, not a supported configuration.
- The default `SECRET_KEY` is public in this repository. The app warns at startup when
  it is in use; set a random value before anyone else can reach the server.
- Route deviation is line-of-sight to the stored polyline, not map matching.

Details: `docs/security.md` and `docs/known-limitations.md`.
