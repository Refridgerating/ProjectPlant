from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from care_engine.schedules import PotSchedule, ScheduleTimer, desired_actuator_states


def test_schedule_timer_handles_overnight_windows() -> None:
    timer = ScheduleTimer(enabled=True, start_time="22:00", end_time="06:00")

    assert timer.is_active(23 * 60)
    assert timer.is_active(5 * 60 + 59)
    assert not timer.is_active(12 * 60)


def test_pot_schedule_normalizes_payload_and_defaults() -> None:
    schedule = PotSchedule.from_payload(
        " Pot-A ",
        {
            "light": {"enabled": True, "startTime": "06:15", "endTime": "19:45"},
            "pump": {"enabled": True, "startTime": "bad", "endTime": "07:30"},
            "icZone1": {"enabled": True, "startTime": "08:00", "endTime": "08:15"},
        },
        updated_at="2026-04-24T12:00:00Z",
    )

    assert schedule.pot_id == "pot-a"
    assert schedule.light.start_time == "06:15"
    assert schedule.pump.start_time == "07:00"
    assert schedule.ic_zone1.enabled is True
    assert schedule.to_payload()["updatedAt"] == "2026-04-24T12:00:00Z"


def test_desired_actuator_states_returns_all_actuators() -> None:
    schedule = PotSchedule.from_payload(
        "pot-a",
        {"light": {"enabled": True, "startTime": "06:00", "endTime": "20:00"}},
    )

    states = desired_actuator_states(schedule, 12 * 60)

    assert states == {
        "light": True,
        "pump": False,
        "ic_zone1": False,
        "mister": False,
        "fan": False,
    }
