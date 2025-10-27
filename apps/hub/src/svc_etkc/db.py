"""SQLite helpers for the ETc microservice."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator, Iterable, Optional

DEFAULT_DB_PATH: Path = Path(__file__).resolve().parent / "etkc.sqlite3"


def connect(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """Return a SQLite connection with Row factory enabled."""

    path = Path(db_path) if db_path is not None else DEFAULT_DB_PATH
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the expected tables if they do not yet exist."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS pots (
            id TEXT PRIMARY KEY,
            area_m2 REAL NOT NULL,
            depth_m REAL NOT NULL,
            theta_fc REAL NOT NULL,
            theta_wp REAL NOT NULL,
            class_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS etkc_state (
            plant_id TEXT PRIMARY KEY,
            Kcb_struct REAL,
            c_aero REAL,
            c_AC REAL,
            De_mm REAL,
            Dr_mm REAL,
            REW_mm REAL,
            tau_e_h REAL,
            Ke_prev REAL,
            last_irrigation_ts REAL,
            FOREIGN KEY (plant_id) REFERENCES pots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS etkc_cfg (
            plant_id TEXT PRIMARY KEY,
            json TEXT NOT NULL,
            FOREIGN KEY (plant_id) REFERENCES pots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS etkc_metrics (
            ts REAL NOT NULL,
            plant_id TEXT NOT NULL,
            json TEXT NOT NULL,
            FOREIGN KEY (plant_id) REFERENCES pots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS etkc_metrics_daily (
            day TEXT NOT NULL,
            plant_id TEXT NOT NULL,
            json TEXT NOT NULL,
            PRIMARY KEY (day, plant_id),
            FOREIGN KEY (plant_id) REFERENCES pots(id) ON DELETE CASCADE
        );
        """
    )
    conn.commit()


@contextmanager
def connect_ctx(db_path: Optional[Path | str] = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager returning a connection with schema ensured."""

    conn = connect(db_path)
    try:
        ensure_schema(conn)
        yield conn
    finally:
        conn.close()
