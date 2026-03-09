from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from nacl.signing import SigningKey

from .config import AgentConfig


@dataclass(slots=True)
class AgentIdentity:
    hub_id: str
    public_key_hex: str
    private_key_hex: str
    enrolled: bool

    def signing_key(self) -> SigningKey:
        return SigningKey(bytes.fromhex(self.private_key_hex))


def _compute_hub_id(machine_id: str) -> str:
    digest = hashlib.sha256(machine_id.strip().encode("utf-8")).hexdigest()
    return f"hub-{digest[:12]}"


def load_or_create_identity(config: AgentConfig, *, machine_id_path: Path = Path("/etc/machine-id")) -> AgentIdentity:
    config.state_dir.mkdir(parents=True, exist_ok=True)
    if config.identity_path.exists():
        payload = json.loads(config.identity_path.read_text(encoding="utf-8"))
        return AgentIdentity(
            hub_id=str(payload["hubId"]),
            public_key_hex=str(payload["publicKey"]),
            private_key_hex=str(payload["privateKey"]),
            enrolled=bool(payload.get("enrolled", False)),
        )

    machine_id = machine_id_path.read_text(encoding="utf-8").strip()
    signing_key = SigningKey.generate()
    identity = AgentIdentity(
        hub_id=_compute_hub_id(machine_id),
        public_key_hex=signing_key.verify_key.encode().hex(),
        private_key_hex=signing_key.encode().hex(),
        enrolled=False,
    )
    save_identity(config, identity)
    return identity


def save_identity(config: AgentConfig, identity: AgentIdentity) -> None:
    config.state_dir.mkdir(parents=True, exist_ok=True)
    config.identity_path.write_text(
        json.dumps(
            {
                "hubId": identity.hub_id,
                "publicKey": identity.public_key_hex,
                "privateKey": identity.private_key_hex,
                "enrolled": identity.enrolled,
            },
            indent=2,
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )
