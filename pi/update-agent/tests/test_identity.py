from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.config import AgentConfig
from agent.identity import load_or_create_identity, save_identity


def _config(tmp_path: Path) -> AgentConfig:
    state_dir = tmp_path / "state"
    return AgentConfig(
        control_url="https://fleet.local",
        bootstrap_token="token",
        state_dir=state_dir,
        identity_path=state_dir / "identity.json",
        state_path=state_dir / "state.json",
        release_root=tmp_path / "releases",
        current_link=tmp_path / "current",
        config_dir=tmp_path / "etc",
        download_root=state_dir / "downloads",
        poll_interval_seconds=30,
        release_public_key_path=None,
        hub_health_checks=("http://127.0.0.1:8080/healthz",),
        managed_services=("projectplant-hub.service",),
        avahi_env_path=tmp_path / "avahi.env",
        avahi_service_name=None,
        mqtt_broker_mode="external",
        site="lab",
        channel="dev",
    )


def test_hub_identity_is_stable_after_first_persist(tmp_path: Path) -> None:
    config = _config(tmp_path)
    machine_id_path = tmp_path / "machine-id"
    machine_id_path.write_text("machine-a\n", encoding="utf-8")

    created = load_or_create_identity(config, machine_id_path=machine_id_path)
    original_hub_id = created.hub_id
    assert original_hub_id.startswith("hub-")

    machine_id_path.write_text("machine-b\n", encoding="utf-8")
    loaded = load_or_create_identity(config, machine_id_path=machine_id_path)

    assert loaded.hub_id == original_hub_id
    assert loaded.public_key_hex == created.public_key_hex


def test_save_identity_persists_enrollment_flag(tmp_path: Path) -> None:
    config = _config(tmp_path)
    machine_id_path = tmp_path / "machine-id"
    machine_id_path.write_text("machine-c\n", encoding="utf-8")

    identity = load_or_create_identity(config, machine_id_path=machine_id_path)
    identity.enrolled = True
    save_identity(config, identity)

    loaded = load_or_create_identity(config, machine_id_path=machine_id_path)
    assert loaded.enrolled is True
