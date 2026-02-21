from __future__ import annotations

from fastapi import Header, HTTPException, status

from auth import AuthTokenError, verify_access_token
from services.plants import UserAccount, plant_catalog


def get_current_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> UserAccount:
    user_id = _resolve_user_id(authorization, x_user_id)
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user")
    return user


def get_user_or_404(user_id: str) -> UserAccount:
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _resolve_user_id(authorization: str | None, x_user_id: str | None) -> str:
    if authorization:
        scheme, _, raw_token = authorization.partition(" ")
        if scheme.strip().lower() != "bearer":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization scheme")
        token = raw_token.strip()
        if not token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        try:
            return verify_access_token(token)
        except AuthTokenError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    user_id = (x_user_id or "").strip()
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing user identifier")
    return user_id
