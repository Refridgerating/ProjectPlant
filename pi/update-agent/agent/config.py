from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"')
    return values


@dataclass(slots=True)
class AgentConfig:
    control_url: str
    bootstrap_token: str
    state_dir: Path
    identity_path: Path
    state_path: Path
    release_root: Path
    current_link: Path
    config_dir: Path
    download_root: Path
    poll_interval_seconds: int
    release_public_key_path: Path | None
    hub_health_checks: tuple[str, ...]
    managed_services: tuple[str, ...]
    avahi_env_path: Path
    avahi_service_name: str | None
    mqtt_broker_mode: str
    site: str | None
    channel: str


def load_config() -> AgentConfig:
    env_file = Path("/etc/projectplant/fleet.env")
    values = _read_env_file(env_file)
    env = {**values, **os.environ}
    state_dir = Path(env.get("PROJECTPLANT_AGENT_STATE_DIR", "/var/lib/projectplant/agent"))
    release_root = Path(env.get("PROJECTPLANT_RELEASE_ROOT", "/opt/projectplant/releases"))
    current_link = Path(env.get("PROJECTPLANT_CURRENT_LINK", "/opt/projectplant/current"))
    config_dir = Path(env.get("PROJECTPLANT_CONFIG_DIR", "/etc/projectplant"))
    download_root = state_dir / "downloads"
    release_key = env.get("PROJECTPLANT_RELEASE_PUBLIC_KEY_PATH")
    health_checks = env.get("PROJECTPLANT_HUB_HEALTH_CHECKS", "http://127.0.0.1:8080/healthz,http://127.0.0.1:8080/api/v1/health")
    managed = env.get("PROJECTPLANT_MANAGED_SERVICES", "projectplant-hub.service,projectplant-avahi.service,mosquitto.service")
    avahi_env_path = Path(env.get("PROJECTPLANT_AVAHI_ENV_PATH", "/etc/projectplant/avahi.env"))
    avahi_service_name = (env.get("PROJECTPLANT_AVAHI_SERVICE_NAME", "projectplant-avahi.service") or "").strip() or None
    return AgentConfig(
        control_url=env.get("FLEET_CONTROL_URL", "").rstrip("/"),
        bootstrap_token=env.get("FLEET_BOOTSTRAP_TOKEN", ""),
        state_dir=state_dir,
        identity_path=state_dir / "identity.json",
        state_path=state_dir / "state.json",
        release_root=release_root,
        current_link=current_link,
        config_dir=config_dir,
        download_root=download_root,
        poll_interval_seconds=max(5, int(env.get("FLEET_POLL_INTERVAL_SECONDS", "30"))),
        release_public_key_path=Path(release_key) if release_key else None,
        hub_health_checks=tuple(item.strip() for item in health_checks.split(",") if item.strip()),
        managed_services=tuple(item.strip() for item in managed.split(",") if item.strip()),
        avahi_env_path=avahi_env_path,
        avahi_service_name=avahi_service_name,
        mqtt_broker_mode=env.get("PROJECTPLANT_MQTT_BROKER_MODE", "external").strip() or "external",
        site=env.get("PROJECTPLANT_SITE") or None,
        channel=env.get("PROJECTPLANT_CHANNEL", "dev").strip() or "dev",
    )
