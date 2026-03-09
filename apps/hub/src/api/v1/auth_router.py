from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from auth import (
    AppleIdentityError,
    GoogleIdentityError,
    create_access_token,
    verify_apple_id_token,
    verify_google_id_token,
)
from config import settings
from services.managed_auth import managed_mode_enabled, proxy_control_plane_json
from services.plants import CatalogError, UserAccount, plant_catalog

from .dependencies import get_current_user


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = settings.auth_access_token_ttl_seconds


class GoogleSignInRequest(BaseModel):
    id_token: str = Field(..., min_length=1)


class LocalSignInRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=256)


class MfaVerifyRequest(BaseModel):
    challenge_id: str = Field(..., min_length=8, max_length=128)
    code: str = Field(..., min_length=6, max_length=64)


class AuthUserModel(BaseModel):
    id: str
    email: EmailStr
    display_name: str
    email_verified: bool
    auth_provider: Literal["local", "google", "apple"]
    avatar_url: str | None = None


class LocalSignInResponse(TokenResponse):
    user: AuthUserModel | None = None
    effective_access: dict[str, object] | None = None
    mfa_required: bool = False
    challenge_id: str | None = None
    factor_type: str | None = None
    expires_at: str | None = None


class GoogleSignInResponse(TokenResponse):
    user: AuthUserModel


class AppleSignInRequest(BaseModel):
    id_token: str = Field(..., min_length=1)


class AppleSignInResponse(TokenResponse):
    user: AuthUserModel


router = APIRouter(prefix="/auth", tags=["auth"])


def _map_managed_auth(payload: dict[str, object]) -> LocalSignInResponse:
    if bool(payload.get("mfaRequired")):
        return LocalSignInResponse(
            access_token="",
            expires_in=0,
            user=None,
            effective_access=None,
            mfa_required=True,
            challenge_id=str(payload.get("challengeId") or ""),
            factor_type=str(payload.get("factorType") or "totp"),
            expires_at=str(payload.get("expiresAt") or ""),
        )
    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    effective = payload.get("effectiveAccess") if isinstance(payload.get("effectiveAccess"), dict) else None
    email = str(account.get("email") or "")
    display_name = str(account.get("displayName") or email)
    return LocalSignInResponse(
        access_token=str(payload.get("access_token") or ""),
        expires_in=int(payload.get("expires_in") or 0),
        user=AuthUserModel(
            id=str(account.get("accountId") or email),
            email=email or "managed@example.invalid",
            display_name=display_name,
            email_verified=True,
            auth_provider="local",
        ),
        effective_access=effective,
        mfa_required=False,
    )


@router.post("/token", response_model=TokenResponse, status_code=status.HTTP_200_OK)
async def issue_token(
    current_user: UserAccount = Depends(get_current_user),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> TokenResponse:
    if managed_mode_enabled():
        if not authorization:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        scheme, _, raw_token = authorization.partition(" ")
        if scheme.strip().lower() != "bearer" or not raw_token.strip():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token")
        return TokenResponse(access_token=raw_token.strip(), expires_in=3600)
    token = create_access_token(current_user.id)
    return TokenResponse(access_token=token, expires_in=settings.auth_access_token_ttl_seconds)


@router.post("/local", response_model=LocalSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_local_account(payload: LocalSignInRequest) -> LocalSignInResponse:
    if managed_mode_enabled():
        try:
            response = await proxy_control_plane_json(
                "/api/v1/auth/local",
                method="POST",
                json_body={"email": str(payload.email), "password": payload.password},
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
        return _map_managed_auth(response)

    try:
        user = plant_catalog.authenticate_local_user(email=str(payload.email), password=payload.password)
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    access_token = create_access_token(user.id)
    return LocalSignInResponse(
        access_token=access_token,
        expires_in=settings.auth_access_token_ttl_seconds,
        user=AuthUserModel(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            email_verified=user.email_verified,
            auth_provider=user.auth_provider,
            avatar_url=user.avatar_url,
        ),
        effective_access=None,
    )


@router.post("/mfa/verify", response_model=LocalSignInResponse, status_code=status.HTTP_200_OK)
async def verify_mfa(payload: MfaVerifyRequest) -> LocalSignInResponse:
    if not managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MFA verification is unavailable in local compatibility mode")
    try:
        response = await proxy_control_plane_json(
            "/api/v1/auth/mfa/verify",
            method="POST",
            json_body={"challengeId": payload.challenge_id, "code": payload.code},
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return _map_managed_auth(response)


@router.post("/logout")
async def logout(authorization: str | None = Header(default=None, alias="Authorization")) -> dict[str, bool]:
    if managed_mode_enabled():
        token = ""
        if authorization:
            scheme, _, raw_token = authorization.partition(" ")
            if scheme.strip().lower() == "bearer":
                token = raw_token.strip()
        if token:
            try:
                await proxy_control_plane_json("/api/v1/auth/logout", method="POST", token=token)
            except RuntimeError:
                pass
        return {"revoked": True}
    return {"revoked": True}


@router.post("/google", response_model=GoogleSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_google(payload: GoogleSignInRequest) -> GoogleSignInResponse:
    if managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google sign-in is disabled in managed mode")
    if not settings.google_oauth_enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google sign-in is disabled on this hub")
    if not settings.google_oauth_client_ids:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Google sign-in is not configured")
    try:
        identity = verify_google_id_token(payload.id_token, allowed_client_ids=settings.google_oauth_client_ids, hosted_domain=settings.google_oauth_hosted_domain)
        user = plant_catalog.upsert_google_user(google_sub=identity.subject, email=identity.email, display_name=identity.display_name, picture=identity.picture)
    except GoogleIdentityError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    access_token = create_access_token(user.id)
    return GoogleSignInResponse(
        access_token=access_token,
        expires_in=settings.auth_access_token_ttl_seconds,
        user=AuthUserModel(id=user.id, email=user.email, display_name=user.display_name, email_verified=user.email_verified, auth_provider=user.auth_provider, avatar_url=user.avatar_url),
    )


@router.post("/apple", response_model=AppleSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_apple(payload: AppleSignInRequest) -> AppleSignInResponse:
    if managed_mode_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Apple sign-in is disabled in managed mode")
    if not settings.apple_oauth_enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Apple sign-in is disabled on this hub")
    if not settings.apple_oauth_client_ids:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Apple sign-in is not configured")
    try:
        identity = verify_apple_id_token(payload.id_token, allowed_client_ids=settings.apple_oauth_client_ids)
        user = plant_catalog.upsert_apple_user(apple_sub=identity.subject, email=identity.email, display_name=identity.display_name)
    except AppleIdentityError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    access_token = create_access_token(user.id)
    return AppleSignInResponse(
        access_token=access_token,
        expires_in=settings.auth_access_token_ttl_seconds,
        user=AuthUserModel(id=user.id, email=user.email, display_name=user.display_name, email_verified=user.email_verified, auth_provider=user.auth_provider, avatar_url=user.avatar_url),
    )


__all__ = ["router"]
