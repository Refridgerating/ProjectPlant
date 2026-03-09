from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path


SENSITIVE_NAMES = {"iam.env"}
SENSITIVE_PARTS = {"bootstrap", "recovery"}


def _run_tar(output_path: Path, *, cwd: Path, members: list[str], relative_to: Path | None = None) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = ["tar", "--zstd", "-cf", str(output_path)]
    if relative_to is not None:
        command.extend(["-C", str(relative_to)])
    command.extend(members)
    subprocess.run(command, cwd=cwd, check=True)


def _assert_no_sensitive_content(root: Path) -> None:
    if not root.exists():
        return
    for path in root.rglob("*"):
        lowered_parts = {part.lower() for part in path.parts}
        lowered_name = path.name.lower()
        if lowered_name.endswith(".env") or lowered_name in SENSITIVE_NAMES or lowered_parts & SENSITIVE_PARTS:
            raise RuntimeError(f"Refusing to package sensitive path: {path}")


def package_artifacts(args: argparse.Namespace) -> None:
    repo_root = Path(args.repo_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    hub_paths = ["apps/hub", "pi/update-agent", "pi/avahi"]
    for hub_path in hub_paths:
        _assert_no_sensitive_content((repo_root / hub_path).resolve())
    _run_tar(output_dir / "hub-app.tar.zst", cwd=repo_root, members=hub_paths, relative_to=repo_root)

    ui_dist = Path(args.ui_dist).resolve()
    if not ui_dist.exists():
        raise FileNotFoundError(f"UI dist not found: {ui_dist}")
    _run_tar(output_dir / "ui-dist.tar.zst", cwd=repo_root, members=[str(ui_dist.relative_to(repo_root))], relative_to=repo_root)

    systemd_dir = Path(args.systemd_dir).resolve()
    if not systemd_dir.exists():
        raise FileNotFoundError(f"Systemd directory not found: {systemd_dir}")
    _run_tar(output_dir / "systemd-units.tar.zst", cwd=systemd_dir, members=["."], relative_to=systemd_dir)

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)

        config_dir = Path(args.config_dir).resolve() if args.config_dir else temp_root / "managed-configs"
        if not config_dir.exists():
            config_dir.mkdir(parents=True, exist_ok=True)
        _assert_no_sensitive_content(config_dir)
        _run_tar(output_dir / "managed-configs.tar.zst", cwd=config_dir, members=["."], relative_to=config_dir)

        debs_dir = Path(args.debs_dir).resolve() if args.debs_dir else temp_root / "debs"
        if not debs_dir.exists():
            debs_dir.mkdir(parents=True, exist_ok=True)
        _assert_no_sensitive_content(debs_dir)
        _run_tar(output_dir / "debs.tar.zst", cwd=debs_dir, members=["."], relative_to=debs_dir)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--ui-dist", default="apps/ui/dist")
    parser.add_argument("--systemd-dir", default="pi/systemd")
    parser.add_argument("--config-dir")
    parser.add_argument("--debs-dir")
    args = parser.parse_args()

    if shutil.which("tar") is None:
        raise RuntimeError("tar is required to package release artifacts")

    package_artifacts(args)


if __name__ == "__main__":
    main()
