from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from services.plants import (
    CatalogError,
    CatalogNotFoundError,
    ShareRecord,
    ShareRole,
    ShareStatus,
    UserAccount,
    plant_catalog,
)

from .dependencies import get_current_user

router = APIRouter(prefix="/users", tags=["users"])


class UserModel(BaseModel):
    id: str
    email: EmailStr
    display_name: str
    email_verified: bool
    verification_pending: bool
    auth_provider: Literal["local", "google", "apple"]
    avatar_url: str | None = None
    created_at: float
    updated_at: float


class UserCreateRequest(BaseModel):
    email: EmailStr
    display_name: str = Field(default="")
    password: str = Field(..., min_length=8, max_length=256)
    confirm_password: str = Field(..., min_length=8, max_length=256)


class UserUpdateRequest(BaseModel):
    email: Optional[EmailStr] = None
    display_name: Optional[str] = Field(default=None, max_length=120)
    password: Optional[str] = Field(default=None, min_length=8, max_length=256)
    confirm_password: Optional[str] = Field(default=None, min_length=8, max_length=256)


class UserVerifyRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=128)


class ShareModel(BaseModel):
    id: str
    owner_id: str
    contractor_id: str
    role: ShareRole
    status: ShareStatus
    invite_token: str | None = None
    created_at: float
    updated_at: float
    participant_role: Literal["owner", "contractor"]


class ShareCreateRequest(BaseModel):
    contractor_id: str
    role: ShareRole = ShareRole.CONTRACTOR
    status: ShareStatus = ShareStatus.PENDING
    invite_token: str | None = Field(default=None, max_length=120)


class ShareUpdateRequest(BaseModel):
    role: ShareRole | None = None
    status: ShareStatus | None = None


class UserPreferencesModel(BaseModel):
    values: dict[str, object] = Field(default_factory=dict)


class UserPreferencesUpdateRequest(BaseModel):
    values: dict[str, object] = Field(default_factory=dict)
    replace: bool = False


@router.get("", response_model=list[UserModel])
async def list_users() -> list[UserModel]:
    return [_to_user_model(user) for user in plant_catalog.list_users()]


@router.post("", response_model=UserModel, status_code=status.HTTP_201_CREATED)
async def create_user(payload: UserCreateRequest) -> UserModel:
    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passwords do not match")
    try:
        user = plant_catalog.add_user(
            email=str(payload.email),
            display_name=payload.display_name,
            password=payload.password,
            require_verification=True,
        )
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_user_model(user)


@router.get("/me", response_model=UserModel)
async def get_me(current_user: UserAccount = Depends(get_current_user)) -> UserModel:
    return _to_user_model(current_user)


@router.get("/me/preferences", response_model=UserPreferencesModel)
async def get_my_preferences(current_user: UserAccount = Depends(get_current_user)) -> UserPreferencesModel:
    values = plant_catalog.get_user_preferences(current_user.id)
    return UserPreferencesModel(values=values)


@router.put("/me/preferences", response_model=UserPreferencesModel)
async def update_my_preferences(
    payload: UserPreferencesUpdateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> UserPreferencesModel:
    values = plant_catalog.update_user_preferences(current_user.id, payload.values, replace=payload.replace)
    return UserPreferencesModel(values=values)


@router.get("/{user_id}", response_model=UserModel)
async def get_user(user_id: str) -> UserModel:
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return _to_user_model(user)


@router.post("/{user_id}/verify", response_model=UserModel)
async def verify_user_account(user_id: str, payload: UserVerifyRequest) -> UserModel:
    try:
        user = plant_catalog.verify_user(user_id, payload.token)
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_user_model(user)


@router.patch("/{user_id}", response_model=UserModel)
async def update_user(
    user_id: str,
    payload: UserUpdateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> UserModel:
    if current_user.id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot update other users")

    if payload.password is not None:
        if payload.confirm_password is None or payload.password != payload.confirm_password:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passwords do not match")

    try:
        updated = plant_catalog.update_user(
            user_id,
            email=str(payload.email) if payload.email is not None else None,
            display_name=payload.display_name,
            password=payload.password,
        )
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_user_model(updated)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: str, current_user: UserAccount = Depends(get_current_user)) -> None:
    if current_user.id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot delete other users")
    try:
        plant_catalog.remove_user(user_id)
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/me/shares", response_model=list[ShareModel])
async def list_my_shares(current_user: UserAccount = Depends(get_current_user)) -> list[ShareModel]:
    shares = plant_catalog.list_shares(current_user.id)
    return [_to_share_model(share, current_user.id) for share in shares]


@router.post("/me/shares", response_model=ShareModel, status_code=status.HTTP_201_CREATED)
async def create_share(
    payload: ShareCreateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> ShareModel:
    if current_user.id == payload.contractor_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot share with yourself")
    if plant_catalog.get_user(payload.contractor_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contractor user not found")
    try:
        share = plant_catalog.add_share(
            owner_id=current_user.id,
            contractor_id=payload.contractor_id,
            role=payload.role,
            status=payload.status,
            invite_token=payload.invite_token,
        )
    except CatalogError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_share_model(share, current_user.id)


@router.patch("/me/shares/{share_id}", response_model=ShareModel)
async def update_share(
    share_id: str,
    payload: ShareUpdateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> ShareModel:
    share = plant_catalog.get_share(share_id)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    if share.owner_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owners can update shares")
    try:
        updated = plant_catalog.update_share(
            share_id,
            status=payload.status,
            role=payload.role,
        )
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_share_model(updated, current_user.id)


@router.delete("/me/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_share(share_id: str, current_user: UserAccount = Depends(get_current_user)) -> None:
    share = plant_catalog.get_share(share_id)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    if share.owner_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owners can delete shares")
    plant_catalog.remove_share(share_id)


def _to_user_model(user: UserAccount) -> UserModel:
    return UserModel(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified=user.email_verified,
        verification_pending=not user.email_verified,
        auth_provider=user.auth_provider,
        avatar_url=user.avatar_url,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def _to_share_model(share: ShareRecord, viewer_id: str) -> ShareModel:
    participant_role: Literal["owner", "contractor"] = "owner" if share.owner_id == viewer_id else "contractor"
    return ShareModel(
        id=share.id,
        owner_id=share.owner_id,
        contractor_id=share.contractor_id,
        role=share.role,
        status=share.status,
        invite_token=share.invite_token,
        created_at=share.created_at,
        updated_at=share.updated_at,
        participant_role=participant_role,
    )


__all__ = ["router"]
