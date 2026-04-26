from __future__ import annotations

from typing import Optional


def normalize_pot_id(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    normalized = value.strip().lower()
    return normalized or None


__all__ = ["normalize_pot_id"]
