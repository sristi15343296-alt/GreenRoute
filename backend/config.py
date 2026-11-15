"""Runtime configuration that must fail loudly rather than silently.

Two settings decide whether this process is a development server or something
that other people can reach:

* `GREENROUTE_ENV` — `development` (default) or `production`.
* `SECRET_KEY` — signs administrator session cookies. If it is guessable, an
  attacker can forge a session for any account, so production must supply one.

In development a missing key falls back to the value that is already public in
this repository: that is safe only because the server is bound to loopback, and
the application says so on every start. In production the same fallback is a
vulnerability, so startup raises instead. Refusing to boot is deliberate — a
server that starts with a known key is worse than one that does not start.
"""

from __future__ import annotations

import os

#: The development fallback. Public by design; never valid in production.
DEV_SECRET_KEY = "greenroute-local-development"

#: Shortest secret accepted in production. 32 characters of `token_urlsafe` is
#: already 192 bits; the floor only rejects obviously weak pasted values.
MIN_PRODUCTION_SECRET_LENGTH = 32

DEVELOPMENT = "development"
PRODUCTION = "production"


class ConfigurationError(RuntimeError):
    """Raised when the environment cannot be served safely."""


def environment(environ=None) -> str:
    """The declared environment, normalised. Unknown values are an error."""
    raw = ((environ if environ is not None else os.environ).get("GREENROUTE_ENV") or "").strip().lower()
    if raw in {"", DEVELOPMENT, "dev"}:
        return DEVELOPMENT
    if raw in {PRODUCTION, "prod"}:
        return PRODUCTION
    raise ConfigurationError(
        f"GREENROUTE_ENV={raw!r} is not understood. Use 'development' or 'production'."
    )


def is_production(environ=None) -> bool:
    return environment(environ) == PRODUCTION


def resolve_secret_key(environ=None):
    """Return `(secret_key, used_development_fallback)`.

    Raises `ConfigurationError` in production when the key is missing, is the
    public development value, or is too short to be worth calling a secret.
    """
    environ = environ if environ is not None else os.environ
    secret = (environ.get("SECRET_KEY") or "").strip()
    if environment(environ) == PRODUCTION:
        if not secret:
            raise ConfigurationError(
                "GREENROUTE_ENV=production requires SECRET_KEY. Generate one with "
                "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"` "
                "and set it in the server's environment."
            )
        if secret == DEV_SECRET_KEY:
            raise ConfigurationError(
                "SECRET_KEY is still the development value, which is public in this "
                "repository. Set a random SECRET_KEY before running in production."
            )
        if len(secret) < MIN_PRODUCTION_SECRET_LENGTH:
            raise ConfigurationError(
                f"SECRET_KEY must be at least {MIN_PRODUCTION_SECRET_LENGTH} characters "
                "in production."
            )
        return secret, False
    if not secret or secret == DEV_SECRET_KEY:
        return DEV_SECRET_KEY, True
    return secret, False
