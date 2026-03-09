from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .config import AgentConfig
from .fleet_client import FleetClient
from .state import AgentState, save_state


@dataclass(slots=True)
class OperationExecution:
    status: str
    detail: dict[str, object]
    release_id: str | None = None


class ReleaseInstaller:
    def __init__(self, config: AgentConfig, client: FleetClient) -> None:
        self.config = config
        self.client = client

    def execute(self, operation: dict[str, object], state: AgentState) -> OperationExecution:
        op_type = str(operation.get("type") or "")
        if op_type == "refresh_inventory":
            return OperationExecution(status="succeeded", detail={"action": "refresh_inventory"})
        if op_type == "rollback_release":
            return self._rollback_to_release(state, str(operation.get("releaseId") or state.last_known_good_release_id or "") or None)
        if op_type != "install_release":
            return OperationExecution(status="failed", detail={"error": f"Unsupported operation type {op_type}"})
        release_id = str(operation.get("releaseId") or "")
        if not release_id:
            return OperationExecution(status="failed", detail={"error": "Missing releaseId"})
        return self._install_release(release_id, state)

    def _install_release(self, release_id: str, state: AgentState) -> OperationExecution:
        release = self.client.fetch_json(f"/api/v1/releases/{release_id}")
        manifest = dict(release["manifest"])
        manifest_bytes = self.client.fetch_bytes(f"/api/v1/releases/{release_id}/manifest")
        signature_bytes = self.client.fetch_bytes(f"/api/v1/releases/{release_id}/manifest.sig")
        if not self._verify_manifest_signature(manifest_bytes, signature_bytes):
            return OperationExecution(status="failed", detail={"error": "manifest signature verification failed"}, release_id=release_id)

        self.config.download_root.mkdir(parents=True, exist_ok=True)
        download_dir = self.config.download_root / release_id
        if download_dir.exists():
            shutil.rmtree(download_dir)
        download_dir.mkdir(parents=True, exist_ok=True)
        (download_dir / "manifest.json").write_bytes(manifest_bytes)
        (download_dir / "manifest.sig").write_bytes(signature_bytes)

        for artifact in manifest.get("artifacts", []):
            name = str(artifact["name"])
            target = download_dir / name
            target.write_bytes(self.client.fetch_bytes(str(artifact["url"])))
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            if digest != str(artifact["sha256"]):
                return OperationExecution(status="failed", detail={"error": f"artifact hash mismatch for {name}"}, release_id=release_id)

        previous_target = self.config.current_link.resolve() if self.config.current_link.exists() else None
        backup_root = self.config.state_dir / "backups" / release_id
        if backup_root.exists():
            shutil.rmtree(backup_root)
        backup_root.mkdir(parents=True, exist_ok=True)
        if self.config.config_dir.exists():
            shutil.copytree(self.config.config_dir, backup_root / "config", dirs_exist_ok=True)
        if previous_target and (previous_target / "debs").exists():
            shutil.copytree(previous_target / "debs", backup_root / "debs", dirs_exist_ok=True)

        release_dir = self.config.release_root / release_id
        if release_dir.exists():
            shutil.rmtree(release_dir)
        release_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._extract_artifacts(download_dir, release_dir)
            self._activate_release(release_dir)
            state.current_release_id = release_id
            state.last_known_good_release_id = release_id
            state.metadata["hubVersion"] = release.get("hubVersion")
            state.metadata["uiVersion"] = release.get("uiVersion")
            save_state(self.config, state)
            return OperationExecution(status="succeeded", detail={"releaseDir": str(release_dir)}, release_id=release_id)
        except Exception as exc:
            self._restore_backup(previous_target, backup_root)
            return OperationExecution(status="rolled_back", detail={"error": str(exc)}, release_id=state.last_known_good_release_id)

    def _rollback_to_release(self, state: AgentState, release_id: str | None) -> OperationExecution:
        if not release_id:
            return OperationExecution(status="failed", detail={"error": "No release available to roll back to"})
        target = self.config.release_root / release_id
        if not target.exists():
            return OperationExecution(status="failed", detail={"error": f"Release {release_id} is not staged locally"}, release_id=release_id)
        try:
            self._activate_release(target)
            state.current_release_id = release_id
            save_state(self.config, state)
            return OperationExecution(status="rolled_back", detail={"releaseDir": str(target)}, release_id=release_id)
        except Exception as exc:
            return OperationExecution(status="failed", detail={"error": str(exc)}, release_id=release_id)

    def _extract_artifacts(self, download_dir: Path, release_dir: Path) -> None:
        deb_target = release_dir / "debs"
        deb_target.mkdir(parents=True, exist_ok=True)
        for artifact in download_dir.iterdir():
            if artifact.name in {"manifest.json", "manifest.sig"}:
                continue
            if artifact.name.startswith("debs"):
                self._extract_archive(artifact, deb_target)
                self._install_debs(deb_target)
                continue
            if artifact.name.startswith("systemd-units"):
                self._extract_archive(artifact, Path("/etc/systemd/system"))
                continue
            if artifact.name.startswith("managed-configs"):
                self._extract_archive(artifact, self.config.config_dir)
                continue
            self._extract_archive(artifact, release_dir)

    def _extract_archive(self, archive: Path, destination: Path) -> None:
        destination.mkdir(parents=True, exist_ok=True)
        subprocess.run(["tar", "-xf", str(archive), "-C", str(destination)], check=True)

    def _install_debs(self, deb_dir: Path) -> None:
        for deb in sorted(deb_dir.glob("*.deb")):
            subprocess.run(["dpkg", "-i", str(deb)], check=True)

    def _activate_release(self, release_dir: Path) -> None:
        self.config.release_root.mkdir(parents=True, exist_ok=True)
        tmp_link = self.config.current_link.with_name(self.config.current_link.name + ".next")
        if tmp_link.exists() or tmp_link.is_symlink():
            tmp_link.unlink()
        os.symlink(release_dir, tmp_link, target_is_directory=True)
        os.replace(tmp_link, self.config.current_link)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        for service in self.config.managed_services:
            if service == "projectplant-agent.service":
                continue
            subprocess.run(["systemctl", "restart", service], check=False)
        self._wait_for_health()

    def _wait_for_health(self) -> None:
        deadline = time.time() + 180
        failure_count = 0
        while time.time() < deadline:
            if all(self._http_ok(url) for url in self.config.hub_health_checks):
                return
            failure_count += 1
            if failure_count >= 2:
                break
            time.sleep(5)
        raise RuntimeError("health checks failed after release activation")

    def _http_ok(self, url: str) -> bool:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return 200 <= response.status < 300
        except Exception:
            return False

    def _restore_backup(self, previous_target: Path | None, backup_root: Path) -> None:
        if previous_target and previous_target.exists():
            self._activate_release(previous_target)
        config_backup = backup_root / "config"
        if config_backup.exists():
            shutil.copytree(config_backup, self.config.config_dir, dirs_exist_ok=True)
        deb_backup = backup_root / "debs"
        if deb_backup.exists():
            self._install_debs(deb_backup)

    def _verify_manifest_signature(self, manifest_bytes: bytes, signature_bytes: bytes) -> bool:
        if not self.config.release_public_key_path:
            return True
        raw = self.config.release_public_key_path.read_text(encoding="utf-8").strip()
        verify_key = VerifyKey(bytes.fromhex(raw))
        try:
            verify_key.verify(manifest_bytes, signature_bytes)
        except BadSignatureError:
            return False
        return True
