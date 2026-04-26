from __future__ import annotations

from pathlib import Path

_PACKAGE_PATH = Path(__file__).resolve().parents[4] / "packages" / "care_engine" / "src" / "care_engine"
if _PACKAGE_PATH.exists():
    __path__.append(str(_PACKAGE_PATH))  # type: ignore[name-defined]
