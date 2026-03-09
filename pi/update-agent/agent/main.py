from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError

from .config import load_config
from .fleet_client import FleetClient
from .identity import AgentIdentity, load_or_create_identity, save_identity
from .installer import ReleaseInstaller
from .inventory import collect_inventory
from .state import AgentState, load_state, save_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("projectplant.agent")


def _operation_result_payload(operation_id: str, outcome) -> dict[str, object]:
    return {
        "operationId": operation_id,
        "status": outcome.status,
        "releaseId": outcome.release_id,
        "detail": outcome.detail,
    }


def _write_avahi_metadata(identity: AgentIdentity, state: AgentState) -> None:
    env_path = Path("/etc/projectplant/avahi.env")
    suffix = identity.hub_id.split("-", 1)[-1][-6:]
    channel = str(state.metadata.get("channel") or "dev")
    hub_version = str(state.metadata.get("hubVersion") or "unknown")
    payload = "\n".join(
        [
            f"PROJECTPLANT_AVAHI_NAME=ProjectPlant Hub {suffix}",
            "PROJECTPLANT_PORT=8080",
            f"PROJECTPLANT_AVAHI_TXT=hub_id={identity.hub_id};role=hub;channel={channel};hub_version={hub_version};agent_version=0.1.0",
            "",
        ]
    )
    previous = env_path.read_text(encoding="utf-8") if env_path.exists() else None
    if previous == payload:
        return
    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text(payload, encoding="utf-8")
    subprocess.run(["systemctl", "restart", "projectplant-avahi.service"], check=False)


def run_forever() -> None:
    config = load_config()
    if not config.control_url:
        raise RuntimeError("FLEET_CONTROL_URL is required")
    identity: AgentIdentity = load_or_create_identity(config)
    state: AgentState = load_state(config)
    client = FleetClient(config=config, identity=identity)
    installer = ReleaseInstaller(config, client)
    pending_result: dict[str, object] | None = None

    while True:
        try:
            _write_avahi_metadata(identity, state)
            inventory = collect_inventory(config, identity, state)
            if not identity.enrolled:
                logger.info("Enrolling hub %s with fleet control plane", identity.hub_id)
                client.enroll(inventory)
                identity.enrolled = True
                save_identity(config, identity)
            response = client.check_in(inventory, operation_result=pending_result)
            pending_result = None
            desired = response.get("desiredOperation")
            if desired:
                logger.info("Executing desired operation %s for hub %s", desired.get("operationId"), identity.hub_id)
                outcome = installer.execute(desired, state)
                state.last_operation_id = str(desired.get("operationId") or state.last_operation_id or "") or None
                state.last_rollout_id = str(desired.get("rolloutId") or state.last_rollout_id or "") or None
                save_state(config, state)
                pending_result = _operation_result_payload(str(desired["operationId"]), outcome)
            poll_seconds = int(response.get("pollIntervalSeconds") or config.poll_interval_seconds)
            time.sleep(max(5, poll_seconds))
        except (HTTPError, URLError) as exc:
            logger.warning("Control-plane request failed: %s", exc)
            time.sleep(config.poll_interval_seconds)
        except Exception as exc:
            logger.exception("Update agent loop failed: %s", exc)
            time.sleep(config.poll_interval_seconds)


if __name__ == "__main__":
    run_forever()
