from __future__ import annotations

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel

from auth import create_access_token
from services.plants import UserAccount

from .dependencies import get_current_user


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = 3600


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/token", response_model=TokenResponse, status_code=status.HTTP_200_OK)
async def issue_token(current_user: UserAccount = Depends(get_current_user)) -> TokenResponse:
    token = create_access_token(current_user.id)
    return TokenResponse(access_token=token)


__all__ = ["router"]
