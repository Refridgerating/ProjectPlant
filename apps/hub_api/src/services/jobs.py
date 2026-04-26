from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Literal

from .event_bus import event_bus

JobStatus = Literal[
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
]


def _now_iso() -> str:
    ts = datetime.now(timezone.utc)
    iso = ts.isoformat(timespec="milliseconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


@dataclass(slots=True)
class JobUpdate:
    job_id: str
    status: JobStatus
    command: str
    pot_id: str | None = None
    request_id: str | None = None
    message: str | None = None
    error: str | None = None
    payload: dict[str, Any] | None = None
    updated_at: str = field(default_factory=_now_iso)

    def to_payload(self) -> dict[str, Any]:
        data = asdict(self)
        data["jobId"] = data.pop("job_id")
        data["updatedAt"] = data.pop("updated_at")
        return data


class JobRegistry:
    """In-memory cache of recent job updates used to bootstrap SSE clients."""

    def __init__(self, *, max_jobs: int = 200) -> None:
        self._lock = asyncio.Lock()
        self._jobs: dict[str, JobUpdate] = {}
        self._max_jobs = max(1, max_jobs)

    async def publish(self, update: JobUpdate) -> None:
        payload = update.to_payload()
        async with self._lock:
            self._jobs[update.job_id] = update
            if len(self._jobs) > self._max_jobs:
                self._trim_locked()
        await event_bus.publish("jobs", payload)

    async def list(self) -> list[dict[str, Any]]:
        async with self._lock:
            ordered = sorted(self._jobs.values(), key=lambda item: item.updated_at)
            return [entry.to_payload() for entry in ordered]

    def _trim_locked(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        ordered_ids = sorted(
            self._jobs.items(),
            key=lambda item: item[1].updated_at,
        )
        surplus = len(self._jobs) - self._max_jobs
        for job_id, _ in ordered_ids[:surplus]:
            self._jobs.pop(job_id, None)


job_registry = JobRegistry()


async def emit_job_update(update: JobUpdate) -> None:
    await job_registry.publish(update)


async def emit_job_status(
    *,
    job_id: str,
    status: JobStatus,
    command: str,
    pot_id: str | None = None,
    request_id: str | None = None,
    message: str | None = None,
    error: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    await emit_job_update(
        JobUpdate(
            job_id=job_id,
            status=status,
            command=command,
            pot_id=pot_id,
            request_id=request_id,
            message=message,
            error=error,
            payload=payload,
        )
    )


__all__ = ["JobStatus", "JobUpdate", "JobRegistry", "job_registry", "emit_job_update", "emit_job_status"]
