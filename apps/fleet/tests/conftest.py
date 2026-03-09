import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

ROOT = Path(__file__).resolve().parents[1]
SRC_PATH = ROOT / "src"


def _purge_conflicting_modules() -> None:
    src_prefix = str(SRC_PATH.resolve())
    for name, module in list(sys.modules.items()):
        if name not in {"config", "main", "auth"} and not name.startswith(("services", "api", "auth.")):
            continue
        module_file = getattr(module, "__file__", None)
        if not module_file:
            continue
        if not str(Path(module_file).resolve()).startswith(src_prefix):
            sys.modules.pop(name, None)


_purge_conflicting_modules()
if str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))

from config import settings
from main import create_app
from api.v1 import dependencies as dep_module
from api.v1 import router as router_module
from services import fleet_store as fleet_module
from services import iam_store as iam_module


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    db_path = tmp_path / "fleet.sqlite3"
    artifact_dir = tmp_path / "artifacts"
    bootstrap_dir = tmp_path / "bootstrap"
    recovery_dir = tmp_path / "recovery"
    bootstrap_dir.mkdir(parents=True, exist_ok=True)
    recovery_dir.mkdir(parents=True, exist_ok=True)

    recovery_signing_key = SigningKey.generate()
    recovery_public_hex = recovery_signing_key.verify_key.encode().hex()
    recovery_public_path = recovery_dir / "master-recovery.pub"
    recovery_public_path.write_text(recovery_public_hex, encoding="utf-8")

    bootstrap_token = "bootstrap-master-token"
    bootstrap_artifact_path = bootstrap_dir / "master-bootstrap.json"
    bootstrap_artifact_path.write_text(
        json.dumps(
            {
                "bootstrapTokenHash": hashlib.sha256(bootstrap_token.encode("utf-8")).hexdigest(),
                "bootstrapExpiresAt": "2035-01-01T00:00:00Z",
                "primaryMasterEmail": "owner@example.com",
                "primaryMasterDisplayName": "Owner",
                "backupMaster": {"email": "backup@example.com", "displayName": "Backup Owner"},
                "recoveryPublicKeyFingerprint": hashlib.sha256(bytes.fromhex(recovery_public_hex)).hexdigest(),
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(settings, "fleet_database_path", str(db_path))
    monkeypatch.setattr(settings, "fleet_artifact_dir", str(artifact_dir))
    monkeypatch.setattr(settings, "fleet_bootstrap_tokens", ["bootstrap-dev-token"])
    monkeypatch.setattr(settings, "fleet_bootstrap_artifact_path", str(bootstrap_artifact_path))
    monkeypatch.setattr(settings, "fleet_recovery_public_key_path", str(recovery_public_path))

    fleet = fleet_module.FleetStore(str(db_path), str(artifact_dir))
    iam = iam_module.IamStore(str(db_path))
    fleet_module.fleet_store = fleet
    iam_module.iam_store = iam
    monkeypatch.setattr(router_module, "fleet_store", fleet)
    monkeypatch.setattr(router_module, "iam_store", iam)
    monkeypatch.setattr(dep_module, "iam_store", iam)
    yield {
        "bootstrap_token": bootstrap_token,
        "recovery_signing_key": recovery_signing_key,
        "bootstrap_artifact_path": bootstrap_artifact_path,
    }


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers(client: TestClient, isolated_state: dict[str, object]) -> dict[str, str]:
    start = client.post("/api/v1/bootstrap/master/start", json={"bootstrapToken": isolated_state["bootstrap_token"]})
    assert start.status_code == 200, start.text
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
    assert complete.status_code == 200, complete.text
    return {"Authorization": f"Bearer {complete.json()['access_token']}"}
