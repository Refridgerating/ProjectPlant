import hashlib
import json

from nacl.signing import SigningKey


def test_release_registration_rejects_artifact_hash_mismatch(client, auth_headers):
    signing_key = SigningKey.generate()
    artifact_bytes = b"hub-artifact"
    manifest = {
        "manifest": {
            "releaseId": "2026.03.01-1",
            "channel": "stable",
            "hubVersion": "0.2.1",
            "uiVersion": "0.2.1",
            "agentMinVersion": "0.1.0",
            "artifacts": [
                {
                    "name": "hub-app.tar.zst",
                    "sha256": hashlib.sha256(b"different").hexdigest(),
                }
            ],
            "managedServices": ["projectplant-hub.service"],
            "healthChecks": ["http://127.0.0.1:8080/healthz"],
            "rollbackWindowSeconds": 180,
        }
    }
    manifest_bytes = json.dumps(manifest["manifest"], sort_keys=True, indent=2).encode("utf-8")
    signature = signing_key.sign(manifest_bytes).signature

    response = client.post(
        "/api/v1/releases",
        headers=auth_headers,
        files=[
            ("metadata", (None, json.dumps(manifest))),
            ("signature", ("manifest.sig", signature, "application/octet-stream")),
            ("artifacts", ("hub-app.tar.zst", artifact_bytes, "application/octet-stream")),
        ],
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["mismatched"] == ["hub-app.tar.zst"]
