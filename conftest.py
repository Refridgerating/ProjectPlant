import shutil
import uuid
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent
PYTEST_TEMP_ROOT = ROOT / "data" / "pytest-runtime-root"
IGNORED_APP_TEST_ROOTS = (
    ROOT / "apps" / "hub" / "tests",
    ROOT / "apps" / "fleet" / "tests",
)
IGNORED_PATH_NAMES = {".pytest_cache", ".venv", "__pycache__", "node_modules"}
IGNORED_TEMP_ROOTS = (
    ROOT / ".tmp-pytest",
    ROOT / ".tmp-pytest-root",
    ROOT / "data" / "pytest-runtime-root",
    ROOT / "apps" / "hub" / "data" / "pytest-runtime",
    ROOT / "apps" / "fleet" / "data" / "pytest-runtime",
)


@pytest.fixture
def tmp_path() -> Path:
    PYTEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    path = PYTEST_TEMP_ROOT / f"case-{uuid.uuid4().hex}"
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def pytest_ignore_collect(collection_path, path=None, config=None):  # type: ignore[no-untyped-def]
    resolved = Path(str(collection_path)).resolve()
    if resolved.name in IGNORED_PATH_NAMES:
        return True
    for ignored_root in IGNORED_APP_TEST_ROOTS:
        try:
            resolved.relative_to(ignored_root)
        except ValueError:
            continue
        return True
    for ignored_root in IGNORED_TEMP_ROOTS:
        try:
            resolved.relative_to(ignored_root)
        except ValueError:
            continue
        return True
    return False
