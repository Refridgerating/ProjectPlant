from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from config import settings


@dataclass(slots=True)
class ManagedAccessClaims:
    account_id: str
    session_id: str
    email: str
    system_role: str
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
    expires_at: int


_JWKS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "keys": {}}


def managed_mode_enabled() -> bool:
    return (settings.control_plane_auth_mode or "local_compat").strip().lower() == "managed"


def control_plane_base_url() -> str:
    base = (settings.control_plane_url or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("CONTROL_PLANE_URL is not configured")
    return base


def control_plane_jwks_url() -> str:
    configured = (settings.control_plane_jwks_url or "").strip()
    if configured:
        return configured
    return f"{control_plane_base_url()}/api/v1/.well-known/jwks.json"


async def proxy_control_plane_json(path: str, *, method: str = "GET", token: str | None = None, json_body: dict[str, Any] | None = None) -> Any:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(timeout=settings.control_plane_http_timeout_seconds) as client:
        response = await client.request(method, f"{control_plane_base_url()}{path}", headers=headers, json=json_body)
    if response.status_code >= 400:
        detail = None
        try:
            payload = response.json()
            detail = payload.get("detail") if isinstance(payload, dict) else None
        except Exception:
            detail = None
        raise RuntimeError(str(detail or f"Control plane request failed ({response.status_code})"))
    return response.json()


async def fetch_hub_summary(token: str) -> dict[str, Any]:
    hub_id = (settings.hub_id or "").strip()
    if not hub_id:
        raise RuntimeError("HUB_ID is not configured")
    hub = await proxy_control_plane_json(f"/api/v1/hubs/{hub_id}", token=token)
    releases = await proxy_control_plane_json("/api/v1/releases", token=token)
    return {"hub": hub, "releases": releases.get("releases", []) if isinstance(releases, dict) else []}


async def queue_hub_update(token: str, *, release_id: str) -> dict[str, Any]:
    hub_id = (settings.hub_id or "").strip()
    if not hub_id:
        raise RuntimeError("HUB_ID is not configured")
    return await proxy_control_plane_json(
        "/api/v1/rollouts",
        method="POST",
        token=token,
        json_body={"releaseId": release_id, "selector": {"hubIds": [hub_id]}},
    )


async def queue_hub_rollback(token: str) -> dict[str, Any]:
    hub_id = (settings.hub_id or "").strip()
    if not hub_id:
        raise RuntimeError("HUB_ID is not configured")
    return await proxy_control_plane_json(f"/api/v1/hubs/{hub_id}/rollback", method="POST", token=token)


async def fetch_hub_audit(token: str, *, limit: int = 10) -> list[dict[str, Any]]:
    payload = await proxy_control_plane_json(f"/api/v1/audit?limit={max(1, min(limit, 50))}", token=token)
    if isinstance(payload, dict) and isinstance(payload.get("events"), list):
        return payload["events"]
    return []


def verify_managed_access_token(token: str) -> ManagedAccessClaims:
    cleaned = token.strip()
    if not cleaned:
        raise RuntimeError("Missing access token")
    try:
        encoded_header, encoded_payload, encoded_signature = cleaned.split(".")
    except ValueError as exc:
        raise RuntimeError("Invalid access token format") from exc
    header = _decode_segment(encoded_header)
    payload = _decode_segment(encoded_payload)
    if str(header.get("alg", "")) != "EdDSA":
        raise RuntimeError("Invalid control-plane token algorithm")
    if str(payload.get("iss", "")) != settings.control_plane_jwt_issuer:
        raise RuntimeError("Invalid control-plane token issuer")
    if str(payload.get("aud", "")) != settings.control_plane_jwt_audience:
        raise RuntimeError("Invalid control-plane token audience")
    if int(payload.get("exp", 0)) <= int(time.time()):
        raise RuntimeError("Control-plane token expired")
    kid = str(header.get("kid", "")).strip()
    verify_key = _verify_key_for_kid(kid)
    try:
        verify_key.verify(f"{encoded_header}.{encoded_payload}".encode("ascii"), _b64url_decode(encoded_signature))
    except BadSignatureError as exc:
        raise RuntimeError("Invalid control-plane token signature") from exc
    return ManagedAccessClaims(
        account_id=str(payload.get("sub", "")).strip(),
        session_id=str(payload.get("sid", "")).strip(),
        email=str(payload.get("email", "")).strip(),
        system_role=str(payload.get("role", "")).strip(),
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
        expires_at=int(payload.get("exp", 0)),
    )


def effective_access_from_claims(claims: ManagedAccessClaims) -> dict[str, Any]:
    return {
        "accountId": claims.account_id,
        "email": claims.email,
        "systemRole": claims.system_role,
        "isPrimaryMaster": claims.is_primary_master,
        "isBackupMaster": claims.is_backup_master,
        "masterControlsEnabled": claims.master_controls_enabled,
        "capabilities": claims.capabilities,
        "scopes": claims.scopes,
        "organizations": claims.organization_ids,
        "sites": claims.site_ids,
        "hubs": claims.hub_ids,
        "mfaRequired": claims.system_role == "master",
        "mfaSatisfied": claims.mfa_satisfied,
    }


def synthetic_user_from_claims(claims: ManagedAccessClaims):
    from services.plants import UserAccount

    now = time.time()
    return UserAccount(
        id=claims.account_id,
        email=claims.email,
        display_name=claims.email.split("@", 1)[0] or claims.email,
        created_at=now,
        updated_at=now,
        password_hash="managed",
        email_verified=True,
        verification_token=None,
        auth_provider="local",
        preferences={},
    )


def token_has_capability(claims: ManagedAccessClaims, capability: str, *, hub_id: str | None = None) -> bool:
    if capability not in claims.capabilities:
        return False
    if hub_id and claims.system_role != "master" and hub_id not in claims.hub_ids:
        return False
    return True


def _decode_segment(value: str) -> dict[str, Any]:
    parsed = json.loads(_b64url_decode(value).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Invalid token segment")
    return parsed


def _verify_key_for_kid(kid: str) -> VerifyKey:
    if not kid:
        raise RuntimeError("Missing token key id")
    now = time.time()
    if now - float(_JWKS_CACHE.get("fetched_at", 0.0)) > settings.control_plane_jwks_cache_ttl_seconds or kid not in _JWKS_CACHE.get("keys", {}):
        _refresh_jwks()
    key_bytes = _JWKS_CACHE.get("keys", {}).get(kid)
    if not key_bytes:
        raise RuntimeError("Unknown control-plane signing key")
    return VerifyKey(key_bytes)


def _refresh_jwks() -> None:
    response = httpx.get(control_plane_jwks_url(), timeout=settings.control_plane_http_timeout_seconds)
    response.raise_for_status()
    payload = response.json()
    keys: dict[str, bytes] = {}
    if isinstance(payload, dict):
        for item in payload.get("keys", []):
            if not isinstance(item, dict):
                continue
            kid = str(item.get("kid", "")).strip()
            x = str(item.get("x", "")).strip()
            if kid and x:
                keys[kid] = _b64url_decode(x)
    _JWKS_CACHE["keys"] = keys
    _JWKS_CACHE["fetched_at"] = time.time()


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)
