from __future__ import annotations

import asyncio
import json
import logging
import smtplib
from collections import deque
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Deque, Dict, Iterable, List, Optional

import httpx

from config import settings

logger = logging.getLogger("projectplant.hub.alerts")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    iso = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


@dataclass(slots=True)
class AlertEvent:
    timestamp: str
    event_type: str
    severity: str
    message: str
    detail: str | None
    context: Dict[str, object]
    key: str | None = None
    recovered: bool = False

    def to_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        return payload


@dataclass(slots=True)
class _SmtpConfig:
    host: str
    port: int
    username: str | None
    password: str | None
    use_tls: bool
    email_from: str
    email_to: List[str]


class AlertService:
    """Centralized alert publication and diagnostics event log."""

    def __init__(self) -> None:
        self._events: Deque[AlertEvent] = deque(maxlen=500)
        self._lock = asyncio.Lock()
        self._condition_state: Dict[str, bool] = {}
        self._http_client: httpx.AsyncClient | None = None
        self._history_limit = 500
        self._log_path: Path | None = None
        self._webhook_url: str | None = None
        self._smtp_config: _SmtpConfig | None = None
        self._apply_settings()

    def _apply_settings(self) -> None:
        history_limit = max(50, settings.alerts_history_limit)
        if history_limit != self._history_limit:
            snapshot = list(self._events)[-history_limit:]
            self._events = deque(snapshot, maxlen=history_limit)
            self._history_limit = history_limit
        self._log_path = Path(settings.alerts_event_log).expanduser().resolve() if settings.alerts_event_log else None
        self._webhook_url = settings.alerts_webhook_url or None
        if settings.alerts_smtp_host and settings.alerts_email_from and settings.alerts_email_to:
            self._smtp_config = _SmtpConfig(
                host=settings.alerts_smtp_host,
                port=settings.alerts_smtp_port,
                username=settings.alerts_smtp_username or None,
                password=settings.alerts_smtp_password or None,
                use_tls=bool(settings.alerts_smtp_tls),
                email_from=settings.alerts_email_from,
                email_to=list(settings.alerts_email_to),
            )
        else:
            self._smtp_config = None

    async def emit(
        self,
        event_type: str,
        *,
        severity: str,
        message: str,
        detail: str | None = None,
        context: Optional[Dict[str, object]] = None,
        key: str | None = None,
        notify: bool = True,
    ) -> AlertEvent:
        """Emit a standalone alert event."""
        self._apply_settings()
        event = AlertEvent(
            timestamp=_isoformat(_utc_now()),
            event_type=event_type,
            severity=severity,
            message=message,
            detail=detail,
            context=dict(context or {}),
            key=key,
            recovered=False,
        )
        async with self._lock:
            self._events.append(event)
        await self._persist_event(event)
        if notify:
            await self._dispatch(event)
        return event

    async def transition(
        self,
        *,
        key: str,
        healthy: bool,
        event_type: str,
        severity: str,
        message: str,
        detail: str | None = None,
        context: Optional[Dict[str, object]] = None,
        recovery_message: str | None = None,
        recovery_severity: str = "info",
        notify: bool = True,
        recovery_notify: bool = False,
    ) -> Optional[AlertEvent]:
        """
        Record a condition transition, emitting alerts only when the health state changes.
        """
        self._apply_settings()
        context_payload = dict(context or {})
        current_time = _isoformat(_utc_now())
        async with self._lock:
            previous = self._condition_state.get(key)
            if healthy:
                self._condition_state[key] = True
                if previous is False:
                    event = AlertEvent(
                        timestamp=current_time,
                        event_type=f"{event_type}.recovered",
                        severity=recovery_severity,
                        message=recovery_message or f"{message} (recovered)",
                        detail=detail,
                        context=context_payload,
                        key=key,
                        recovered=True,
                    )
                    self._events.append(event)
                else:
                    return None
            else:
                self._condition_state[key] = False
                if previous is False:
                    return None
                event = AlertEvent(
                    timestamp=current_time,
                    event_type=event_type,
                    severity=severity,
                    message=message,
                    detail=detail,
                    context=context_payload,
                    key=key,
                    recovered=False,
                )
                self._events.append(event)

        await self._persist_event(event)
        if healthy:
            if recovery_notify:
                await self._dispatch(event)
        else:
            if notify:
                await self._dispatch(event)
        return event

    async def list_events(
        self,
        *,
        limit: int = 50,
        severity: str | None = None,
        event_types: Iterable[str] | None = None,
    ) -> List[Dict[str, object]]:
        """Return recent alert events for diagnostics."""
        async with self._lock:
            snapshot = list(self._events)

        if severity:
            snapshot = [event for event in snapshot if event.severity.lower() == severity.lower()]
        if event_types:
            allowed = {e.lower() for e in event_types}
            snapshot = [event for event in snapshot if event.event_type.lower() in allowed]

        if limit > 0:
            snapshot = snapshot[-limit:]

        return [event.to_dict() for event in snapshot]

    async def clear(self) -> None:
        async with self._lock:
            self._events.clear()
            self._condition_state.clear()

    async def close(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    async def _persist_event(self, event: AlertEvent) -> None:
        path = self._log_path
        if path is None:
            return
        payload = json.dumps(event.to_dict(), separators=(",", ":"))
        try:
            await asyncio.to_thread(self._append_log_entry, path, payload)
        except OSError as exc:  # pragma: no cover - persistence failures are non-fatal
            logger.debug("Alert log append failed: %s", exc)

    @staticmethod
    def _append_log_entry(path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(payload + "\n")

    async def _dispatch(self, event: AlertEvent) -> None:
        tasks = []
        if self._webhook_url:
            tasks.append(self._send_webhook(event))
        if self._smtp_config:
            tasks.append(self._send_email(event))
        if not tasks:
            return
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):  # pragma: no cover - best-effort logging
                logger.warning("Alert notification delivery failed: %s", result)

    async def _get_http_client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=10.0)
        return self._http_client

    async def _send_webhook(self, event: AlertEvent) -> None:
        client = await self._get_http_client()
        payload = event.to_dict()
        await client.post(self._webhook_url, json=payload)

    async def _send_email(self, event: AlertEvent) -> None:
        config = self._smtp_config
        if config is None:
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._deliver_email, config, event)

    @staticmethod
    def _deliver_email(config: _SmtpConfig, event: AlertEvent) -> None:
        message = EmailMessage()
        subject_prefix = "RECOVERED" if event.recovered else event.severity.upper()
        message["Subject"] = f"[ProjectPlant] {subject_prefix}: {event.message}"
        message["From"] = config.email_from
        message["To"] = ", ".join(config.email_to)
        message.set_content(json.dumps(event.to_dict(), indent=2))

        smtp = smtplib.SMTP(config.host, config.port, timeout=15)
        try:
            if config.use_tls:
                smtp.starttls()
            if config.username:
                smtp.login(config.username, config.password or "")
            smtp.send_message(message)
        finally:
            try:
                smtp.quit()
            except Exception:  # pragma: no cover - best-effort cleanup
                smtp.close()

alerts_service = AlertService()

__all__ = ["AlertService", "AlertEvent", "alerts_service"]
