from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from nacl.signing import SigningKey

REQUIRED_ARTIFACTS = [
    "hub-app.tar.zst",
    "ui-dist.tar.zst",
    "systemd-units.tar.zst",
    "managed-configs.tar.zst",
    "debs.tar.zst",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(args: argparse.Namespace) -> dict[str, object]:
    artifact_dir = Path(args.artifact_dir)
    artifacts = []
    for name in REQUIRED_ARTIFACTS:
        path = artifact_dir / name
        if not path.exists():
            raise FileNotFoundError(path)
        artifacts.append({"name": name, "sha256": sha256_file(path)})
    return {
        "releaseId": args.release_id,
        "channel": args.channel,
        "hubVersion": args.hub_version,
        "uiVersion": args.ui_version,
        "agentMinVersion": args.agent_min_version,
        "artifacts": artifacts,
        "managedServices": [
            "projectplant-hub.service",
            "projectplant-agent.service",
            "projectplant-avahi.service",
            "mosquitto.service",
        ],
        "healthChecks": [
            "http://127.0.0.1:8080/healthz",
            "http://127.0.0.1:8080/api/v1/health",
        ],
        "rollbackWindowSeconds": 180,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--hub-version", required=True)
    parser.add_argument("--ui-version", required=True)
    parser.add_argument("--agent-min-version", required=True)
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--private-key-path", required=True)
    args = parser.parse_args()

    artifact_dir = Path(args.artifact_dir)
    manifest = build_manifest(args)
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
    signing_key = SigningKey(bytes.fromhex(Path(args.private_key_path).read_text(encoding="utf-8").strip()))
    signature = signing_key.sign(manifest_bytes).signature
    (artifact_dir / "manifest.json").write_bytes(manifest_bytes)
    (artifact_dir / "manifest.sig").write_bytes(signature)
    (artifact_dir / "rollback_metadata.json").write_text(
        json.dumps({"releaseId": args.release_id, "builtAt": __import__("datetime").datetime.utcnow().isoformat() + "Z"}, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
