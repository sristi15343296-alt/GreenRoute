"""Shared test helpers for the authenticated admin surface.

Phase B put authentication in front of every administrative route, so a test
client has to sign in like a person would. These helpers do that once, in a way
that keeps the existing tests readable:

    self.client = support.signed_in_client(app_module.app)

The returned client is an ordinary Flask test client that adds the session's
CSRF header to state-changing requests, exactly as `static/js/app.js` does.
"""

from __future__ import annotations

import re

import admin_store as accounts
import auth
import unit_tokens
from flask.testing import FlaskClient

TEST_PASSWORD = "green-route-test-password"

_DEFAULT_EMAILS = {
    "SUPER_ADMIN": "super@test.local",
    "ADMIN": "admin@test.local",
    "EMERGENCY_OPERATOR": "operator@test.local",
    "VIEWER": "viewer@test.local",
}


class AuthClient(FlaskClient):
    """A test client that behaves like the signed-in admin website."""

    csrf_token: str | None = None

    def open(self, *args, **kwargs):
        method = kwargs.get("method")
        if method is None and args:
            method = args[0]
        if (
            isinstance(method, str)
            and method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
            and self.csrf_token
        ):
            headers = dict(kwargs.get("headers") or {})
            headers.setdefault("X-CSRF-Token", self.csrf_token)
            kwargs["headers"] = headers
        return super().open(*args, **kwargs)


def make_admin(role="SUPER_ADMIN", email=None, password=TEST_PASSWORD, status="active"):
    """Create an administrator row for a test and return (email, password)."""
    email = (email or _DEFAULT_EMAILS.get(role, f"{role.lower()}@test.local")).lower()
    if accounts.admin_get_by_email(email) is None:
        accounts.admin_create(
            email=email,
            name=f"{role.title()} (test)",
            role=role,
            password_hash=auth.hash_password(password),
            status=status,
        )
    return email, password


def sign_in(client, email, password=TEST_PASSWORD):
    """Perform the real sign-in flow, including the login form's CSRF token."""
    page = client.get("/login")
    match = re.search(r'name="csrf_token" value="([^"]+)"', page.get_data(as_text=True))
    assert match, "the sign-in page must carry a CSRF token"
    response = client.post(
        "/login",
        data={"email": email, "password": password, "csrf_token": match.group(1)},
    )
    if response.status_code == 302:
        info = client.get("/api/admin/session").get_json() or {}
        client.csrf_token = info.get("csrf_token")
    return response


def signed_in_client(app, role="SUPER_ADMIN", email=None, password=TEST_PASSWORD):
    """A test client already signed in with the given role."""
    app.test_client_class = AuthClient
    client = app.test_client()
    account_email, account_password = make_admin(role=role, email=email, password=password)
    sign_in(client, account_email, account_password)
    return client


def anonymous_client(app):
    return app.test_client()


def issue_unit_token(vehicle_id, token=None):
    """Issue a unit credential and return the plaintext, or use a fixed one.

    The driver API only accepts a credential whose digest is stored against the
    vehicle, so a test that needs to authenticate has to issue one first — the
    same call the Resources screen makes.
    """
    if token is None:
        token = unit_tokens.issue(vehicle_id)
    else:
        assert unit_tokens.store.set_vehicle_token(vehicle_id, unit_tokens.digest(token))
    assert token, "the vehicle must exist to carry a unit code"
    return token
