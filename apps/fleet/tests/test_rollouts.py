import base64
import json
from datetime import datetime, timezone

from nacl.signing import SigningKey
from services import fleet_store as fleet_store_module


def _enroll_hub(client, token: str, hub_id: str, site: str):
    key = SigningKey.generate()
    response = client.post(
        "/api/v1/hubs/enroll",
        json={
            "bootstrapToken": token,
            "hubId": hub_id,
            "publicKey": key.verify_key.encode().hex(),
            "inventory": {
                "hostname": hub_id,
                "site": site,
                "channel": "dev",
                "localIpAddresses": ["10.0.0.1"],
                "agentVersion": "0.1.0",
                "managedServices": ["projectplant-hub.service"]
            }
        },
    )
    assert response.status_code == 200
    return key


def _signed_checkin(client, key: SigningKey, hub_id: str, *, status=None, operation_id=None):
    body = {
        "hubId": hub_id,
        "inventory": {
            "hostname": hub_id,
            "channel": "dev",
            "localIpAddresses": ["10.0.0.1"],
            "agentVersion": "0.1.0",
            "managedServices": ["projectplant-hub.service"]
        }
    }
    if operation_id and status:
        body["operationResult"] = {"operationId": operation_id, "status": status, "detail": {"source": "test"}}
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    signature = base64.b64encode(key.sign(timestamp.encode("utf-8") + b"\n" + raw).signature).decode("ascii")
    return client.post(
        "/api/v1/hubs/check-in",
        headers={
            "Content-Type": "application/json",
            "X-ProjectPlant-Hub-Id": hub_id,
            "X-ProjectPlant-Timestamp": timestamp,
            "X-ProjectPlant-Signature": signature,
        },
        content=raw,
    )


def test_rollout_canary_failure_pauses(client, auth_headers):
    fleet_store_module.fleet_store.create_bootstrap_token("token-one")
    fleet_store_module.fleet_store.create_bootstrap_token("token-two")
    key_one = _enroll_hub(client, "token-one", "hub-one", "lab")
    _enroll_hub(client, "token-two", "hub-two", "lab")

    manifest = {
        "manifest": {
            "releaseId": "2026.02.28-1",
            "channel": "stable",
            "hubVersion": "0.2.0",
            "uiVersion": "0.2.0",
            "agentMinVersion": "0.1.0",
            "artifacts": [],
            "managedServices": ["projectplant-hub.service"],
            "healthChecks": ["http://127.0.0.1:8080/healthz"],
            "rollbackWindowSeconds": 180
        }
    }
    release = client.post(
        "/api/v1/releases",
        headers=auth_headers,
        files=[
            ("metadata", (None, json.dumps(manifest))),
            ("signature", ("manifest.sig", b"dev-signature", "application/octet-stream")),
        ],
    )
    assert release.status_code == 200

    rollout = client.post(
        "/api/v1/rollouts",
        headers=auth_headers,
        json={"releaseId": "2026.02.28-1", "selector": {"site": "lab"}},
    )
    assert rollout.status_code == 200
    rollout_id = rollout.json()["rolloutId"]

    first_check = _signed_checkin(client, key_one, "hub-one")
    assert first_check.status_code == 200
    operation = first_check.json()["desiredOperation"]
    assert operation is not None

    fail_check = _signed_checkin(client, key_one, "hub-one", status="failed", operation_id=operation["operationId"])
    assert fail_check.status_code == 200

    rollout_state = client.get(f"/api/v1/rollouts/{rollout_id}", headers=auth_headers)
    assert rollout_state.status_code == 200
    assert rollout_state.json()["status"] == "paused"

    rollout_list = client.get("/api/v1/rollouts", headers=auth_headers)
    assert rollout_list.status_code == 200
    assert rollout_list.json()["rollouts"][0]["rolloutId"] == rollout_id
