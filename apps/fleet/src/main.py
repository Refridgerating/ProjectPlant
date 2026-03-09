from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.v1.router import router as v1_router
from config import settings

logger = logging.getLogger("projectplant.fleet")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield

    app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)
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

    @app.get("/")
    async def root():
        return {"name": settings.app_name, "version": settings.app_version}

    @app.get("/health")
    @app.get("/healthz")
    async def health():
        return JSONResponse({"status": "ok", "version": settings.app_version})

    app.include_router(v1_router)
    return app


app = create_app()
