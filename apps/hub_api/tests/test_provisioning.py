import asyncio
import time

import pytest
from fastapi import HTTPException

from api.v1.provision_router import ProvisionWaitRequest, provision_wait
from services.provisioning import normalize_device_id, provisioning_store


def test_normalize_device_id() -> None:
    assert normalize_device_id("aa-bb-cc-11-22-33") == "AABBCC112233"
    assert normalize_device_id("AABB.CCDD.EEFF") == "AABBCCDDEEFF"
    assert normalize_device_id("invalid") is None


@pytest.mark.anyio
async def test_wait_for_device_success() -> None:
    await provisioning_store.clear()

    async def _trigger_state() -> None:
        await asyncio.sleep(0.05)
        await provisioning_store.record_state(
            device_id="aa:bb:cc:11:22:33",
            topic="plant/AABBCC112233/state",
            payload="online",
            retained=False,
        )

    trigger = asyncio.create_task(_trigger_state())
    event, elapsed = await provisioning_store.wait_for_device(
        timeout=2.0,
        device_id="aa:bb:cc:11:22:33",
        require_fresh=True,
        method="ble",
    )
    await trigger

    assert event is not None
    assert event.device.id == "AABBCC112233"
    assert event.device.fresh is True
    assert event.device.retained is False
    assert event.device.method == "ble"
    assert elapsed >= 0.0
    assert elapsed < 2.0


@pytest.mark.anyio
async def test_provision_wait_timeout() -> None:
    await provisioning_store.clear()
    request = ProvisionWaitRequest(timeout=0.6, require_fresh=True)
    start = time.time()
    response = await provision_wait(request)
    elapsed = time.time() - start
    assert response.status == "timeout"
    assert response.device is None
    assert response.elapsed >= 0.5
    assert elapsed < 1.5


@pytest.mark.anyio
async def test_provision_wait_returns_device() -> None:
    await provisioning_store.clear()

    async def _trigger_state() -> None:
        await asyncio.sleep(0.05)
        await provisioning_store.record_state(
            device_id="11:22:33:44:55:66",
            topic="plant/112233445566/state",
            payload="online",
            retained=False,
        )

    trigger = asyncio.create_task(_trigger_state())
    request = ProvisionWaitRequest(timeout=1.5, require_fresh=True, device_id="11:22:33:44:55:66", method="BLE")
    response = await provision_wait(request)
    await trigger

    assert response.status == "online"
    assert response.device is not None
    assert response.device.id == "112233445566"
    assert response.device.fresh is True
    assert response.device.topic == "plant/112233445566/state"
    assert response.method == "ble"


@pytest.mark.anyio
async def test_provision_wait_rejects_invalid_device() -> None:
    await provisioning_store.clear()
    request = ProvisionWaitRequest(timeout=0.6, require_fresh=True, device_id="bad")
    with pytest.raises(HTTPException) as excinfo:
        await provision_wait(request)
    assert excinfo.value.status_code == 422
