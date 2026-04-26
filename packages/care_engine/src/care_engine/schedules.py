from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Mapping

TimerActuator = Literal["light", "pump", "ic_zone1", "mister", "fan"]
SCHEDULED_ACTUATORS: tuple[TimerActuator, ...] = ("light", "pump", "ic_zone1", "mister", "fan")
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

DEFAULT_TIMER_WINDOWS: dict[TimerActuator, tuple[str, str]] = {
    "light": ("06:00", "20:00"),
    "pump": ("07:00", "07:15"),
    "ic_zone1": ("07:00", "07:15"),
    "mister": ("08:00", "08:15"),
    "fan": ("09:00", "18:00"),
}


def utc_now_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return iso.replace("+00:00", "Z")


def normalize_pot_id(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower()
    return normalized or None


def normalize_required_pot_id(value: str) -> str:
    normalized = normalize_pot_id(value)
    if not normalized:
        raise ValueError("pot_id is required")
    return normalized


def normalize_time(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if TIME_PATTERN.fullmatch(candidate):
            return candidate
    return fallback


def time_to_minutes(value: str) -> int:
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
            start_time=normalize_time(start_value, fallback.start_time),
            end_time=normalize_time(end_value, fallback.end_time),
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
        start_minutes = time_to_minutes(self.start_time)
        end_minutes = time_to_minutes(self.end_time)
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
    ic_zone1: ScheduleTimer
    mister: ScheduleTimer
    fan: ScheduleTimer
    updated_at: str

    @classmethod
    def default(cls, pot_id: str) -> "PotSchedule":
        normalized = normalize_required_pot_id(pot_id)
        return cls(
            pot_id=normalized,
            light=ScheduleTimer.default("light"),
            pump=ScheduleTimer.default("pump"),
            ic_zone1=ScheduleTimer.default("ic_zone1"),
            mister=ScheduleTimer.default("mister"),
            fan=ScheduleTimer.default("fan"),
            updated_at=utc_now_iso(),
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
        normalized = normalize_required_pot_id(pot_id)
        baseline = fallback or cls.default(normalized)
        raw = payload if isinstance(payload, Mapping) else {}
        light = ScheduleTimer.from_payload(raw.get("light"), fallback=baseline.light)
        pump = ScheduleTimer.from_payload(raw.get("pump"), fallback=baseline.pump)
        ic_zone1_payload = raw.get("icZone1", raw.get("ic_zone1"))
        ic_zone1 = ScheduleTimer.from_payload(ic_zone1_payload, fallback=baseline.ic_zone1)
        mister = ScheduleTimer.from_payload(raw.get("mister"), fallback=baseline.mister)
        fan = ScheduleTimer.from_payload(raw.get("fan"), fallback=baseline.fan)
        return cls(
            pot_id=normalized,
            light=light,
            pump=pump,
            ic_zone1=ic_zone1,
            mister=mister,
            fan=fan,
            updated_at=updated_at or utc_now_iso(),
        )

    def timer_for(self, actuator: TimerActuator) -> ScheduleTimer:
        if actuator == "light":
            return self.light
        if actuator == "pump":
            return self.pump
        if actuator == "ic_zone1":
            return self.ic_zone1
        if actuator == "mister":
            return self.mister
        return self.fan

    def to_payload(self) -> dict[str, object]:
        return {
            "potId": self.pot_id,
            "light": self.light.to_payload(),
            "pump": self.pump.to_payload(),
            "icZone1": self.ic_zone1.to_payload(),
            "mister": self.mister.to_payload(),
            "fan": self.fan.to_payload(),
            "updatedAt": self.updated_at,
        }


def desired_actuator_states(schedule: PotSchedule, minute_of_day: int) -> dict[TimerActuator, bool]:
    return {actuator: schedule.timer_for(actuator).is_active(minute_of_day) for actuator in SCHEDULED_ACTUATORS}
