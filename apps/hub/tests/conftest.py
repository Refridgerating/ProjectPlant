
import sys
from pathlib import Path
from typing import Any, Callable, Dict

import pytest
from fastapi.testclient import TestClient

from config import settings
from main import create_app
from services.plant_lookup import plant_lookup_service

try:  # aggregator is optional in some test contexts
    from services.plant_aggregator import plant_aggregator_service
except ImportError:  # pragma: no cover - aggregator not packaged
    plant_aggregator_service = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[1]
SRC_PATH = ROOT / "src"
if str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_plant_services() -> None:
    plant_lookup_service._suggest_cache.clear()  # type: ignore[attr-defined]
    plant_lookup_service._details_cache.clear()  # type: ignore[attr-defined]
    if plant_aggregator_service is not None:
        plant_aggregator_service.clear()
    yield
    plant_lookup_service._suggest_cache.clear()  # type: ignore[attr-defined]
    plant_lookup_service._details_cache.clear()  # type: ignore[attr-defined]
    if plant_aggregator_service is not None:
        plant_aggregator_service.clear()


@pytest.fixture
def settings_override() -> Callable[..., None]:
    original: Dict[str, Any] = {}

    def _apply(**overrides: Any) -> None:
        for key, value in overrides.items():
            if key not in original:
                original[key] = getattr(settings, key)
            setattr(settings, key, value)

    yield _apply

    for key, value in original.items():
        setattr(settings, key, value)


@pytest.fixture
def disable_mqtt(settings_override: Callable[..., None]) -> None:
    settings_override(mqtt_enabled=False)
    yield


@pytest.fixture
def client(disable_mqtt: None) -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
