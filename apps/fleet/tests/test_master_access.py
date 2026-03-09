import base64

from services import iam_store as iam_store_module


def test_bootstrap_completes_once_and_deletes_artifact(client, isolated_state):
    start = client.post("/api/v1/bootstrap/master/start", json={"bootstrapToken": isolated_state["bootstrap_token"]})
    assert start.status_code == 200
    nonce = start.json()["bootstrapNonce"]

    complete = client.post(
        "/api/v1/bootstrap/master/complete",
        json={
            "bootstrapToken": isolated_state["bootstrap_token"],
            "bootstrapNonce": nonce,
            "password": "MasterPassword123!",
            "confirmPassword": "MasterPassword123!",
            "displayName": "Owner",
        },
    )
    assert complete.status_code == 200
    assert not isolated_state["bootstrap_artifact_path"].exists()

    second_start = client.post("/api/v1/bootstrap/master/start", json={"bootstrapToken": isolated_state["bootstrap_token"]})
    assert second_start.status_code == 422

    status = client.get("/api/v1/bootstrap/status")
    assert status.status_code == 200
    assert status.json()["primaryMasterExists"] is True


def test_non_master_cannot_access_master_endpoints(client, auth_headers):
    iam_store_module.iam_store.create_account(email="user@example.com", password="UserPassword123!", display_name="User")
    login = client.post("/api/v1/auth/local", json={"email": "user@example.com", "password": "UserPassword123!"})
    assert login.status_code == 200
    user_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    forbidden = client.get("/api/v1/system/master-state", headers=user_headers)
    assert forbidden.status_code == 403

    audit = client.get("/api/v1/audit", headers=auth_headers)
    assert audit.status_code == 200
    assert any(event["eventType"] == "authz.master_required" and event["outcome"] == "denied" for event in audit.json()["events"])


def test_valid_recovery_signature_activates_backup(client, auth_headers, isolated_state):
    challenge = client.post("/api/v1/recovery/challenge")
    assert challenge.status_code == 200
    payload = challenge.json()
    signature = isolated_state["recovery_signing_key"].sign(payload["challenge"].encode("utf-8")).signature

    complete = client.post(
        "/api/v1/recovery/complete",
        json={"challengeId": payload["challengeId"], "signature": base64.b64encode(signature).decode("ascii")},
    )
    assert complete.status_code == 200
    assert complete.json()["account"]["email"] == "backup@example.com"
    assert complete.json()["effectiveAccess"]["isBackupMaster"] is True

    backup_headers = {"Authorization": f"Bearer {complete.json()['access_token']}"}
    recovery_status = client.get("/api/v1/system/recovery-status", headers=backup_headers)
    assert recovery_status.status_code == 200
    assert recovery_status.json()["backupActive"] is True
