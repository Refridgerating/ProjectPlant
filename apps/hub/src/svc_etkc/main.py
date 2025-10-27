"""FastAPI microservice providing ET-based irrigation control endpoints."""

from __future__ import annotations

import dataclasses
from typing import Any, Dict, List, Optional

import sqlite3
from fastapi import Depends, FastAPI, Query

from etkc.controller import StepResult
from etkc.state import StepSensors
from .db import connect, ensure_schema
from .service import (
    PotStatePatch,
    fetch_pot,
    fetch_state,
    get_db,
    list_metrics,
    run_step_with_persistence,
    upsert_state,
)

app = FastAPI(title="ETc Microservice", version="0.1.0")


@app.on_event("startup")
def startup() -> None:
    conn = connect()
    try:
        ensure_schema(conn)
    finally:
        conn.close()


@app.post("/step/{plant_id}", response_model=StepResult)
def run_step(plant_id: str, sensors: StepSensors, db: sqlite3.Connection = Depends(get_db)) -> StepResult:
    return run_step_with_persistence(db, plant_id, sensors)


@app.get("/state/{plant_id}")
def get_state(plant_id: str, db: sqlite3.Connection = Depends(get_db)) -> Dict[str, Any]:
    pot = fetch_pot(db, plant_id)
    state = fetch_state(db, plant_id, pot)
    return dataclasses.asdict(state)


@app.put("/state/{plant_id}")
def patch_state(
    plant_id: str,
    payload: PotStatePatch,
    db: sqlite3.Connection = Depends(get_db),
) -> Dict[str, Any]:
    pot = fetch_pot(db, plant_id)
    current = fetch_state(db, plant_id, pot)
    updated = payload.apply(current)
    upsert_state(db, plant_id, updated)
    return dataclasses.asdict(updated)


@app.get("/metrics/{plant_id}")
def get_metrics(
    plant_id: str,
    since: Optional[float] = Query(None, description="Unix timestamp (seconds) lower bound."),
    limit: int = Query(200, le=2000, description="Maximum number of points to return."),
    db: sqlite3.Connection = Depends(get_db),
) -> List[Dict[str, Any]]:
    return list_metrics(conn=db, plant_id=plant_id, since=since, limit=limit)
