import argparse
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ops.release.package_artifacts as package_module


def test_package_artifacts_rejects_sensitive_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo_root = tmp_path / "repo"
    (repo_root / "apps/hub_api").mkdir(parents=True)
    (repo_root / "pi/update-agent").mkdir(parents=True)
    (repo_root / "pi/avahi").mkdir(parents=True)
    (repo_root / "apps/web_ui/dist").mkdir(parents=True)
    (repo_root / "pi/systemd").mkdir(parents=True)
    config_dir = tmp_path / "managed-configs"
    (config_dir / "bootstrap").mkdir(parents=True)
    (config_dir / "bootstrap/master-bootstrap.json").write_text("secret", encoding="utf-8")
    debs_dir = tmp_path / "debs"
    debs_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(package_module, "_run_tar", lambda *args, **kwargs: None)

    @contextmanager
    def _local_tempdir():
        path = tmp_path / "package-temp"
        path.mkdir(parents=True, exist_ok=True)
        yield str(path)

    monkeypatch.setattr(package_module.tempfile, "TemporaryDirectory", _local_tempdir)

    args = argparse.Namespace(
        repo_root=repo_root,
        output_dir=tmp_path / "out",
        ui_dist=repo_root / "apps/web_ui/dist",
        systemd_dir=repo_root / "pi/systemd",
        config_dir=config_dir,
        debs_dir=debs_dir,
    )

    with pytest.raises(RuntimeError, match="sensitive path"):
        package_module.package_artifacts(args)
