from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from config import settings
from services.managed_auth import (
    effective_access_from_claims,
    fetch_hub_audit,
    fetch_hub_summary,
    managed_mode_enabled,
    proxy_control_plane_json,
    queue_hub_rollback,
    queue_hub_update,
    token_has_capability,
    verify_managed_access_token,
)
from services.plants import UserAccount

from .dependencies import get_current_user

router = APIRouter(tags=["managed-auth"])


class HubUpdateRequest(BaseModel):
    releaseId: str = Field(..., min_length=3, max_length=120)


def _require_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization header")
    scheme, _, raw_token = authorization.partition(" ")
    if scheme.strip().lower() != "bearer" or not raw_token.strip():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization header")
    return raw_token.strip()


def _managed_claims(authorization: str | None):
    token = _require_token(authorization)
    try:
        return token, verify_managed_access_token(token)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc


@router.get("/me/effective-access")
async def me_effective_access(
    authorization: str | None = Header(default=None, alias="Authorization"),
    current_user: UserAccount = Depends(get_current_user),
) -> dict[str, Any]:
    if managed_mode_enabled():
        _, claims = _managed_claims(authorization)
        return effective_access_from_claims(claims)
    return {
        "accountId": current_user.id,
        "email": current_user.email,
        "systemRole": "user",
        "isPrimaryMaster": False,
        "isBackupMaster": False,
        "masterControlsEnabled": False,
        "capabilities": ["hub.view", "hub.control"],
        "scopes": [],
        "organizations": [],
        "sites": [],
        "hubs": [settings.hub_id] if settings.hub_id else [],
        "mfaRequired": False,
        "mfaSatisfied": False,
    }


@router.get("/me/security")
async def me_security(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    if managed_mode_enabled():
        token, _ = _managed_claims(authorization)
        try:
            payload = await proxy_control_plane_json("/api/v1/me/security", token=token)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return payload if isinstance(payload, dict) else {}
    return {"mfaEnabled": False, "factorTypes": [], "recoveryCodesRemaining": 0, "lastMfaVerifiedAt": None}


@router.get("/fleet/hub-summary")
async def fleet_hub_summary(authorization: str | None = Header(default=None, alias="Authorization")) -> dict[str, Any]:
    if not managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Managed fleet access is unavailable")
    token, claims = _managed_claims(authorization)
    if not token_has_capability(claims, "hub.view", hub_id=settings.hub_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hub access denied")
    try:
        return await fetch_hub_summary(token)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/fleet/hub-audit")
async def fleet_hub_audit(
    authorization: str | None = Header(default=None, alias="Authorization"),
    limit: int = Query(default=10, ge=1, le=50),
) -> dict[str, Any]:
    if not managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Managed fleet access is unavailable")
    token, claims = _managed_claims(authorization)
    if not token_has_capability(claims, "audit.view", hub_id=settings.hub_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Audit access denied")
    try:
        return {"events": await fetch_hub_audit(token, limit=limit)}
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/fleet/hub-update")
async def fleet_hub_update(
    payload: HubUpdateRequest,
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict[str, Any]:
    if not managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Managed fleet access is unavailable")
    token, claims = _managed_claims(authorization)
    if not token_has_capability(claims, "hub.update", hub_id=settings.hub_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hub update access denied")
    try:
        return await queue_hub_update(token, release_id=payload.releaseId)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/fleet/hub-rollback")
async def fleet_hub_rollback(authorization: str | None = Header(default=None, alias="Authorization")) -> dict[str, Any]:
    if not managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Managed fleet access is unavailable")
    token, claims = _managed_claims(authorization)
    if not token_has_capability(claims, "hub.rollback", hub_id=settings.hub_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hub rollback access denied")
    try:
        return await queue_hub_rollback(token)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
