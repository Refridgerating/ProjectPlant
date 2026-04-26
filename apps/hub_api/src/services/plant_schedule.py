from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Mapping, Optional

from care_engine.schedules import (
    SCHEDULED_ACTUATORS,
    TIME_PATTERN,
    PotSchedule,
    ScheduleTimer,
    TimerActuator,
    normalize_required_pot_id,
    utc_now_iso,
)
from config import settings
from services.commands import CommandServiceError, CommandTimeoutError, command_service
from services.pot_ids import normalize_pot_id
from services.pump_status import PumpStatusSnapshot, pump_status_cache
from services.schedule_timezone import ScheduleTimezoneInfo, resolve_schedule_timezone_info

logger = logging.getLogger("projectplant.hub.plant_schedule")

DEFAULT_MANUAL_OVERRIDE_DURATION_MS = 100_000


def _utc_now_iso() -> str:
    return utc_now_iso()

def _isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _iso_to_epoch_ms(value: str | None) -> int | None:
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _epoch_ms_to_iso(value: int) -> str:
    dt = datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
    return _isoformat_utc(dt)


def _normalize_required_pot_id(value: str) -> str:
    return normalize_required_pot_id(value)


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

    def get_existing(self, pot_id: str) -> PotSchedule | None:
        normalized = _normalize_required_pot_id(pot_id)
        self._ensure_loaded()
        with self._lock:
            return self._schedules.get(normalized)

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
        self._manual_overrides: dict[tuple[str, TimerActuator], float] = {}
        self._last_synced_timezone_signature_by_pot: dict[str, tuple[int, str | None]] = {}
        self._last_logged_timezone_state: tuple[str, str | None, str | None] | None = None
        self._last_logged_timezone_signature: tuple[int, str | None] | None = None

    def get_schedule(self, pot_id: str) -> PotSchedule:
        return self._store.get(pot_id)

    def update_schedule(
        self,
        pot_id: str,
        *,
        light: ScheduleTimer,
        pump: ScheduleTimer,
        ic_zone1: ScheduleTimer | None = None,
        mister: ScheduleTimer,
        fan: ScheduleTimer,
    ) -> PotSchedule:
        normalized = _normalize_required_pot_id(pot_id)
        schedule = PotSchedule(
            pot_id=normalized,
            light=light,
            pump=pump,
            ic_zone1=ic_zone1 or ScheduleTimer.default("ic_zone1"),
            mister=mister,
            fan=fan,
            updated_at=_utc_now_iso(),
        )
        stored = self._store.upsert(schedule)
        self._clear_last_applied_for_pot(normalized)
        self._invalidate_synced_timezone_for_pot(normalized)
        return stored

    def _clear_last_applied_for_pot(self, pot_id: str) -> None:
        for actuator in SCHEDULED_ACTUATORS:
            self._last_applied.pop((pot_id, actuator), None)

    def _invalidate_synced_timezone_for_pot(self, pot_id: str) -> None:
        self._last_synced_timezone_signature_by_pot.pop(pot_id, None)

    def set_manual_override(
        self,
        pot_id: str,
        actuator: TimerActuator,
        *,
        on: bool,
        duration_ms: float | int | None = None,
    ) -> None:
        normalized = _normalize_required_pot_id(pot_id)
        key = (normalized, actuator)

        if not on:
            self._manual_overrides.pop(key, None)
            logger.info("Cleared hub manual override for %s actuator %s", normalized, actuator)
            return

        effective_duration_ms = DEFAULT_MANUAL_OVERRIDE_DURATION_MS
        if duration_ms is not None:
            effective_duration_ms = max(1, int(duration_ms))

        self._manual_overrides[key] = time.monotonic() + (effective_duration_ms / 1000.0)
        logger.info(
            "Armed hub manual override for %s actuator %s (durationMs=%d)",
            normalized,
            actuator,
            effective_duration_ms,
        )

    def _has_manual_override(self, pot_id: str, actuator: TimerActuator) -> bool:
        key = (pot_id, actuator)
        expires_at = self._manual_overrides.get(key)
        if expires_at is None:
            return False
        if time.monotonic() >= expires_at:
            self._manual_overrides.pop(key, None)
            return False
        return True

    async def reconcile_device_schedule(
        self,
        pot_id: str,
        schedule_payload: Mapping[str, Any],
        *,
        updated_at_ms: int | None,
    ) -> None:
        if not isinstance(schedule_payload, Mapping):
            return

        normalized = _normalize_required_pot_id(pot_id)
        existing = self._store.get_existing(normalized)

        if updated_at_ms is None or updated_at_ms <= 0:
            if existing is None:
                schedule = PotSchedule.from_payload(
                    normalized,
                    schedule_payload,
                    updated_at=_utc_now_iso(),
                )
                self._store.upsert(schedule)
                self._clear_last_applied_for_pot(normalized)
                logger.info("Stored device schedule for %s without updatedAtMs", normalized)
            else:
                logger.debug("Ignoring device schedule for %s without updatedAtMs", pot_id)
            return

        device_updated_iso = _epoch_ms_to_iso(updated_at_ms)
        if existing is None:
            schedule = PotSchedule.from_payload(
                normalized,
                schedule_payload,
                updated_at=device_updated_iso,
            )
            self._store.upsert(schedule)
            self._clear_last_applied_for_pot(normalized)
            logger.info("Stored device schedule for %s (updatedAtMs=%d)", normalized, updated_at_ms)
            return

        hub_updated_ms = _iso_to_epoch_ms(existing.updated_at) or 0
        if updated_at_ms > hub_updated_ms:
            schedule = PotSchedule.from_payload(
                normalized,
                schedule_payload,
                fallback=existing,
                updated_at=device_updated_iso,
            )
            self._store.upsert(schedule)
            self._clear_last_applied_for_pot(normalized)
            logger.info("Applied newer device schedule for %s (updatedAtMs=%d)", normalized, updated_at_ms)
            return

        if hub_updated_ms > updated_at_ms:
            await self.sync_schedule_to_device(existing)

    async def sync_schedule_to_device(self, schedule: PotSchedule) -> bool:
        return await self._sync_schedule_to_device(schedule)

    async def _sync_schedule_to_device(
        self,
        schedule: PotSchedule,
        *,
        timezone_info: ScheduleTimezoneInfo | None = None,
    ) -> bool:
        effective_timezone = timezone_info or self._current_schedule_timezone_info()

        updated_at_ms = _iso_to_epoch_ms(schedule.updated_at)
        if updated_at_ms is None:
            updated_at_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

        schedule_payload = {
            "light": schedule.light.to_payload(),
            "pump": schedule.pump.to_payload(),
            "icZone1": schedule.ic_zone1.to_payload(),
            "mister": schedule.mister.to_payload(),
            "fan": schedule.fan.to_payload(),
        }

        try:
            await command_service.set_device_schedule(
                schedule.pot_id,
                schedule=schedule_payload,
                tz_offset_minutes=effective_timezone.offset_minutes,
                schedule_timezone_posix=effective_timezone.posix_tz,
                schedule_updated_at_ms=updated_at_ms,
                timeout=self._command_timeout_seconds,
            )
            self._last_synced_timezone_signature_by_pot[schedule.pot_id] = effective_timezone.signature
            logger.info(
                "Synced schedule config to %s (tzOffsetMinutes=%d scheduleTimezonePosix=%s)",
                schedule.pot_id,
                effective_timezone.offset_minutes,
                effective_timezone.posix_tz or "<none>",
            )
            return True
        except (CommandServiceError, CommandTimeoutError, ValueError) as exc:
            logger.warning("Failed to sync schedule config to %s: %s", schedule.pot_id, exc)
            return False

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
        await self._sync_pending_schedule_updates(force=True)
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
        self._manual_overrides.clear()
        self._last_synced_timezone_signature_by_pot.clear()
        self._last_logged_timezone_state = None
        self._last_logged_timezone_signature = None
        self._store.reset()

    async def _scheduler_loop(self) -> None:
        assert self._scheduler_stop is not None
        stop_event = self._scheduler_stop
        while not stop_event.is_set():
            try:
                await self._sync_pending_schedule_updates()
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
            if self._has_manual_override(schedule.pot_id, actuator):
                continue
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

    async def _sync_pending_schedule_updates(self, *, force: bool = False) -> None:
        schedules = self._store.list()
        if not schedules:
            return

        timezone_info = self._current_schedule_timezone_info()
        signature = timezone_info.signature
        for schedule in schedules:
            if not force and self._last_synced_timezone_signature_by_pot.get(schedule.pot_id) == signature:
                continue
            await self._sync_schedule_to_device(schedule, timezone_info=timezone_info)

    def _current_schedule_timezone_info(self) -> ScheduleTimezoneInfo:
        timezone_info = resolve_schedule_timezone_info(override=settings.plant_schedule_tz_posix)
        self._log_schedule_timezone_state(timezone_info)
        return timezone_info

    def _log_schedule_timezone_state(self, timezone_info: ScheduleTimezoneInfo) -> None:
        state = (timezone_info.source, timezone_info.zone_name, timezone_info.posix_tz)
        if state != self._last_logged_timezone_state:
            if timezone_info.posix_tz:
                logger.info(
                    "Resolved plant schedule timezone (source=%s zone=%s posix=%s)",
                    timezone_info.source,
                    timezone_info.zone_name or "<unknown>",
                    timezone_info.posix_tz,
                )
            else:
                logger.warning(
                    "No DST-aware plant schedule timezone resolved (source=%s zone=%s); falling back to tzOffsetMinutes only",
                    timezone_info.source,
                    timezone_info.zone_name or "<unknown>",
                )
            self._last_logged_timezone_state = state

        if timezone_info.signature != self._last_logged_timezone_signature:
            previous = self._last_logged_timezone_signature
            if previous is not None:
                logger.info(
                    "Plant schedule timezone signature changed (tzOffsetMinutes=%d->%d scheduleTimezonePosix=%s->%s)",
                    previous[0],
                    timezone_info.offset_minutes,
                    previous[1] or "<none>",
                    timezone_info.posix_tz or "<none>",
                )
            self._last_logged_timezone_signature = timezone_info.signature

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
        if actuator == "ic_zone1":
            return snapshot.ic_zone1_on
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
            elif actuator == "ic_zone1":
                await command_service.send_ic_zone1_override(
                    pot_id,
                    zone_on=desired_on,
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
