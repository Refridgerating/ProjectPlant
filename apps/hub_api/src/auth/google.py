"""Google ID token verification helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence


@dataclass(slots=True)
class GoogleIdentity:
    subject: str
    email: str
    email_verified: bool
    display_name: str
    picture: str | None
    hosted_domain: str | None


class GoogleIdentityError(RuntimeError):
    """Raised when a Google ID token cannot be trusted."""


def verify_google_id_token(
    raw_token: str,
    *,
    allowed_client_ids: Sequence[str],
    hosted_domain: str | None = None,
) -> GoogleIdentity:
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token
    except ModuleNotFoundError as exc:  # pragma: no cover - environment setup issue
        raise GoogleIdentityError("google-auth dependency is missing") from exc

    token = raw_token.strip()
    if not token:
        raise GoogleIdentityError("Missing Google ID token")

    client_ids = [client_id.strip() for client_id in allowed_client_ids if client_id.strip()]
    if not client_ids:
        raise GoogleIdentityError("Google sign-in is not configured")

    request = google_requests.Request()
    payload: dict[str, Any] | None = None
    for client_id in client_ids:
        try:
            verified = id_token.verify_oauth2_token(token, request, client_id)
        except ValueError:
            continue
        payload = dict(verified)
        break

    if payload is None:
        raise GoogleIdentityError("Invalid Google ID token")

    issuer = str(payload.get("iss", "")).strip()
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise GoogleIdentityError("Invalid Google token issuer")

    subject = str(payload.get("sub", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    email_verified = bool(payload.get("email_verified"))
    display_name = str(payload.get("name", "")).strip() or email
    picture = str(payload.get("picture", "")).strip() or None
    token_hosted_domain = str(payload.get("hd", "")).strip().lower() or None

    if not subject:
        raise GoogleIdentityError("Google token subject is missing")
    if not email:
        raise GoogleIdentityError("Google token email is missing")
    if not email_verified:
        raise GoogleIdentityError("Google account email is not verified")

    required_domain = (hosted_domain or "").strip().lower()
    if required_domain and token_hosted_domain != required_domain:
        raise GoogleIdentityError("Google account is not in the allowed hosted domain")

    return GoogleIdentity(
        subject=subject,
        email=email,
        email_verified=email_verified,
        display_name=display_name,
        picture=picture,
        hosted_domain=token_hosted_domain,
    )


__all__ = ["GoogleIdentity", "GoogleIdentityError", "verify_google_id_token"]
