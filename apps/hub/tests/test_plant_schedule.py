from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from services.commands import command_service
from services.plant_schedule import ScheduleTimer, plant_schedule_service
from services.pump_status import PumpStatusSnapshot, pump_status_cache


def _local_time(hour: int, minute: int = 0) -> datetime:
    return datetime.now().astimezone().replace(hour=hour, minute=minute, second=0, microsecond=0)


@pytest.mark.anyio
async def test_apply_schedule_now_turns_on_active_devices(monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-schedule-active"
    plant_schedule_service.update_schedule(
        pot_id,
        light=ScheduleTimer(enabled=True, start_time="06:00", end_time="18:00"),
        pump=ScheduleTimer(enabled=False, start_time="07:00", end_time="07:15"),
        mister=ScheduleTimer(enabled=True, start_time="11:00", end_time="13:00"),
        fan=ScheduleTimer(enabled=True, start_time="10:00", end_time="22:00"),
    )
    pump_status_cache.update(
        PumpStatusSnapshot(
            pot_id=pot_id,
            status="idle",
            pump_on=False,
            fan_on=False,
            mister_on=False,
            light_on=False,
            request_id=None,
            timestamp="2026-02-11T12:00:00.000Z",
            timestamp_ms=1_707_648_000_000,
            received_at="2026-02-11T12:00:00.000Z",
        )
    )

    light_override = AsyncMock()
    fan_override = AsyncMock()
    pump_override = AsyncMock()
    mister_override = AsyncMock()
    monkeypatch.setattr(command_service, "send_light_override", light_override)
    monkeypatch.setattr(command_service, "send_fan_override", fan_override)
    monkeypatch.setattr(command_service, "send_pump_override", pump_override)
    monkeypatch.setattr(command_service, "send_mister_override", mister_override)

    await plant_schedule_service.apply_schedule_now(pot_id, now=_local_time(12, 0))

    light_override.assert_awaited_once()
    assert light_override.await_args.args == (pot_id,)
    assert light_override.await_args.kwargs["light_on"] is True

    fan_override.assert_awaited_once()
    assert fan_override.await_args.args == (pot_id,)
    assert fan_override.await_args.kwargs["fan_on"] is True

    mister_override.assert_awaited_once()
    assert mister_override.await_args.args == (pot_id,)
    assert mister_override.await_args.kwargs["mister_on"] is True

    pump_override.assert_not_awaited()


@pytest.mark.anyio
async def test_apply_schedule_now_turns_off_when_observed_state_drifts(monkeypatch: pytest.MonkeyPatch) -> None:
    pot_id = "pot-schedule-drift"
    plant_schedule_service.update_schedule(
        pot_id,
        light=ScheduleTimer(enabled=True, start_time="06:00", end_time="12:00"),
        pump=ScheduleTimer(enabled=False, start_time="07:00", end_time="07:15"),
        mister=ScheduleTimer(enabled=False, start_time="08:00", end_time="08:15"),
        fan=ScheduleTimer(enabled=False, start_time="09:00", end_time="18:00"),
    )
    pump_status_cache.update(
        PumpStatusSnapshot(
            pot_id=pot_id,
            status="light_on",
            pump_on=False,
            fan_on=False,
            mister_on=False,
            light_on=True,
            request_id=None,
            timestamp="2026-02-11T23:40:00.000Z",
            timestamp_ms=1_707_697_200_000,
            received_at="2026-02-11T23:40:00.000Z",
        )
    )

    light_override = AsyncMock()
    monkeypatch.setattr(command_service, "send_light_override", light_override)
    monkeypatch.setattr(command_service, "send_fan_override", AsyncMock())
    monkeypatch.setattr(command_service, "send_pump_override", AsyncMock())
    monkeypatch.setattr(command_service, "send_mister_override", AsyncMock())

    await plant_schedule_service.apply_schedule_now(pot_id, now=_local_time(23, 40))

    light_override.assert_awaited_once()
    assert light_override.await_args.args == (pot_id,)
    assert light_override.await_args.kwargs["light_on"] is False
