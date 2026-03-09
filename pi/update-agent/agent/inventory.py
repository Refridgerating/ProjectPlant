from __future__ import annotations

import shutil
import socket
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import AgentConfig
from .identity import AgentIdentity
from .state import AgentState


def _uptime_seconds() -> int | None:
    try:
        raw = Path("/proc/uptime").read_text(encoding="utf-8").split()[0]
        return int(float(raw))
    except Exception:
        return None


def _local_ips() -> list[str]:
    addresses: set[str] = set()
    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET):
            ip = result[4][0]
            if ip and not ip.startswith("127."):
                addresses.add(ip)
    except Exception:
        pass
    return sorted(addresses)


def _service_enabled(name: str) -> bool:
    try:
        result = subprocess.run(["systemctl", "is-enabled", name], check=False, capture_output=True, text=True)
    except Exception:
        return False
    return result.returncode == 0 and result.stdout.strip() in {"enabled", "static"}


def collect_inventory(config: AgentConfig, identity: AgentIdentity, state: AgentState) -> dict[str, object]:
    hostname = socket.gethostname()
    free_bytes = shutil.disk_usage(config.release_root.parent if config.release_root.parent.exists() else Path("/")).free
    uptime = _uptime_seconds()
    last_boot_at = None
    if uptime is not None:
        last_boot = datetime.now(timezone.utc) - timedelta(seconds=uptime)
        last_boot_at = last_boot.isoformat(timespec="seconds").replace("+00:00", "Z")
    suffix = identity.hub_id.split("-", 1)[-1][-6:]
    return {
        "hostname": hostname,
        "advertisedName": state.metadata.get("advertisedName") or f"ProjectPlant Hub {suffix}",
        "site": state.metadata.get("site") or config.site,
        "channel": state.metadata.get("channel") or config.channel,
        "localIpAddresses": _local_ips(),
        "agentVersion": "0.1.0",
        "hubVersion": state.metadata.get("hubVersion"),
        "uiVersion": state.metadata.get("uiVersion"),
        "managedServices": list(config.managed_services),
        "diskFreeBytes": free_bytes,
        "uptimeSeconds": uptime,
        "lastBootAt": last_boot_at,
        "mosquittoEnabled": _service_enabled("mosquitto.service"),
        "mqttBrokerMode": config.mqtt_broker_mode,
    }
