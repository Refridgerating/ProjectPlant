"""Lightweight auth helpers used by unit tests and local development."""

from .apple import AppleIdentity, AppleIdentityError, verify_apple_id_token
from .google import GoogleIdentity, GoogleIdentityError, verify_google_id_token
from .jwt import AuthTokenError, create_access_token, verify_access_token

__all__ = [
    "AppleIdentity",
    "AppleIdentityError",
    "AuthTokenError",
    "GoogleIdentity",
    "GoogleIdentityError",
    "create_access_token",
    "verify_apple_id_token",
    "verify_access_token",
    "verify_google_id_token",
]
