from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Literal, Mapping, Optional

from config import settings
from services.commands import CommandServiceError, CommandTimeoutError, command_service
from services.pot_ids import normalize_pot_id
from services.pump_status import PumpStatusSnapshot, pump_status_cache

logger = logging.getLogger("projectplant.hub.plant_schedule")

TimerActuator = Literal["light", "pump", "mister", "fan"]
SCHEDULED_ACTUATORS: tuple[TimerActuator, ...] = ("light", "pump", "mister", "fan")
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

DEFAULT_TIMER_WINDOWS: dict[TimerActuator, tuple[str, str]] = {
    "light": ("06:00", "20:00"),
    "pump": ("07:00", "07:15"),
    "mister": ("08:00", "08:15"),
    "fan": ("09:00", "18:00"),
}


def _utc_now_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return iso.replace("+00:00", "Z")


def _normalize_required_pot_id(value: str) -> str:
    normalized = normalize_pot_id(value)
    if not normalized:
        raise ValueError("pot_id is required")
    return normalized


def _normalize_time(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if TIME_PATTERN.fullmatch(candidate):
            return candidate
    return fallback


def _time_to_minutes(value: str) -> int:
    hours_text, minutes_text = value.split(":")
    return int(hours_text) * 60 + int(minutes_text)


@dataclass(frozen=True, slots=True)
class ScheduleTimer:
    enabled: bool
    start_time: str
    end_time: str

    @classmethod
    def default(cls, actuator: TimerActuator) -> "ScheduleTimer":
        start_time, end_time = DEFAULT_TIMER_WINDOWS[actuator]
        return cls(enabled=False, start_time=start_time, end_time=end_time)

    @classmethod
    def from_payload(
        cls,
        payload: Mapping[str, Any] | None,
        *,
        fallback: "ScheduleTimer",
    ) -> "ScheduleTimer":
        if not isinstance(payload, Mapping):
            return fallback
        enabled_value = payload.get("enabled")
        start_value = payload.get("startTime")
        end_value = payload.get("endTime")
        return cls(
            enabled=enabled_value if isinstance(enabled_value, bool) else fallback.enabled,
            start_time=_normalize_time(start_value, fallback.start_time),
            end_time=_normalize_time(end_value, fallback.end_time),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "startTime": self.start_time,
            "endTime": self.end_time,
        }

    def is_active(self, minute_of_day: int) -> bool:
        if not self.enabled:
            return False
        start_minutes = _time_to_minutes(self.start_time)
        end_minutes = _time_to_minutes(self.end_time)
        if start_minutes == end_minutes:
            return True
        if start_minutes < end_minutes:
            return start_minutes <= minute_of_day < end_minutes
        return minute_of_day >= start_minutes or minute_of_day < end_minutes


@dataclass(frozen=True, slots=True)
class PotSchedule:
    pot_id: str
    light: ScheduleTimer
    pump: ScheduleTimer
    mister: ScheduleTimer
    fan: ScheduleTimer
    updated_at: str

    @classmethod
    def default(cls, pot_id: str) -> "PotSchedule":
        normalized = _normalize_required_pot_id(pot_id)
        return cls(
            pot_id=normalized,
            light=ScheduleTimer.default("light"),
            pump=ScheduleTimer.default("pump"),
            mister=ScheduleTimer.default("mister"),
            fan=ScheduleTimer.default("fan"),
            updated_at=_utc_now_iso(),
        )

    @classmethod
    def from_payload(
        cls,
        pot_id: str,
        payload: Mapping[str, Any] | None,
        *,
        fallback: "PotSchedule" | None = None,
        updated_at: str | None = None,
    ) -> "PotSchedule":
        normalized = _normalize_required_pot_id(pot_id)
        baseline = fallback or cls.default(normalized)
        raw = payload if isinstance(payload, Mapping) else {}
        light = ScheduleTimer.from_payload(raw.get("light"), fallback=baseline.light)
        pump = ScheduleTimer.from_payload(raw.get("pump"), fallback=baseline.pump)
        mister = ScheduleTimer.from_payload(raw.get("mister"), fallback=baseline.mister)
        fan = ScheduleTimer.from_payload(raw.get("fan"), fallback=baseline.fan)
        schedule_updated_at = updated_at or _utc_now_iso()
        return cls(
            pot_id=normalized,
            light=light,
            pump=pump,
            mister=mister,
            fan=fan,
            updated_at=schedule_updated_at,
        )

    def timer_for(self, actuator: TimerActuator) -> ScheduleTimer:
        if actuator == "light":
            return self.light
        if actuator == "pump":
            return self.pump
        if actuator == "mister":
            return self.mister
        return self.fan

    def to_payload(self) -> dict[str, object]:
        return {
            "potId": self.pot_id,
            "light": self.light.to_payload(),
            "pump": self.pump.to_payload(),
            "mister": self.mister.to_payload(),
            "fan": self.fan.to_payload(),
            "updatedAt": self.updated_at,
        }


class PlantScheduleStore:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._lock = RLock()
        self._loaded = False
        self._schedules: dict[str, PotSchedule] = {}

    def get(self, pot_id: str) -> PotSchedule:
        normalized = _normalize_required_pot_id(pot_id)
        self._ensure_loaded()
        with self._lock:
            existing = self._schedules.get(normalized)
            if existing is not None:
                return existing
        return PotSchedule.default(normalized)

    def upsert(self, schedule: PotSchedule) -> PotSchedule:
        self._ensure_loaded()
        with self._lock:
            self._schedules[schedule.pot_id] = schedule
            self._save_locked()
            return schedule

    def list(self) -> list[PotSchedule]:
        self._ensure_loaded()
        with self._lock:
            return list(self._schedules.values())

    def reset(self) -> None:
        with self._lock:
            self._loaded = True
            self._schedules = {}
            try:
                self._path.unlink(missing_ok=True)
            except OSError:
                logger.debug("Unable to remove schedule file during reset", exc_info=True)

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
            self._schedules = {}
            if not self._path.exists():
                return
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to load plant schedules: %s", exc)
                return
            if not isinstance(raw, Mapping):
                return
            schedule_payloads = raw.get("pots", raw)
            if not isinstance(schedule_payloads, Mapping):
                return
            entries: dict[str, PotSchedule] = {}
            for pot_key, candidate in schedule_payloads.items():
                if not isinstance(pot_key, str):
                    continue
                normalized = normalize_pot_id(pot_key)
                if not normalized:
                    continue
                if not isinstance(candidate, Mapping):
                    continue
                updated_at = candidate.get("updatedAt")
                schedule = PotSchedule.from_payload(
                    normalized,
                    candidate,
                    updated_at=updated_at if isinstance(updated_at, str) and updated_at.strip() else _utc_now_iso(),
                )
                entries[normalized] = schedule
            self._schedules = entries

    def _save_locked(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("Failed to create schedule directory %s: %s", self._path.parent, exc)
            return
        payload = {
            "version": 1,
            "pots": {pot_id: schedule.to_payload() for pot_id, schedule in self._schedules.items()},
        }
        try:
            self._path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
        except OSError as exc:
            logger.warning("Failed to persist plant schedules: %s", exc)


class PlantScheduleService:
    def __init__(
        self,
        *,
        path: str,
        interval_seconds: float = 30.0,
        command_timeout_seconds: float = 5.0,
    ) -> None:
        self._store = PlantScheduleStore(path)
        self._interval_seconds = max(5.0, float(interval_seconds))
        self._command_timeout_seconds = max(0.1, float(command_timeout_seconds))
        self._scheduler_task: Optional[asyncio.Task[None]] = None
        self._scheduler_stop: Optional[asyncio.Event] = None
        self._apply_lock = asyncio.Lock()
        self._last_applied: dict[tuple[str, TimerActuator], bool] = {}

    def get_schedule(self, pot_id: str) -> PotSchedule:
        return self._store.get(pot_id)

    def update_schedule(
        self,
        pot_id: str,
        *,
        light: ScheduleTimer,
        pump: ScheduleTimer,
        mister: ScheduleTimer,
        fan: ScheduleTimer,
    ) -> PotSchedule:
        normalized = _normalize_required_pot_id(pot_id)
        schedule = PotSchedule(
            pot_id=normalized,
            light=light,
            pump=pump,
            mister=mister,
            fan=fan,
            updated_at=_utc_now_iso(),
        )
        stored = self._store.upsert(schedule)
        for actuator in SCHEDULED_ACTUATORS:
            self._last_applied.pop((normalized, actuator), None)
        return stored

    async def apply_schedule_now(self, pot_id: str | None = None, *, now: datetime | None = None) -> None:
        effective_now = now.astimezone() if now is not None else datetime.now().astimezone()
        minute_of_day = effective_now.hour * 60 + effective_now.minute
        if pot_id:
            schedules = [self._store.get(pot_id)]
        else:
            schedules = self._store.list()
        if not schedules:
            return
        async with self._apply_lock:
            for schedule in schedules:
                await self._apply_schedule_for_pot(schedule, minute_of_day)

    async def start_scheduler(self) -> None:
        if not settings.mqtt_enabled:
            return
        if self._scheduler_task is not None and not self._scheduler_task.done():
            return
        self._scheduler_stop = asyncio.Event()
        self._scheduler_task = asyncio.create_task(self._scheduler_loop(), name="plant-schedule")
        logger.info("Plant schedule scheduler started (interval=%.1fs)", self._interval_seconds)

    async def stop_scheduler(self) -> None:
        if self._scheduler_task is None:
            return
        stop_event = self._scheduler_stop
        if stop_event is not None:
            stop_event.set()
        task = self._scheduler_task
        self._scheduler_task = None
        self._scheduler_stop = None
        try:
            await task
        except asyncio.CancelledError:  # pragma: no cover - cooperative cancellation
            pass
        except Exception as exc:  # pragma: no cover - defensive logging
            logger.warning("Plant schedule scheduler terminated with error: %s", exc)
        else:
            logger.info("Plant schedule scheduler stopped")

    async def close(self) -> None:
        await self.stop_scheduler()

    def reset(self) -> None:
        self._last_applied.clear()
        self._store.reset()

    async def _scheduler_loop(self) -> None:
        assert self._scheduler_stop is not None
        stop_event = self._scheduler_stop
        while not stop_event.is_set():
            try:
                await self.apply_schedule_now()
            except Exception as exc:  # pragma: no cover - defensive logging
                logger.warning("Plant schedule run failed: %s", exc)
            if stop_event.is_set():
                break
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_seconds)
            except asyncio.TimeoutError:
                continue
        logger.debug("Plant schedule scheduler loop exiting")

    async def _apply_schedule_for_pot(self, schedule: PotSchedule, minute_of_day: int) -> None:
        snapshot = pump_status_cache.get(schedule.pot_id)
        for actuator in SCHEDULED_ACTUATORS:
            desired_on = schedule.timer_for(actuator).is_active(minute_of_day)
            key = (schedule.pot_id, actuator)
            observed_state = self._state_from_snapshot(snapshot, actuator)
            if isinstance(observed_state, bool):
                self._last_applied[key] = observed_state
            previous_state = self._last_applied.get(key)
            if previous_state is not None and previous_state == desired_on:
                continue
            command_applied = await self._send_override(schedule.pot_id, actuator, desired_on)
            if command_applied:
                self._last_applied[key] = desired_on

    @staticmethod
    def _state_from_snapshot(
        snapshot: PumpStatusSnapshot | None,
        actuator: TimerActuator,
    ) -> bool | None:
        if snapshot is None:
            return None
        if actuator == "light":
            return snapshot.light_on
        if actuator == "pump":
            return snapshot.pump_on
        if actuator == "mister":
            return snapshot.mister_on
        return snapshot.fan_on

    async def _send_override(self, pot_id: str, actuator: TimerActuator, desired_on: bool) -> bool:
        try:
            if actuator == "light":
                await command_service.send_light_override(
                    pot_id,
                    light_on=desired_on,
                    timeout=self._command_timeout_seconds,
                )
            elif actuator == "pump":
                await command_service.send_pump_override(
                    pot_id,
                    pump_on=desired_on,
                    timeout=self._command_timeout_seconds,
                )
            elif actuator == "mister":
                await command_service.send_mister_override(
                    pot_id,
                    mister_on=desired_on,
                    timeout=self._command_timeout_seconds,
                )
            else:
                await command_service.send_fan_override(
                    pot_id,
                    fan_on=desired_on,
                    timeout=self._command_timeout_seconds,
                )
            logger.info(
                "Applied scheduled %s state for %s -> %s",
                actuator,
                pot_id,
                "on" if desired_on else "off",
            )
            return True
        except (CommandServiceError, CommandTimeoutError, ValueError) as exc:
            logger.warning(
                "Failed to apply scheduled %s state for %s -> %s: %s",
                actuator,
                pot_id,
                "on" if desired_on else "off",
                exc,
            )
            return False


plant_schedule_service = PlantScheduleService(
    path=settings.plant_schedule_path,
    interval_seconds=settings.plant_schedule_interval_seconds,
    command_timeout_seconds=settings.plant_schedule_command_timeout_seconds,
)

__all__ = [
    "PotSchedule",
    "ScheduleTimer",
    "SCHEDULED_ACTUATORS",
    "TIME_PATTERN",
    "plant_schedule_service",
]
