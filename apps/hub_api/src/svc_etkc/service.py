"""Shared helpers for ETc service integrations."""

from __future__ import annotations

import dataclasses
import json
import sqlite3
import time
from typing import Any, Dict, Generator, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel

from etkc.controller import StepResult, step
from etkc.state import PotState, PotStatic, StepConfig, StepSensors, default_state_for
from svc_etkc.db import connect, ensure_schema


def get_db() -> Generator[sqlite3.Connection, None, None]:
    conn = connect()
    ensure_schema(conn)
    try:
        yield conn
    finally:
        conn.close()


class PotStatePatch(BaseModel):
    Kcb_struct: Optional[float] = None
    c_aero: Optional[float] = None
    c_AC: Optional[float] = None
    De_mm: Optional[float] = None
    Dr_mm: Optional[float] = None
    REW_mm: Optional[float] = None
    tau_e_h: Optional[float] = None
    Ke_prev: Optional[float] = None
    last_irrigation_ts: Optional[float] = None

    def apply(self, state: PotState) -> PotState:
        data = dataclasses.asdict(state)
        for key, value in self.model_dump(exclude_none=True).items():
            data[key] = value
        return PotState(**data)


def _row_to_pot_static(row: sqlite3.Row) -> PotStatic:
    return PotStatic(
        pot_area_m2=row["area_m2"],
        depth_m=row["depth_m"],
        theta_fc=row["theta_fc"],
        theta_wp=row["theta_wp"],
        class_name=row["class_name"],
    )


def fetch_pot(conn: sqlite3.Connection, plant_id: str) -> PotStatic:
    cur = conn.execute("SELECT * FROM pots WHERE id = ?", (plant_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Unknown plant '{plant_id}'.")
    return _row_to_pot_static(row)


def fetch_state(conn: sqlite3.Connection, plant_id: str, pot: PotStatic) -> PotState:
    cur = conn.execute("SELECT * FROM etkc_state WHERE plant_id = ?", (plant_id,))
    row = cur.fetchone()
    if row is None:
        state = default_state_for(pot.class_name)
        upsert_state(conn, plant_id, state)
        return state
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


def fetch_config(conn: sqlite3.Connection, plant_id: str) -> StepConfig:
    cur = conn.execute("SELECT json FROM etkc_cfg WHERE plant_id = ?", (plant_id,))
    row = cur.fetchone()
    if row is None:
        cfg = StepConfig()
        conn.execute(
            "INSERT OR REPLACE INTO etkc_cfg (plant_id, json) VALUES (?, ?)",
            (plant_id, json.dumps(cfg.model_dump())),
        )
        conn.commit()
        return cfg

    payload = json.loads(row["json"])
    return StepConfig.model_validate(payload)


def upsert_state(conn: sqlite3.Connection, plant_id: str, state: PotState) -> None:
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


def store_metric(
    conn: sqlite3.Connection,
    plant_id: str,
    result: StepResult,
    ts: Optional[float] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    timestamp = time.time() if ts is None else ts
    payload = result.model_dump(mode="json", exclude_none=True)
    if metadata:
        merged = dict(result.metadata or {})
        merged.update(metadata)
        payload["metadata"] = merged
    elif result.metadata:
        payload["metadata"] = result.metadata

    conn.execute(
        "INSERT INTO etkc_metrics (ts, plant_id, json) VALUES (?, ?, ?)",
        (timestamp, plant_id, json.dumps(payload)),
    )
    conn.commit()


def list_metrics(
    conn: sqlite3.Connection,
    plant_id: str,
    since: Optional[float] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    params: List[Any] = [plant_id]
    query = "SELECT ts, json FROM etkc_metrics WHERE plant_id = ?"
    if since is not None:
        query += " AND ts >= ?"
        params.append(since)
    query += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    results = []
    for row in rows:
        payload = json.loads(row["json"])
        payload["ts"] = row["ts"]
        results.append(payload)
    return list(reversed(results))


def run_step_with_persistence(
    conn: sqlite3.Connection,
    plant_id: str,
    sensors: StepSensors,
) -> StepResult:
    pot = fetch_pot(conn, plant_id)
    state = fetch_state(conn, plant_id, pot)
    cfg = fetch_config(conn, plant_id)

    new_state, result = step(pot, state, sensors, cfg)
    upsert_state(conn, plant_id, new_state)
    store_metric(conn, plant_id, result)
    return result
