"""Lightweight auth helpers used by unit tests and local development."""

from .jwt import create_access_token

__all__ = ["create_access_token"]
