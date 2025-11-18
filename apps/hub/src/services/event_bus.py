from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any


def _json_default(value: Any) -> Any:
    if isinstance(value, set):
        return sorted(value)
    if hasattr(value, "dict"):
        return value.dict()  # type: ignore[call-arg]
    if hasattr(value, "__dict__"):
        return value.__dict__
    return str(value)


@dataclass(frozen=True, slots=True)
class EventMessage:
    type: str
    data: Any
    id: str | None = None
    retry: int | None = None
    created_at: float = field(default_factory=lambda: time.time())

    def to_sse(self) -> bytes:
        payload = json.dumps(self.data, separators=(",", ":"), default=_json_default)
        lines: list[str] = []
        if self.retry is not None:
            lines.append(f"retry: {self.retry}")
        if self.id is not None:
            lines.append(f"id: {self.id}")
        lines.append(f"event: {self.type}")
        if payload:
            for chunk in payload.splitlines() or [""]:
                lines.append(f"data: {chunk}")
        else:
            lines.append("data: {}")
        return ("\n".join(lines) + "\n\n").encode("utf-8")


class EventSubscription:
    def __init__(self, bus: EventBus, queue: asyncio.Queue[EventMessage]) -> None:
        self._bus = bus
        self._queue = queue
        self._closed = False

    async def get(self) -> EventMessage:
        return await self._queue.get()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._bus._unsubscribe(self._queue)


class EventBus:
    """Fan-out broadcaster for hub events consumed by the SSE endpoint."""

    def __init__(self, *, subscriber_queue_size: int = 512) -> None:
        self._subscriber_queue_size = max(32, subscriber_queue_size)
        self._subscribers: set[asyncio.Queue[EventMessage]] = set()
        self._lock = asyncio.Lock()
        self._counter = 0

    async def publish(
        self,
        event_type: str,
        data: Any,
        *,
        event_id: str | None = None,
        retry: int | None = None,
    ) -> None:
        message = EventMessage(
            type=event_type,
            data=data,
            id=event_id or self._next_id(),
            retry=retry,
        )
        async with self._lock:
            stale: list[asyncio.Queue[EventMessage]] = []
            for queue in self._subscribers:
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    stale.append(queue)
            if stale:
                for queue in stale:
                    self._subscribers.discard(queue)

    async def subscribe(self) -> EventSubscription:
        queue: asyncio.Queue[EventMessage] = asyncio.Queue(self._subscriber_queue_size)
        async with self._lock:
            self._subscribers.add(queue)
        return EventSubscription(self, queue)

    async def _unsubscribe(self, queue: asyncio.Queue[EventMessage]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    def _next_id(self) -> str:
        self._counter += 1
        return str(self._counter)


event_bus = EventBus()

__all__ = ["EventBus", "EventMessage", "EventSubscription", "event_bus"]
