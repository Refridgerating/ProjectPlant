from fastapi import FastAPI
from fastapi.responses import JSONResponse
from config import settings

def create_app() -> FastAPI:
    app = FastAPI(title=settings.APP_NAME, version=settings.APP_VERSION)

    @app.get("/", tags=["meta"])
    async def root():
        return {"name": settings.APP_NAME, "version": settings.APP_VERSION}

    @app.get("/health", tags=["meta"])
    async def health():
        return JSONResponse({"status": "ok", "version": settings.APP_VERSION})

    return app

app = create_app()
