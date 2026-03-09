from __future__ import annotations

import base64
import json
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from .config import AgentConfig
from .identity import AgentIdentity


@dataclass(slots=True)
class FleetClient:
    config: AgentConfig
    identity: AgentIdentity

    def enroll(self, inventory: dict[str, object]) -> dict[str, object]:
        payload = {
            "bootstrapToken": self.config.bootstrap_token,
            "hubId": self.identity.hub_id,
            "publicKey": self.identity.public_key_hex,
            "inventory": inventory,
        }
        return self._post_json("/api/v1/hubs/enroll", payload)

    def check_in(self, inventory: dict[str, object], operation_result: dict[str, object] | None = None) -> dict[str, object]:
        payload: dict[str, object] = {"hubId": self.identity.hub_id, "inventory": inventory}
        if operation_result is not None:
            payload["operationResult"] = operation_result
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        signature = self.identity.signing_key().sign(timestamp.encode("utf-8") + b"\n" + body).signature
        headers = {
            "Content-Type": "application/json",
            "X-ProjectPlant-Hub-Id": self.identity.hub_id,
            "X-ProjectPlant-Timestamp": timestamp,
            "X-ProjectPlant-Signature": base64.b64encode(signature).decode("ascii"),
        }
        return self._post_bytes("/api/v1/hubs/check-in", body, headers=headers)

    def fetch_json(self, url: str) -> dict[str, object]:
        with urllib.request.urlopen(self._resolve_url(url)) as response:
            return json.loads(response.read().decode("utf-8"))

    def fetch_bytes(self, url: str) -> bytes:
        with urllib.request.urlopen(self._resolve_url(url)) as response:
            return response.read()

    def _post_json(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return self._post_bytes(path, body, headers={"Content-Type": "application/json"})

    def _post_bytes(self, path: str, body: bytes, headers: dict[str, str]) -> dict[str, object]:
        request = urllib.request.Request(self._resolve_url(path), data=body, headers=headers, method="POST")
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))

    def _resolve_url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{self.config.control_url}{path}"
