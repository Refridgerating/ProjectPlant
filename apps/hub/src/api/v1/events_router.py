from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from auth import AuthTokenError, verify_access_token
from services.alerts import alerts_service
from services.event_bus import EventMessage, event_bus
from services.jobs import job_registry
from services.plants import UserAccount, plant_catalog
from services.pump_status import PumpStatusSnapshot, pump_status_cache
from services.telemetry import telemetry_store

logger = logging.getLogger("projectplant.hub.events")

router = APIRouter(prefix="/events", tags=["events"])

INITIAL_TELEMETRY_HOURS = 24.0
INITIAL_TELEMETRY_LIMIT = 288
INITIAL_ALERT_LIMIT = 100
KEEPALIVE_SECONDS = 20.0


@router.get(
    "/stream",
    response_class=StreamingResponse,
    summary="Server-sent events stream for live telemetry and diagnostics",
)
async def stream_events(token: str | None = Query(default=None, description="Token from /api/v1/auth/token")) -> StreamingResponse:
    user = _validate_token(token)
    logger.debug("Event stream requested by %s", user.id)

    async def _event_source() -> AsyncIterator[bytes]:
        subscription = await event_bus.subscribe()
        try:
            snapshot = await _build_initial_snapshot()
            yield EventMessage(type="init", data=snapshot).to_sse()
            while True:
                try:
                    message = await asyncio.wait_for(subscription.get(), timeout=KEEPALIVE_SECONDS)
                    yield message.to_sse()
                except asyncio.TimeoutError:
                    yield b": keep-alive\n\n"
        except asyncio.CancelledError:  # pragma: no cover - server shutdown
            raise
        finally:
            await subscription.close()

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(_event_source(), media_type="text/event-stream", headers=headers)


def _validate_token(token: str | None) -> UserAccount:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    try:
        user_id = verify_access_token(token)
    except AuthTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    user = plant_catalog.get_user(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user


async def _build_initial_snapshot() -> dict[str, object]:
    env_task = asyncio.create_task(
        telemetry_store.list_samples(hours=INITIAL_TELEMETRY_HOURS, limit=INITIAL_TELEMETRY_LIMIT)
    )
    jobs_task = asyncio.create_task(job_registry.list())
    alerts_task = asyncio.create_task(alerts_service.list_events(limit=INITIAL_ALERT_LIMIT))

    environment, jobs, alerts = await asyncio.gather(env_task, jobs_task, alerts_task)
    status_payload = [_serialize_status(entry) for entry in pump_status_cache.list()]
    telemetry_payload = [sample.to_payload() for sample in environment]

    snapshot: dict[str, object] = {
        "telemetry": {"environment": telemetry_payload},
        "status": status_payload,
        "jobs": jobs,
        "alerts": alerts,
    }
    return snapshot


def _serialize_status(entry: PumpStatusSnapshot) -> dict[str, object]:
    return entry.to_dict()


__all__ = ["router"]
