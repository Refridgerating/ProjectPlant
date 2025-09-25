from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import logging, time

from config import settings
from api.v1.router import router as v1_router
from mqtt.client import startup as mqtt_startup, shutdown as mqtt_shutdown
from services.weather import weather_service
from services.plant_lookup import plant_lookup_service

logger = logging.getLogger("projectplant.hub")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, version=settings.app_version)

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

    app.include_router(v1_router)

    @app.on_event("startup")
    async def _startup():
        if settings.mqtt_enabled:
            logger.info("MQTT enabled; connecting...")
            await mqtt_startup(settings)
        else:
            logger.info("MQTT disabled (set MQTT_ENABLED=true to enable).")

    @app.on_event("shutdown")
    async def _shutdown():
        await mqtt_shutdown()
        await weather_service.close()
        await plant_lookup_service.close()

    return app

app = create_app()


