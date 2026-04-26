"""Apple ID token verification helpers."""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Sequence

import httpx
import rsa

APPLE_ISSUER = "https://appleid.apple.com"
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_JWKS_CACHE_TTL_SECONDS = 6 * 60 * 60

_APPLE_JWKS_CACHE: tuple[float, list[dict[str, Any]]] | None = None


@dataclass(slots=True)
class AppleIdentity:
    subject: str
    email: str | None
    email_verified: bool
    display_name: str


class AppleIdentityError(RuntimeError):
    """Raised when an Apple ID token cannot be trusted."""


def verify_apple_id_token(
    raw_token: str,
    *,
    allowed_client_ids: Sequence[str],
) -> AppleIdentity:
    token = raw_token.strip()
    if not token:
        raise AppleIdentityError("Missing Apple ID token")

    client_ids = [client_id.strip() for client_id in allowed_client_ids if client_id.strip()]
    if not client_ids:
        raise AppleIdentityError("Apple sign-in is not configured")

    try:
        encoded_header, encoded_payload, encoded_signature = token.split(".")
    except ValueError as exc:
        raise AppleIdentityError("Invalid Apple ID token format") from exc

    header = _decode_json_segment(encoded_header)
    payload = _decode_json_segment(encoded_payload)
    signature = _b64url_decode(encoded_signature)

    if str(header.get("alg", "")).strip() != "RS256":
        raise AppleIdentityError("Unsupported Apple token algorithm")
    key_id = str(header.get("kid", "")).strip()
    if not key_id:
        raise AppleIdentityError("Apple token key id is missing")

    jwk = _find_apple_key(key_id)
    public_key = _public_key_from_jwk(jwk)
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    try:
        rsa.verify(signing_input, signature, public_key)
    except rsa.VerificationError as exc:
        raise AppleIdentityError("Invalid Apple ID token signature") from exc

    issuer = str(payload.get("iss", "")).strip()
    if issuer != APPLE_ISSUER:
        raise AppleIdentityError("Invalid Apple token issuer")

    audience = payload.get("aud")
    if isinstance(audience, list):
        aud_values = [str(value).strip() for value in audience if str(value).strip()]
    else:
        aud_values = [str(audience).strip()] if audience is not None else []
    if not any(value in client_ids for value in aud_values):
        raise AppleIdentityError("Invalid Apple token audience")

    now = int(time.time())
    try:
        expires_at = int(payload.get("exp", 0))
    except (TypeError, ValueError) as exc:
        raise AppleIdentityError("Apple token expiration is invalid") from exc
    if expires_at <= now:
        raise AppleIdentityError("Apple ID token has expired")

    issued_at_raw = payload.get("iat")
    if issued_at_raw is not None:
        try:
            issued_at = int(issued_at_raw)
        except (TypeError, ValueError) as exc:
            raise AppleIdentityError("Apple token issue time is invalid") from exc
        if issued_at > now + 60:
            raise AppleIdentityError("Apple token issue time is in the future")

    subject = str(payload.get("sub", "")).strip()
    if not subject:
        raise AppleIdentityError("Apple token subject is missing")

    email_value = payload.get("email")
    email = str(email_value).strip().lower() if email_value is not None and str(email_value).strip() else None
    email_verified_raw = payload.get("email_verified", False)
    if isinstance(email_verified_raw, str):
        email_verified = email_verified_raw.strip().lower() == "true"
    else:
        email_verified = bool(email_verified_raw)
    if email is not None and not email_verified:
        raise AppleIdentityError("Apple account email is not verified")

    display_name = email or "Apple User"
    return AppleIdentity(
        subject=subject,
        email=email,
        email_verified=email_verified,
        display_name=display_name,
    )


def _find_apple_key(key_id: str) -> dict[str, Any]:
    keys = _fetch_apple_keys()
    for key in keys:
        if str(key.get("kid", "")).strip() == key_id:
            return key
    raise AppleIdentityError("Unable to find Apple signing key")


def _fetch_apple_keys() -> list[dict[str, Any]]:
    global _APPLE_JWKS_CACHE
    now = time.time()
    if _APPLE_JWKS_CACHE is not None:
        fetched_at, keys = _APPLE_JWKS_CACHE
        if now - fetched_at < APPLE_JWKS_CACHE_TTL_SECONDS:
            return keys

    try:
        response = httpx.get(APPLE_JWKS_URL, timeout=5.0)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise AppleIdentityError("Unable to fetch Apple signing keys") from exc

    keys_raw = payload.get("keys")
    if not isinstance(keys_raw, list):
        raise AppleIdentityError("Apple signing keys response is invalid")

    keys: list[dict[str, Any]] = []
    for item in keys_raw:
        if isinstance(item, dict):
            keys.append(item)
    if not keys:
        raise AppleIdentityError("Apple signing keys are unavailable")

    _APPLE_JWKS_CACHE = (now, keys)
    return keys


def _public_key_from_jwk(jwk: dict[str, Any]) -> rsa.PublicKey:
    if str(jwk.get("kty", "")).strip() != "RSA":
        raise AppleIdentityError("Unsupported Apple signing key type")
    n_raw = str(jwk.get("n", "")).strip()
    e_raw = str(jwk.get("e", "")).strip()
    if not n_raw or not e_raw:
        raise AppleIdentityError("Apple signing key is missing modulus/exponent")

    n = int.from_bytes(_b64url_decode(n_raw), byteorder="big")
    e = int.from_bytes(_b64url_decode(e_raw), byteorder="big")
    if n <= 0 or e <= 0:
        raise AppleIdentityError("Apple signing key is invalid")
    return rsa.PublicKey(n, e)


def _decode_json_segment(segment: str) -> dict[str, Any]:
    try:
        decoded = _b64url_decode(segment).decode("utf-8")
        payload = json.loads(decoded)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise AppleIdentityError("Apple ID token payload is invalid") from exc
    if not isinstance(payload, dict):
        raise AppleIdentityError("Apple ID token payload is invalid")
    return payload


def _b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except ValueError as exc:
        raise AppleIdentityError("Apple token encoding is invalid") from exc


__all__ = ["AppleIdentity", "AppleIdentityError", "verify_apple_id_token"]
