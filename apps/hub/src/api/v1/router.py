from fastapi import APIRouter

from config import settings
from .auth_router import router as auth_router
from .device_registry_router import router as device_registry_router
from .health_router import router as health_router
from .irrigation_router import router as irrigation_router
from .mock_router import mock_router
from .plant_control_router import router as plant_control_router
from .plant_router import router as plant_router
from .user_router import router as user_router
from .weather_router import router as weather_router
from .telemetry_router import router as telemetry_router
from .provision_router import router as provision_router
from .events_router import router as events_router

router = APIRouter(prefix="/api/v1", tags=["v1"])
router.include_router(auth_router)
router.include_router(device_registry_router)
router.include_router(mock_router)
router.include_router(plant_control_router)
router.include_router(irrigation_router)
router.include_router(plant_router)
router.include_router(user_router)
router.include_router(weather_router)
router.include_router(telemetry_router)
router.include_router(provision_router)
router.include_router(health_router)
router.include_router(events_router)


@router.get("/health")
async def health():
    return {"status": "ok", "version": settings.app_version}


@router.get("/info")
async def info():
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "debug": settings.debug,
        "cors_origins": settings.cors_origins,
        "mqtt_enabled": settings.mqtt_enabled,
        "mqtt_host": settings.mqtt_host,
        "mqtt_port": settings.mqtt_port,
        "pot_telemetry_retention_hours": settings.pot_telemetry_retention_hours,
        "pot_telemetry_max_rows": settings.pot_telemetry_max_rows,
    }
