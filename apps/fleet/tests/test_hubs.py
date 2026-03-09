import base64
import json
from datetime import datetime, timezone

from nacl.signing import SigningKey


def _enroll(client):
    signing_key = SigningKey.generate()
    response = client.post(
        "/api/v1/hubs/enroll",
        json={
            "bootstrapToken": "bootstrap-dev-token",
            "hubId": "hub-abc123def456",
            "publicKey": signing_key.verify_key.encode().hex(),
            "inventory": {
                "hostname": "projectplant-abc123",
                "advertisedName": "ProjectPlant Hub abc123",
                "site": "lab",
                "channel": "dev",
                "localIpAddresses": ["192.168.0.10"],
                "agentVersion": "0.1.0",
                "hubVersion": "0.1.0",
                "uiVersion": "0.1.0",
                "managedServices": ["projectplant-hub.service", "projectplant-agent.service"],
                "diskFreeBytes": 1024,
                "uptimeSeconds": 60,
                "lastBootAt": "2026-02-28T12:00:00Z",
                "mosquittoEnabled": True,
                "mqttBrokerMode": "local"
            }
        },
    )
    assert response.status_code == 200
    return signing_key


def test_enrollment_rejects_reused_bootstrap_token(client):
    _enroll(client)
    second = client.post(
        "/api/v1/hubs/enroll",
        json={
            "bootstrapToken": "bootstrap-dev-token",
            "hubId": "hub-second",
            "publicKey": "00" * 32,
            "inventory": {"hostname": "projectplant-second", "agentVersion": "0.1.0"}
        },
    )
    assert second.status_code == 422
    assert "already used" in second.json()["detail"]


def test_signed_check_in_rejects_tampered_signature(client):
    signing_key = _enroll(client)
    body = {"hubId": "hub-abc123def456", "inventory": {"hostname": "projectplant-abc123", "agentVersion": "0.1.0"}}
    raw = json.dumps(body).encode("utf-8")
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    signature = signing_key.sign(timestamp.encode("utf-8") + b"\n" + raw).signature
    tampered = {**body, "inventory": {"hostname": "projectplant-evil", "agentVersion": "0.1.0"}}
    response = client.post(
        "/api/v1/hubs/check-in",
        headers={
            "X-ProjectPlant-Hub-Id": "hub-abc123def456",
            "X-ProjectPlant-Timestamp": timestamp,
            "X-ProjectPlant-Signature": base64.b64encode(signature).decode("ascii"),
        },
        json=tampered,
    )
    assert response.status_code == 401
