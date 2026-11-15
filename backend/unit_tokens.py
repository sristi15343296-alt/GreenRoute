"""Unit (emergency vehicle) credentials.

A crew member pairs a phone with a vehicle by typing the unit code their dispatch
desk issued. That code is a bearer credential: whoever holds it can act as that
unit, so it must not be derivable from anything public.

Policy
------
* **Random, not derived.** Codes are `gr_` plus 32 bytes of `secrets.token_urlsafe`.
  The old scheme — `token-` plus the slug of the call sign — was guessable by
  anyone who saw a vehicle on the map, and is now opt-in only (see below).
* **Stored as a digest.** The database keeps SHA-256 of the code, never the code
  itself. A SHA-256 digest is appropriate here because the input is 256 bits of
  entropy: there is nothing to brute-force, unlike a password.
* **Issued once.** `issue()` returns the plaintext code to the caller and stores
  only the digest, so the console shows it a single time.
* **Rotatable and revocable.** `issue()` again replaces the digest, which kills the
  old code instantly; `revoke()` clears it and the unit gets 401 until a new code
  is issued. Ownership checks elsewhere are unchanged: a code still maps to exactly
  one vehicle, and that vehicle only ever sees its own responses.

Existing demo units
-------------------
`backfill()` runs at startup: every vehicle without a credential gets one, and the
plaintext codes are written to `instance/unit-tokens.txt` (gitignored, local only)
so a demo fleet keeps working after the upgrade. The file is the only place the
codes exist in plaintext; delete it after handing them out.

`GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS=1` additionally accepts the old
`token-<call sign slug>` form. It exists so an existing development phone keeps
pairing during the transition, and it is off unless asked for.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets

import db as store

#: Prefix on every issued code. Not a secret: it makes a pasted credential
#: recognisable in a log or a support message.
TOKEN_PREFIX = "gr_"

#: Where backfilled plaintext codes are written, relative to `instance/`.
TOKENS_FILENAME = "unit-tokens.txt"

LEGACY_ENV = "GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS"

_TRUTHY = {"1", "true", "yes", "on"}


def digest(token: str) -> str:
    """SHA-256 of a credential. The database stores only this."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def legacy_allowed() -> bool:
    return (os.environ.get(LEGACY_ENV) or "").strip().lower() in _TRUTHY


def generate() -> tuple[str, str]:
    """A new code and its digest: `(token, token_hash)`."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    return token, digest(token)


def issue(vehicle_id: int) -> str | None:
    """Issue (or rotate) a unit's credential and return the plaintext once.

    Returns None when the vehicle does not exist. Any previously issued code for
    that vehicle stops working immediately, because its digest is overwritten.
    """
    token, token_hash = generate()
    if not store.set_vehicle_token(vehicle_id, token_hash):
        return None
    return token


def revoke(vehicle_id: int) -> bool:
    """Remove a unit's credential. The unit keeps its history, not its access."""
    return store.clear_vehicle_token(vehicle_id)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").strip().lower())


def _resolve_legacy(token: str):
    """The pre-hardening scheme: `token-<slug of call sign>`.

    Only reachable when `GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS` is set. It is kept
    for development fleets whose phones still type a call sign.
    """
    if not token.lower().startswith("token-"):
        return None
    wanted = _slug(token[6:])
    if not wanted:
        return None
    for vehicle in store.list_vehicles():
        if _slug(vehicle["call_sign"]) == wanted:
            return vehicle
    return None


def resolve(token: str):
    """The vehicle this credential belongs to, or None."""
    token = (token or "").strip()
    if not token:
        return None
    vehicle = store.vehicle_for_token_hash(digest(token))
    if vehicle is not None:
        return vehicle
    if legacy_allowed():
        return _resolve_legacy(token)
    return None


def backfill(instance_path: str) -> list[tuple[str, str]]:
    """Give every credential-less vehicle a code; return `(call_sign, token)`.

    Called once per startup. It only touches rows with no digest, so it never
    rotates a code an operator has already handed out.
    """
    pending = store.vehicles_without_token()
    if not pending:
        return []
    issued = []
    for vehicle in pending:
        token = issue(vehicle["id"])
        if token:
            issued.append((vehicle["call_sign"], token))
    _write_tokens_file(instance_path, issued)
    return issued


def _write_tokens_file(instance_path: str, issued: list[tuple[str, str]]) -> None:
    if not issued:
        return
    os.makedirs(instance_path, exist_ok=True)
    path = os.path.join(instance_path, TOKENS_FILENAME)
    lines = [
        "# Unit codes issued at startup. Local file: do not commit or share it.",
        "# Hand each code to its crew, then delete this file.",
    ]
    lines += [f"{call_sign}\t{token}" for call_sign, token in issued]
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
