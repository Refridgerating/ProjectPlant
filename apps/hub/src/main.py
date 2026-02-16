import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from api.search_router import router as search_router
from api.v1.router import router as v1_router
from api.etkc_router import router as etkc_router
from mqtt.client import startup as mqtt_startup, shutdown as mqtt_shutdown
from services.plant_schedule import plant_schedule_service
from services.weather import weather_service
from services.weather_hrrr import hrrr_weather_service
from services.plant_lookup import plant_lookup_service

logger = logging.getLogger("projectplant.hub")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.mqtt_enabled:
            logger.info("MQTT enabled; connecting...")
            await mqtt_startup(settings)
            try:
                await plant_schedule_service.start_scheduler()
            except Exception as exc:  # pragma: no cover - defensive logging
                logger.warning("Plant schedule scheduler failed to start: %s", exc)
        else:
            logger.info("MQTT disabled (set MQTT_ENABLED=true to enable).")
        if settings.hrrr_enabled:
            try:
                await hrrr_weather_service.start_scheduler()
            except Exception as exc:  # pragma: no cover - defensive logging
                logger.warning("HRRR scheduler failed to start: %s", exc)
        try:
            yield
        finally:
            await plant_schedule_service.close()
            await mqtt_shutdown()
            await weather_service.close()
            await hrrr_weather_service.close()
            await plant_lookup_service.close()

    app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)
    app.state.started_at = datetime.now(timezone.utc)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        dur_ms = (time.perf_counter() - start) * 1000.0
        logger.info("%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code, dur_ms)
        return response

    @app.get("/", tags=["meta"])
    async def root():
        return {"name": settings.app_name, "version": settings.app_version}

    @app.get("/health", tags=["meta"])
    async def health():
        return JSONResponse({"status": "ok", "version": settings.app_version})

    app.include_router(search_router)
    app.include_router(v1_router)
    app.include_router(etkc_router)

    return app

app = create_app()


