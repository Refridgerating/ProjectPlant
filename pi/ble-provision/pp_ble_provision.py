#!/usr/bin/env python3
import asyncio
import os
import subprocess
import time
from typing import Dict, Optional, List

from dbus_next import Variant, BusType
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method, dbus_property


# BlueZ interface constants
BLUEZ_SERVICE_NAME = "org.bluez"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"


# ProjectPlant custom UUIDs (128-bit). Base + characteristic offsets
# Base Service UUID for provisioning
PP_SERVICE_UUID = "7f1e0000-8536-4d33-9b3b-2df3f9f0a900"

PP_CHAR_UUIDS = {
    "PP-STATE": "7f1e0001-8536-4d33-9b3b-2df3f9f0a900",   # read/notify
    "PP-SCAN":  "7f1e0002-8536-4d33-9b3b-2df3f9f0a900",   # read
    "PP-SSID":  "7f1e0003-8536-4d33-9b3b-2df3f9f0a900",   # write
    "PP-PASS":  "7f1e0004-8536-4d33-9b3b-2df3f9f0a900",   # write-only
    "PP-APPLY": "7f1e0005-8536-4d33-9b3b-2df3f9f0a900",   # write
    "PP-RESULT":"7f1e0006-8536-4d33-9b3b-2df3f9f0a900",   # read/notify
    "PP-POP":   "7f1e0007-8536-4d33-9b3b-2df3f9f0a900",   # read
}


def b(s: str) -> bytes:
    return s.encode("utf-8")


class GattService(ServiceInterface):
    def __init__(self, index: int, uuid: str, primary: bool = True):
        super().__init__(GATT_SERVICE_IFACE)
        self.index = index
        self.path = f"/org/projectplant/ble/service{index}"
        self.uuid = uuid
        self.primary = primary
        self.characteristics: List["GattCharacteristic"] = []

    def get_path(self) -> str:
        return self.path

    def add_characteristic(self, chrc: "GattCharacteristic") -> None:
        self.characteristics.append(chrc)

    @dbus_property()
    def UUID(self) -> "s":
        return self.uuid

    @dbus_property()
    def Primary(self) -> "b":
        return self.primary

    @dbus_property()
    def Includes(self) -> "ao":
        return []


class GattCharacteristic(ServiceInterface):
    def __init__(self, service: GattService, index: int, uuid: str, flags: List[str]):
        super().__init__(GATT_CHRC_IFACE)
        self.service = service
        self.index = index
        self.path = f"{service.get_path()}/char{index}"
        self.uuid = uuid
        self.flags = flags
        self.notifying = False
        self._value = bytes()

    def get_path(self) -> str:
        return self.path

    @dbus_property()
    def UUID(self) -> "s":
        return self.uuid

    @dbus_property()
    def Service(self) -> "o":
        return self.service.get_path()

    @dbus_property()
    def Flags(self) -> "as":
        return self.flags

    # Not in the official interface, but BlueZ examples rely on Value for notify
    @dbus_property()
    def Value(self) -> "ay":
        return self._value

    def set_value(self, data: bytes):
        self._value = data
        if self.notifying:
            # Emit notification of value change
            self.emit_properties_changed({"Value": self._value})

    @method()
    def StartNotify(self):
        if self.notifying:
            return
        self.notifying = True
        # Push initial value when notifications start
        self.emit_properties_changed({"Value": self._value})

    @method()
    def StopNotify(self):
        self.notifying = False

    # To be overridden in subclass
    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        return self._value

    @method()
    def WriteValue(self, value: "ay", options: "a{sv}"):
        # Default: update and notify
        self.set_value(bytes(value))


class Advertisement(ServiceInterface):
    def __init__(self, index: int, service_uuids: List[str], local_name: str):
        super().__init__(LE_ADVERTISEMENT_IFACE)
        self.index = index
        self.path = f"/org/projectplant/ble/advertisement{index}"
        self.service_uuids = service_uuids
        self.local_name = local_name

    def get_path(self) -> str:
        return self.path

    @dbus_property()
    def Type(self) -> "s":
        return "peripheral"

    @dbus_property()
    def ServiceUUIDs(self) -> "as":
        return self.service_uuids

    @dbus_property()
    def LocalName(self) -> "s":
        return self.local_name

    @dbus_property()
    def Includes(self) -> "as":
        return ["tx-power"]

    @method()
    def Release(self):
        # Called by BlueZ when the advertisement is released
        pass


class ProvisioningState:
    def __init__(self):
        self.state = "idle"
        self.result = ""
        self.pending_ssid: Optional[str] = None
        self.pending_pass: Optional[str] = None
        self.last_pop_reads: Dict[str, float] = {}
        self.pop_value = self._read_pop()

    def _read_pop(self) -> str:
        path = "/etc/projectplant/pop"
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            # Fallback default (not secure). Install script will create a proper PoP.
            return "NOP"

    def touch_pop_read(self, device_path: Optional[str]):
        if device_path:
            self.last_pop_reads[device_path] = time.time()

    def has_recent_pop(self, device_path: Optional[str], ttl_sec: int = 300) -> bool:
        if not device_path:
            return False
        t = self.last_pop_reads.get(device_path)
        return bool(t and (time.time() - t) < ttl_sec)

    def rotate_pop(self) -> None:
        path = "/etc/projectplant/pop"
        try:
            # 16 random bytes -> hex string
            new_pop = os.urandom(16).hex()
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_pop)
            self.pop_value = new_pop
        except Exception:
            # Rotation failures should not break provisioning success flow
            pass


class PPStateCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 0, PP_CHAR_UUIDS["PP-STATE"], ["read", "notify"])
        self.prov = prov
        self.set_value(b(self.prov.state))

    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        return b(self.prov.state)

    def publish(self):
        self.set_value(b(self.prov.state))


class PPScanCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 1, PP_CHAR_UUIDS["PP-SCAN"], ["read"])
        self.prov = prov

    @staticmethod
    def _scan_wifi() -> str:
        try:
            # List of SSID:SIGNAL pairs, filter empty SSIDs, dedupe by SSID keeping max signal
            out = subprocess.run(
                ["nmcli", "-t", "-f", "SSID,SIGNAL", "dev", "wifi"],
                check=False,
                capture_output=True,
                text=True,
            )
            lines = [l.strip() for l in out.stdout.splitlines() if l.strip()]
            best: Dict[str, int] = {}
            for l in lines:
                if ":" not in l:
                    continue
                ssid, sig = l.split(":", 1)
                if not ssid:
                    continue
                try:
                    sval = int(sig)
                except ValueError:
                    sval = 0
                if ssid not in best or sval > best[ssid]:
                    best[ssid] = sval
            # Return as lines: SSID,SIGNAL
            return "\n".join(f"{k},{v}" for k, v in sorted(best.items(), key=lambda i: -i[1]))[:480]
        except Exception as e:
            return f"ERROR:{e}"

    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        res = self._scan_wifi()
        return b(res)


class PPSSIDCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 2, PP_CHAR_UUIDS["PP-SSID"], ["write"])
        self.prov = prov

    @method()
    def WriteValue(self, value: "ay", options: "a{sv}"):
        device = options.get("device")
        if isinstance(device, Variant):
            device = device.value
        if not self.prov.has_recent_pop(device):
            raise Exception("org.bluez.Error.NotAuthorized: PoP required")
        self.prov.pending_ssid = bytes(value).decode("utf-8", errors="ignore").strip()


class PPPASSCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 3, PP_CHAR_UUIDS["PP-PASS"], ["write", "write-without-response"])
        self.prov = prov

    @method()
    def WriteValue(self, value: "ay", options: "a{sv}"):
        device = options.get("device")
        if isinstance(device, Variant):
            device = device.value
        if not self.prov.has_recent_pop(device):
            raise Exception("org.bluez.Error.NotAuthorized: PoP required")
        self.prov.pending_pass = bytes(value).decode("utf-8", errors="ignore").strip()


class PPResultCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 4, PP_CHAR_UUIDS["PP-RESULT"], ["read", "notify"])
        self.prov = prov
        self.set_value(b(self.prov.result))

    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        return b(self.prov.result)

    def publish(self):
        self.set_value(b(self.prov.result))


class PPPOPCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState):
        super().__init__(service, 5, PP_CHAR_UUIDS["PP-POP"], ["read"])
        self.prov = prov

    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        device = options.get("device")
        if isinstance(device, Variant):
            device = device.value
        # Mark that this device has seen the PoP recently; used to authorize writes
        self.prov.touch_pop_read(device)
        return b(self.prov.pop_value)


class PPApplyCharacteristic(GattCharacteristic):
    def __init__(self, service: GattService, prov: ProvisioningState, state_chrc: PPStateCharacteristic, result_chrc: PPResultCharacteristic, on_success):
        super().__init__(service, 6, PP_CHAR_UUIDS["PP-APPLY"], ["write"])
        self.prov = prov
        self.state_chrc = state_chrc
        self.result_chrc = result_chrc
        self.on_success = on_success

    def _set_state(self, s: str):
        self.prov.state = s
        self.state_chrc.publish()

    def _set_result(self, r: str):
        self.prov.result = r
        self.result_chrc.publish()

    @staticmethod
    def _nmcli_connect(ssid: str, password: Optional[str]) -> subprocess.CompletedProcess:
        cmd = ["nmcli", "dev", "wifi", "connect", ssid, "ifname", "wlan0"]
        if password is not None and password != "":
            cmd.extend(["password", password])
        return subprocess.run(cmd, capture_output=True, text=True)

    @method()
    def WriteValue(self, value: "ay", options: "a{sv}"):
        device = options.get("device")
        if isinstance(device, Variant):
            device = device.value
        if not self.prov.has_recent_pop(device):
            raise Exception("org.bluez.Error.NotAuthorized: PoP required")
        # Trigger connect
        ssid = self.prov.pending_ssid or ""
        psk = self.prov.pending_pass or ""
        if not ssid:
            self._set_result("ERROR:SSID missing")
            return
        self._set_state("connecting")
        try:
            proc = self._nmcli_connect(ssid, psk)
            if proc.returncode == 0:
                self._set_result("OK")
                self._set_state("connected")
                # Attempt to start downstream services and stop BLE advertising
                try:
                    # Start services
                    subprocess.run(["systemctl", "start", "api.service"], check=False)
                    subprocess.run(["systemctl", "start", "mqtt.service"], check=False)
                    # Avahi advertisement unit installed by our installer
                    subprocess.run(["systemctl", "start", "projectplant-avahi.service"], check=False)
                except Exception:
                    pass
                # Success callback (e.g., stop advertising)
                try:
                    self.on_success()
                except Exception:
                    pass
                # Rotate PoP to prevent reuse
                try:
                    self.prov.rotate_pop()
                except Exception:
                    pass
            else:
                err = proc.stderr.strip().splitlines()[-1] if proc.stderr else proc.stdout.strip()
                self._set_result(f"ERROR:{err}")
                self._set_state("failed")
        except Exception as e:
            self._set_result(f"ERROR:{e}")
            self._set_state("failed")
        finally:
            # Clear sensitive material from memory
            self.prov.pending_ssid = None
            self.prov.pending_pass = None


class PPApplication:
    def __init__(self, bus: MessageBus):
        self.bus = bus
        self.service = GattService(0, PP_SERVICE_UUID, True)
        self.prov = ProvisioningState()

        # Characteristics
        self.ch_state = PPStateCharacteristic(self.service, self.prov)
        self.ch_scan = PPScanCharacteristic(self.service, self.prov)
        self.ch_ssid = PPSSIDCharacteristic(self.service, self.prov)
        self.ch_pass = PPPASSCharacteristic(self.service, self.prov)
        self.ch_result = PPResultCharacteristic(self.service, self.prov)
        # on_success callback stops advertising
        self.ch_apply = PPApplyCharacteristic(self.service, self.prov, self.ch_state, self.ch_result, on_success=self._on_success)
        self.ch_pop = PPPOPCharacteristic(self.service, self.prov)

        for ch in [self.ch_state, self.ch_scan, self.ch_ssid, self.ch_pass, self.ch_apply, self.ch_result, self.ch_pop]:
            self.service.add_characteristic(ch)

        # Advertisement
        self.advert = Advertisement(0, [PP_SERVICE_UUID], local_name="ProjectPlant-Setup")

        self._ad_mgr = None
        self._gatt_mgr = None
        self._ad_registered = False

    async def register(self):
        # Export ObjectManager root so BlueZ can discover our tree
        self.bus.export("/org/projectplant/ble", ApplicationRoot(self))

        # Export service and characteristics
        self.bus.export(self.service.get_path(), self.service)
        for ch in self.service.characteristics:
            self.bus.export(ch.get_path(), ch)

        # Export advertisement
        self.bus.export(self.advert.get_path(), self.advert)

        # Get BlueZ managers
        hci0 = "/org/bluez/hci0"
        hci0_proxy = await self.bus.introspect(BLUEZ_SERVICE_NAME, hci0)
        obj = self.bus.get_proxy_object(BLUEZ_SERVICE_NAME, hci0, hci0_proxy)
        self._gatt_mgr = obj.get_interface(GATT_MANAGER_IFACE)
        self._ad_mgr = obj.get_interface(LE_ADVERTISING_MANAGER_IFACE)

        # Register application and advertisement
        await self._gatt_mgr.call_register_application("/org/projectplant/ble", {})
        await self._ad_mgr.call_register_advertisement(self.advert.get_path(), {})
        self._ad_registered = True

    async def unregister_advertisement(self):
        if self._ad_registered and self._ad_mgr:
            try:
                await self._ad_mgr.call_unregister_advertisement(self.advert.get_path())
            except Exception:
                pass
        self._ad_registered = False

    def _on_success(self):
        # Stop advertising (async fire-and-forget)
        asyncio.create_task(self.unregister_advertisement())


class ApplicationRoot(ServiceInterface):
    """Implements org.freedesktop.DBus.ObjectManager for our GATT tree."""

    def __init__(self, app: PPApplication):
        super().__init__("org.freedesktop.DBus.ObjectManager")
        self.app = app

    @method()
    def GetManagedObjects(self) -> "a{oa{sa{sv}}}":
        managed: Dict[str, Dict[str, Dict[str, Variant]]] = {}

        # Service properties
        s = self.app.service
        managed[s.get_path()] = {
            GATT_SERVICE_IFACE: {
                "UUID": Variant("s", s.uuid),
                "Primary": Variant("b", s.primary),
                "Includes": Variant("ao", []),
            }
        }

        # Characteristic properties
        for ch in s.characteristics:
            managed[ch.get_path()] = {
                GATT_CHRC_IFACE: {
                    "UUID": Variant("s", ch.uuid),
                    "Service": Variant("o", s.get_path()),
                    "Flags": Variant("as", ch.flags),
                }
            }
        return managed


async def main():
    # Must run on the system bus for BlueZ
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    app = PPApplication(bus)
    await app.register()
    # Idle forever; BlueZ will invoke our methods via D-Bus
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
