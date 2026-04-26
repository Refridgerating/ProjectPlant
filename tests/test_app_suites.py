import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_pytest_suite(relative_cwd: str, *args: str) -> None:
    env = os.environ.copy()
    command = [sys.executable, "-m", "pytest", "-q", *args]
    result = subprocess.run(
        command,
        cwd=REPO_ROOT / relative_cwd,
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"pytest failed in {relative_cwd}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )


def test_hub_pytest_suite() -> None:
    _run_pytest_suite("apps/hub_api", "tests")


def test_fleet_pytest_suite() -> None:
    _run_pytest_suite("apps/fleet", "tests")
