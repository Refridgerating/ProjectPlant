"""Minimal token helper so tests can exercise authenticated endpoints.

The real authentication flow will eventually mint signed JWTs, but the UI tests
only need a stable, unique token. We therefore return a deterministic string
that encodes the user id and a timestamp; downstream code simply checks for the
Bearer header and does not validate the token contents yet.
"""

from __future__ import annotations

from datetime import datetime, timezone


def create_access_token(user_id: str) -> str:
    """Return a pseudo JWT for the given user.

    The payload is not signed or encrypted; it is only meant to appease local
    development and unit tests until the real auth stack lands.
    """

    issued = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    safe_user = user_id.replace(" ", "_") or "anonymous"
    return f"dummy.{safe_user}.{issued}"


__all__ = ["create_access_token"]
