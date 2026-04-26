from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from db_models.migrations import ensure_schema_version


def test_ensure_schema_version_is_idempotent() -> None:
    connection = sqlite3.connect(":memory:")

    ensure_schema_version(connection, version=1)
    ensure_schema_version(connection, version=1)

    rows = connection.execute("SELECT version FROM schema_migrations").fetchall()
    assert rows == [(1,)]
