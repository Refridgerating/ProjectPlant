from __future__ import annotations

from datetime import datetime
from pathlib import Path
import shutil
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from services.commands import command_service
from care_engine.schedules import ScheduleTimer
from services.plant_schedule import PlantScheduleService, plant_schedule_service
from services.pump_status import PumpStatusSnapshot, pump_status_cache
from services.schedule_timezone import ScheduleTimezoneInfo

ROOT = Path(__file__).resolve().parents[1]


def _local_time(hour: int, minute: int = 0) -> datetime:
    return datetime.now().astimezone().replace(hour=hour, minute=minute, second=0, microsecond=0)


def _make_runtime_dir() -> Path:
    runtime_dir = ROOT / "data" / f"test-plant-schedule-{uuid4().hex}"
    runtime_dir.mkdir(parents=True, exist_ok=False)
    return runtime_dir


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


@pytest.mark.anyio
async def test_sync_schedule_to_device_includes_schedule_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime_dir = _make_runtime_dir()
    try:
        service = PlantScheduleService(path=str(runtime_dir / "schedules.json"))
        schedule = service.update_schedule(
            "pot-schedule-sync",
            light=ScheduleTimer(enabled=True, start_time="06:00", end_time="18:00"),
            pump=ScheduleTimer(enabled=False, start_time="07:00", end_time="07:15"),
            ic_zone1=ScheduleTimer(enabled=True, start_time="08:00", end_time="08:30"),
            mister=ScheduleTimer(enabled=False, start_time="08:00", end_time="08:15"),
            fan=ScheduleTimer(enabled=True, start_time="10:00", end_time="22:00"),
        )
        set_device_schedule = AsyncMock()
        monkeypatch.setattr(command_service, "set_device_schedule", set_device_schedule)
        monkeypatch.setattr(
            service,
            "_current_schedule_timezone_info",
            lambda: ScheduleTimezoneInfo(
                offset_minutes=-240,
                posix_tz="EST5EDT,M3.2.0/2,M11.1.0/2",
                zone_name="America/New_York",
                source="timezone-file",
            ),
        )

        synced = await service.sync_schedule_to_device(schedule)

        assert synced is True
        kwargs = set_device_schedule.await_args.kwargs
        assert kwargs["tz_offset_minutes"] == -240
        assert kwargs["schedule_timezone_posix"] == "EST5EDT,M3.2.0/2,M11.1.0/2"
        assert kwargs["schedule"]["icZone1"] == {"enabled": True, "startTime": "08:00", "endTime": "08:30"}
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_sync_pending_schedule_updates_republishes_on_offset_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_dir = _make_runtime_dir()
    try:
        service = PlantScheduleService(path=str(runtime_dir / "schedules.json"))
        service.update_schedule(
            "pot-schedule-offset",
            light=ScheduleTimer(enabled=True, start_time="06:00", end_time="18:00"),
            pump=ScheduleTimer(enabled=False, start_time="07:00", end_time="07:15"),
            mister=ScheduleTimer(enabled=False, start_time="08:00", end_time="08:15"),
            fan=ScheduleTimer(enabled=True, start_time="10:00", end_time="22:00"),
        )

        timezone_state = {
            "info": ScheduleTimezoneInfo(
                offset_minutes=-300,
                posix_tz="EST5EDT,M3.2.0/2,M11.1.0/2",
                zone_name="America/New_York",
                source="timezone-file",
            )
        }
        set_device_schedule = AsyncMock()
        monkeypatch.setattr(command_service, "set_device_schedule", set_device_schedule)
        monkeypatch.setattr(service, "_current_schedule_timezone_info", lambda: timezone_state["info"])

        await service._sync_pending_schedule_updates()
        assert set_device_schedule.await_count == 1

        await service._sync_pending_schedule_updates()
        assert set_device_schedule.await_count == 1

        timezone_state["info"] = ScheduleTimezoneInfo(
            offset_minutes=-240,
            posix_tz="EST5EDT,M3.2.0/2,M11.1.0/2",
            zone_name="America/New_York",
            source="timezone-file",
        )
        await service._sync_pending_schedule_updates()

        assert set_device_schedule.await_count == 2
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)
