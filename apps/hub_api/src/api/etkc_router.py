"""ETc controller API routes integrated in the hub application."""

from __future__ import annotations

import dataclasses
from datetime import datetime
from typing import Any, Dict, List, Optional

import sqlite3
from fastapi import APIRouter, Depends, HTTPException, Query

from svc_etkc.service import (
    PotStatePatch,
    fetch_pot,
    fetch_state,
    get_db,
    list_metrics,
    run_step_with_persistence,
    upsert_state,
)
from etkc.controller import StepResult
from etkc.state import StepSensors

router = APIRouter(prefix="/api/v1/etkc", tags=["etkc"])


@router.post("/step/{plant_id}", response_model=StepResult)
def api_step(
    plant_id: str,
    sensors: StepSensors,
    db: sqlite3.Connection = Depends(get_db),
) -> StepResult:
    return run_step_with_persistence(db, plant_id, sensors)


@router.get("/state/{plant_id}")
def api_get_state(plant_id: str, db: sqlite3.Connection = Depends(get_db)) -> Dict[str, Any]:
    pot = fetch_pot(db, plant_id)
    state = fetch_state(db, plant_id, pot)
    return dataclasses.asdict(state)


@router.put("/state/{plant_id}")
def api_put_state(
    plant_id: str,
    payload: PotStatePatch,
    db: sqlite3.Connection = Depends(get_db),
) -> Dict[str, Any]:
    pot = fetch_pot(db, plant_id)
    current = fetch_state(db, plant_id, pot)
    updated = payload.apply(current)
    upsert_state(db, plant_id, updated)
    return dataclasses.asdict(updated)


@router.get("/metrics/{plant_id}")
def api_get_metrics(
    plant_id: str,
    since: Optional[str] = Query(
        None,
        description="ISO8601 datetime string; only metrics with ts >= this instant are returned.",
    ),
    limit: int = Query(200, le=2000),
    db: sqlite3.Connection = Depends(get_db),
) -> List[Dict[str, Any]]:
    since_ts = None
    if since is not None:
        try:
            since_ts = datetime.fromisoformat(since).timestamp()
        except ValueError as exc:  # pragma: no cover - FastAPI handles rejections, but guard anyway
            raise HTTPException(status_code=400, detail="Invalid ISO8601 timestamp for 'since'.") from exc
    return list_metrics(conn=db, plant_id=plant_id, since=since_ts, limit=limit)
