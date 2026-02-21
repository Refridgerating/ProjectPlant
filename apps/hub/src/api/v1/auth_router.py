from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from auth import (
    AppleIdentityError,
    GoogleIdentityError,
    create_access_token,
    verify_apple_id_token,
    verify_google_id_token,
)
from config import settings
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


class AuthUserModel(BaseModel):
    id: str
    email: EmailStr
    display_name: str
    email_verified: bool
    auth_provider: Literal["local", "google", "apple"]
    avatar_url: str | None = None


class GoogleSignInResponse(TokenResponse):
    user: AuthUserModel


class LocalSignInResponse(TokenResponse):
    user: AuthUserModel


class AppleSignInRequest(BaseModel):
    id_token: str = Field(..., min_length=1)


class AppleSignInResponse(TokenResponse):
    user: AuthUserModel


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/token", response_model=TokenResponse, status_code=status.HTTP_200_OK)
async def issue_token(current_user: UserAccount = Depends(get_current_user)) -> TokenResponse:
    token = create_access_token(current_user.id)
    return TokenResponse(access_token=token, expires_in=settings.auth_access_token_ttl_seconds)


@router.post("/local", response_model=LocalSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_local_account(payload: LocalSignInRequest) -> LocalSignInResponse:
    try:
        user = plant_catalog.authenticate_local_user(
            email=str(payload.email),
            password=payload.password,
        )
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
    )


@router.post("/google", response_model=GoogleSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_google(payload: GoogleSignInRequest) -> GoogleSignInResponse:
    if not settings.google_oauth_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is disabled on this hub",
        )
    if not settings.google_oauth_client_ids:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured",
        )
    try:
        identity = verify_google_id_token(
            payload.id_token,
            allowed_client_ids=settings.google_oauth_client_ids,
            hosted_domain=settings.google_oauth_hosted_domain,
        )
        user = plant_catalog.upsert_google_user(
            google_sub=identity.subject,
            email=identity.email,
            display_name=identity.display_name,
            picture=identity.picture,
        )
    except GoogleIdentityError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    access_token = create_access_token(user.id)
    return GoogleSignInResponse(
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
    )


@router.post("/apple", response_model=AppleSignInResponse, status_code=status.HTTP_200_OK)
async def sign_in_with_apple(payload: AppleSignInRequest) -> AppleSignInResponse:
    if not settings.apple_oauth_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Apple sign-in is disabled on this hub",
        )
    if not settings.apple_oauth_client_ids:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Apple sign-in is not configured",
        )
    try:
        identity = verify_apple_id_token(
            payload.id_token,
            allowed_client_ids=settings.apple_oauth_client_ids,
        )
        user = plant_catalog.upsert_apple_user(
            apple_sub=identity.subject,
            email=identity.email,
            display_name=identity.display_name,
        )
    except AppleIdentityError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    access_token = create_access_token(user.id)
    return AppleSignInResponse(
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
    )


__all__ = ["router"]
