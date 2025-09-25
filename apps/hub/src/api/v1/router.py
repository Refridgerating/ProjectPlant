from fastapi import APIRouter

from config import settings
from .irrigation_router import router as irrigation_router
from .mock_router import mock_router
from .plant_router import router as plant_router
from .weather_router import router as weather_router

router = APIRouter(prefix="/api/v1", tags=["v1"])
router.include_router(mock_router)
router.include_router(irrigation_router)
router.include_router(plant_router)
router.include_router(weather_router)


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
    }