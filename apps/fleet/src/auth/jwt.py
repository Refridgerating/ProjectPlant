"""Ed25519 JWT helpers for fleet account access tokens."""

from __future__ import annotations

import base64
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from config import settings
from models import JwkRecord, JwksResponse, SystemRole
from security import utc_now_iso


class AuthTokenError(RuntimeError):
    pass


@dataclass(slots=True)
class AccessTokenClaims:
    account_id: str
    session_id: str
    system_role: SystemRole
    email: str
    capabilities: list[str]
    scopes: list[str]
    organization_ids: list[str]
    site_ids: list[str]
    hub_ids: list[str]
    is_primary_master: bool
    is_backup_master: bool
    master_controls_enabled: bool
    mfa_satisfied: bool
    recovery_session: bool
    issued_at: int
    expires_at: int
    key_id: str


def _connect() -> sqlite3.Connection:
    db_path = Path(settings.fleet_database_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_jwks_schema(conn: sqlite3.Connection | None = None) -> None:
    if conn is not None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jwks_keys (
                key_id TEXT PRIMARY KEY,
                private_seed_hex TEXT NOT NULL,
                public_key_hex TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                rotated_at TEXT
            )
            """
        )
        return
    with _connect() as own_conn:
        ensure_jwks_schema(own_conn)
        own_conn.commit()


def _active_key_row(conn: sqlite3.Connection) -> sqlite3.Row:
    ensure_jwks_schema(conn)
    row = conn.execute("SELECT * FROM jwks_keys WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").fetchone()
    if row is not None:
        return row
    signing_key = SigningKey.generate()
    key_id = f"kid-{uuid4().hex[:12]}"
    now = utc_now_iso()
    conn.execute(
        "INSERT INTO jwks_keys(key_id, private_seed_hex, public_key_hex, status, created_at, rotated_at) VALUES(?, ?, ?, 'active', ?, NULL)",
        (
            key_id,
            signing_key.encode().hex(),
            signing_key.verify_key.encode().hex(),
            now,
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM jwks_keys WHERE key_id = ?", (key_id,)).fetchone()
    assert row is not None
    return row


def create_access_token(
    account_id: str,
    *,
    conn: sqlite3.Connection | None = None,
    session_id: str,
    system_role: SystemRole,
    email: str,
    capabilities: list[str],
    scopes: list[str],
    organization_ids: list[str],
    site_ids: list[str],
    hub_ids: list[str],
    is_primary_master: bool,
    is_backup_master: bool,
    master_controls_enabled: bool,
    mfa_satisfied: bool,
    recovery_session: bool,
    expires_in_seconds: int,
) -> str:
    subject = account_id.strip()
    if not subject:
        raise AuthTokenError("Account id is required")
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(seconds=max(60, int(expires_in_seconds)))
    if conn is None:
        ensure_jwks_schema()
        with _connect() as own_conn:
            row = _active_key_row(own_conn)
    else:
        row = _active_key_row(conn)
    key = SigningKey(bytes.fromhex(str(row["private_seed_hex"])))
    header = {"alg": "EdDSA", "typ": "JWT", "kid": str(row["key_id"])}
    payload: dict[str, Any] = {
        "sub": subject,
        "sid": session_id.strip(),
        "role": system_role,
        "email": email.strip().lower(),
        "capabilities": sorted(set(capabilities)),
        "scopes": sorted(set(scopes)),
        "org_ids": sorted(set(organization_ids)),
        "site_ids": sorted(set(site_ids)),
        "hub_ids": sorted(set(hub_ids)),
        "primary_master": bool(is_primary_master),
        "backup_master": bool(is_backup_master),
        "master_controls": bool(master_controls_enabled),
        "mfa": bool(mfa_satisfied),
        "recovery_session": bool(recovery_session),
        "iss": settings.auth_jwt_issuer,
        "aud": settings.auth_jwt_audience,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    encoded_header = _encode_segment(header)
    encoded_payload = _encode_segment(payload)
    signature = key.sign(f"{encoded_header}.{encoded_payload}".encode("ascii")).signature
    return f"{encoded_header}.{encoded_payload}.{_b64url_encode(signature)}"


def verify_access_token(token: str) -> AccessTokenClaims:
    cleaned = token.strip()
    if not cleaned:
        raise AuthTokenError("Missing access token")
    try:
        encoded_header, encoded_payload, encoded_signature = cleaned.split(".")
    except ValueError as exc:
        raise AuthTokenError("Invalid access token format") from exc

    header = _decode_segment(encoded_header)
    payload = _decode_segment(encoded_payload)
    if header.get("alg") != "EdDSA":
        raise AuthTokenError("Invalid access token algorithm")
    kid = str(header.get("kid", "")).strip()
    if not kid:
        raise AuthTokenError("Access token missing key id")

    with _connect() as conn:
        ensure_jwks_schema(conn)
        row = conn.execute("SELECT * FROM jwks_keys WHERE key_id = ? AND status IN ('active', 'rotated')", (kid,)).fetchone()
    if row is None:
        raise AuthTokenError("Unknown access token signing key")

    verify_key = VerifyKey(bytes.fromhex(str(row["public_key_hex"])))
    try:
        verify_key.verify(f"{encoded_header}.{encoded_payload}".encode("ascii"), _b64url_decode(encoded_signature))
    except BadSignatureError as exc:
        raise AuthTokenError("Invalid access token signature") from exc

    if str(payload.get("iss", "")) != settings.auth_jwt_issuer:
        raise AuthTokenError("Invalid access token issuer")
    if str(payload.get("aud", "")) != settings.auth_jwt_audience:
        raise AuthTokenError("Invalid access token audience")

    now_epoch = int(datetime.now(timezone.utc).timestamp())
    exp = int(payload.get("exp", 0))
    iat = int(payload.get("iat", 0))
    if exp <= now_epoch:
        raise AuthTokenError("Access token expired")
    if iat > now_epoch + 60:
        raise AuthTokenError("Access token issue time is invalid")

    subject = str(payload.get("sub", "")).strip()
    session_id = str(payload.get("sid", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    system_role = str(payload.get("role", "")).strip()
    if system_role not in {"master", "administrator", "user"}:
        raise AuthTokenError("Access token missing valid system role")
    if not subject or not session_id or not email:
        raise AuthTokenError("Access token missing required subject data")

    return AccessTokenClaims(
        account_id=subject,
        session_id=session_id,
        system_role=system_role,  # type: ignore[arg-type]
        email=email,
        capabilities=_string_list(payload.get("capabilities")),
        scopes=_string_list(payload.get("scopes")),
        organization_ids=_string_list(payload.get("org_ids")),
        site_ids=_string_list(payload.get("site_ids")),
        hub_ids=_string_list(payload.get("hub_ids")),
        is_primary_master=bool(payload.get("primary_master")),
        is_backup_master=bool(payload.get("backup_master")),
        master_controls_enabled=bool(payload.get("master_controls")),
        mfa_satisfied=bool(payload.get("mfa")),
        recovery_session=bool(payload.get("recovery_session")),
        issued_at=iat,
        expires_at=exp,
        key_id=kid,
    )


def get_jwks() -> JwksResponse:
    with _connect() as conn:
        ensure_jwks_schema(conn)
        _active_key_row(conn)
        rows = conn.execute("SELECT * FROM jwks_keys WHERE status IN ('active', 'rotated') ORDER BY created_at DESC").fetchall()
    return JwksResponse(
        keys=[
            JwkRecord(kid=str(row["key_id"]), x=_b64url_encode(bytes.fromhex(str(row["public_key_hex"]))))
            for row in rows
        ]
    )


def _encode_segment(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return _b64url_encode(raw)


def _decode_segment(value: str) -> dict[str, object]:
    parsed = json.loads(_b64url_decode(value).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise AuthTokenError("Invalid token segment type")
    return parsed


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)
