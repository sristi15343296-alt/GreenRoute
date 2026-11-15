"""Server-side HTTP surface for GREEN ROUTE.

The admin screens were the only client until now; the crew phone spoke to a
mock. This package gives the phone a real backend on the same database, so one
lifecycle serves both.

Blueprints are deliberately thin. They translate HTTP to calls on `db` and
`routing`, and hold the authorization rules — nothing else. That keeps the
seams: views never build SQL, and persistence never reads a request.
"""
