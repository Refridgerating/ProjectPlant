"""SQLite helpers and CRUD operations for ETc controller data."""

from __future__ import annotations

import dataclasses
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Generator, Iterable, Optional, Tuple

from .state import PotState, PotStatic, StepConfig

DEFAULT_DB_PATH: Path = Path(__file__).resolve().parent / "etkc.sqlite3"


def connect(path: Optional[Path | str] = None) -> sqlite3.Connection:
    """Return a SQLite connection with row factory configured."""

    db_path = Path(path) if path is not None else DEFAULT_DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create tables used by the ETc controller if missing."""

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
        """
    )
    conn.commit()


@contextmanager
def connect_ctx(path: Optional[Path | str] = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager yielding a connection with the schema ensured."""

    conn = connect(path)
    try:
        ensure_schema(conn)
        yield conn
    finally:
        conn.close()


def insert_or_update_pot(conn: sqlite3.Connection, pot: PotStatic, pot_id: str) -> None:
    """Insert or update a pot record."""

    conn.execute(
        """
        INSERT INTO pots (id, area_m2, depth_m, theta_fc, theta_wp, class_name)
        VALUES (:id, :area_m2, :depth_m, :theta_fc, :theta_wp, :class_name)
        ON CONFLICT(id) DO UPDATE SET
            area_m2=excluded.area_m2,
            depth_m=excluded.depth_m,
            theta_fc=excluded.theta_fc,
            theta_wp=excluded.theta_wp,
            class_name=excluded.class_name
        """,
        {
            "id": pot_id,
            "area_m2": pot.pot_area_m2,
            "depth_m": pot.depth_m,
            "theta_fc": pot.theta_fc,
            "theta_wp": pot.theta_wp,
            "class_name": pot.class_name,
        },
    )
    conn.commit()


def fetch_pot(conn: sqlite3.Connection, pot_id: str) -> Optional[PotStatic]:
    """Return a PotStatic record or None."""

    row = conn.execute("SELECT * FROM pots WHERE id = ?", (pot_id,)).fetchone()
    if row is None:
        return None
    return PotStatic(
        pot_area_m2=row["area_m2"],
        depth_m=row["depth_m"],
        theta_fc=row["theta_fc"],
        theta_wp=row["theta_wp"],
        class_name=row["class_name"],
    )


def upsert_state(conn: sqlite3.Connection, plant_id: str, state: PotState) -> None:
    """Insert or update a pot state record."""

    data = dataclasses.asdict(state)
    conn.execute(
        """
        INSERT INTO etkc_state (
            plant_id, Kcb_struct, c_aero, c_AC, De_mm, Dr_mm, REW_mm, tau_e_h, Ke_prev, last_irrigation_ts
        ) VALUES (
            :plant_id, :Kcb_struct, :c_aero, :c_AC, :De_mm, :Dr_mm, :REW_mm, :tau_e_h, :Ke_prev, :last_irrigation_ts
        )
        ON CONFLICT(plant_id) DO UPDATE SET
            Kcb_struct=excluded.Kcb_struct,
            c_aero=excluded.c_aero,
            c_AC=excluded.c_AC,
            De_mm=excluded.De_mm,
            Dr_mm=excluded.Dr_mm,
            REW_mm=excluded.REW_mm,
            tau_e_h=excluded.tau_e_h,
            Ke_prev=excluded.Ke_prev,
            last_irrigation_ts=excluded.last_irrigation_ts
        """,
        {"plant_id": plant_id, **data},
    )
    conn.commit()


def fetch_state(conn: sqlite3.Connection, plant_id: str) -> Optional[PotState]:
    """Return a stored PotState or None."""

    row = conn.execute("SELECT * FROM etkc_state WHERE plant_id = ?", (plant_id,)).fetchone()
    if row is None:
        return None
    return PotState(
        Kcb_struct=row["Kcb_struct"],
        c_aero=row["c_aero"],
        c_AC=row["c_AC"],
        De_mm=row["De_mm"],
        Dr_mm=row["Dr_mm"],
        REW_mm=row["REW_mm"],
        tau_e_h=row["tau_e_h"],
        Ke_prev=row["Ke_prev"],
        last_irrigation_ts=row["last_irrigation_ts"],
    )


def save_config(conn: sqlite3.Connection, plant_id: str, cfg: StepConfig) -> None:
    """Persist a StepConfig for the plant."""

    conn.execute(
        "INSERT OR REPLACE INTO etkc_cfg (plant_id, json) VALUES (?, ?)",
        (plant_id, json.dumps(cfg.model_dump())),
    )
    conn.commit()


def fetch_config(conn: sqlite3.Connection, plant_id: str) -> Optional[StepConfig]:
    """Return a stored StepConfig if available."""

    row = conn.execute("SELECT json FROM etkc_cfg WHERE plant_id = ?", (plant_id,)).fetchone()
    if row is None:
        return None
    payload = json.loads(row["json"])
    return StepConfig.model_validate(payload)


def insert_metric(conn: sqlite3.Connection, plant_id: str, ts: float, metric_json: Dict[str, Any]) -> None:
    """Store a StepResult payload as JSON."""

    conn.execute(
        "INSERT INTO etkc_metrics (ts, plant_id, json) VALUES (?, ?, ?)",
        (ts, plant_id, json.dumps(metric_json)),
    )
    conn.commit()


def list_metrics(
    conn: sqlite3.Connection,
    plant_id: str,
    since: Optional[float] = None,
    limit: int = 200,
) -> Iterable[Tuple[float, Dict[str, Any]]]:
    """Iterate over stored metrics as (timestamp, payload) tuples."""

    params = [plant_id]
    query = "SELECT ts, json FROM etkc_metrics WHERE plant_id = ?"
    if since is not None:
        query += " AND ts >= ?"
        params.append(since)
    query += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)

    for row in conn.execute(query, params).fetchall():
        yield row["ts"], json.loads(row["json"])
