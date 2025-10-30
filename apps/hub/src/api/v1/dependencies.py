from __future__ import annotations

from fastapi import Header, HTTPException, status

from services.plants import UserAccount, plant_catalog


def get_current_user(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> UserAccount:
    if not x_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing user identifier")
    user_id = x_user_id.strip()
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing user identifier")
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user")
    return user


def get_user_or_404(user_id: str) -> UserAccount:
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user
