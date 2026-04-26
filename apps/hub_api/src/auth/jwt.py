"""JWT helpers for API access tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

from config import settings


class AuthTokenError(RuntimeError):
    """Raised when an API access token cannot be validated."""


def create_access_token(user_id: str, *, expires_in_seconds: int | None = None) -> str:
    """Create a signed JWT for the given user id."""

    subject = user_id.strip()
    if not subject:
        raise AuthTokenError("User id is required for token creation")
    issued_at = datetime.now(timezone.utc)
    ttl = expires_in_seconds if expires_in_seconds is not None else settings.auth_access_token_ttl_seconds
    expires_at = issued_at + timedelta(seconds=max(60, int(ttl)))
    if settings.auth_jwt_algorithm != "HS256":
        raise AuthTokenError("Unsupported JWT algorithm; only HS256 is supported")

    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": subject,
        "iss": settings.auth_jwt_issuer,
        "aud": settings.auth_jwt_audience,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    encoded_header = _encode_segment(header)
    encoded_payload = _encode_segment(payload)
    signature = _sign(encoded_header, encoded_payload)
    return f"{encoded_header}.{encoded_payload}.{signature}"


def verify_access_token(token: str) -> str:
    """Validate a signed JWT and return the user id (`sub`)."""

    cleaned = token.strip()
    if not cleaned:
        raise AuthTokenError("Missing access token")
    try:
        encoded_header, encoded_payload, provided_signature = cleaned.split(".")
    except ValueError as exc:
        raise AuthTokenError("Invalid access token format") from exc

    if settings.auth_jwt_algorithm != "HS256":
        raise AuthTokenError("Unsupported JWT algorithm; only HS256 is supported")

    expected_signature = _sign(encoded_header, encoded_payload)
    if not hmac.compare_digest(expected_signature, provided_signature):
        raise AuthTokenError("Invalid or expired access token")

    try:
        header = _decode_segment(encoded_header)
        payload = _decode_segment(encoded_payload)
    except ValueError as exc:
        raise AuthTokenError("Invalid or expired access token") from exc

    if header.get("alg") != "HS256":
        raise AuthTokenError("Invalid access token algorithm")

    required_claims = {"sub", "iss", "aud", "iat", "exp"}
    if not required_claims.issubset(payload.keys()):
        raise AuthTokenError("Access token missing required claims")
    if str(payload.get("iss", "")) != settings.auth_jwt_issuer:
        raise AuthTokenError("Invalid access token issuer")
    if str(payload.get("aud", "")) != settings.auth_jwt_audience:
        raise AuthTokenError("Invalid access token audience")
    try:
        issued_at = int(payload.get("iat", 0))
        expires_at = int(payload.get("exp", 0))
    except (TypeError, ValueError) as exc:
        raise AuthTokenError("Invalid access token timestamps") from exc
    now_epoch = int(datetime.now(timezone.utc).timestamp())
    if expires_at <= now_epoch:
        raise AuthTokenError("Invalid or expired access token")
    if issued_at > now_epoch + 60:
        raise AuthTokenError("Invalid access token issue time")

    subject = str(payload.get("sub", "")).strip()
    if not subject:
        raise AuthTokenError("Access token missing subject")
    return subject


def _encode_segment(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return _b64url_encode(raw)


def _decode_segment(value: str) -> dict[str, object]:
    try:
        decoded = _b64url_decode(value)
        parsed = json.loads(decoded.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("Invalid segment") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Invalid segment type")
    return parsed


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(encoded_header: str, encoded_payload: str) -> str:
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    digest = hmac.new(
        settings.auth_jwt_secret.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    return _b64url_encode(digest)


__all__ = ["AuthTokenError", "create_access_token", "verify_access_token"]
