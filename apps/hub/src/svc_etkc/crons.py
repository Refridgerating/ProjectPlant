"""Utility job for rolling up hourly metrics into daily aggregates."""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple

from .db import DEFAULT_DB_PATH, connect, ensure_schema


def rollup_daily(db_path: Optional[Path | str] = None, since: Optional[float] = None) -> Dict[Tuple[str, str], Dict[str, float]]:
    """Aggregate hourly metrics into daily totals.

    Args:
        db_path: Optional path to the SQLite database.
        since: Optional unix timestamp lower bound (seconds). Defaults to start.

    Returns:
        Dictionary keyed by ``(plant_id, YYYY-MM-DD)`` with aggregated sums.
    """

    conn = connect(db_path)
    ensure_schema(conn)
    try:
        params = []
        query = "SELECT ts, plant_id, json FROM etkc_metrics"
        if since is not None:
            query += " WHERE ts >= ?"
            params.append(since)

        rows = conn.execute(query, params).fetchall()
        aggregates: Dict[Tuple[str, str], Dict[str, float]] = defaultdict(lambda: defaultdict(float))

        for row in rows:
            ts = row["ts"]
            plant_id = row["plant_id"]
            payload = json.loads(row["json"])
            day = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()

            key = (plant_id, day)
            aggregates[key]["count"] += 1.0
            for field in ("ET0_mm", "ETc_model_mm", "ETc_obs_mm", "Ke", "Ks"):
                value = payload.get(field)
                if isinstance(value, (int, float)):
                    aggregates[key][field] += float(value)

        for (plant_id, day), summary in aggregates.items():
            conn.execute(
                """
                INSERT INTO etkc_metrics_daily (day, plant_id, json)
                VALUES (?, ?, ?)
                ON CONFLICT(day, plant_id) DO UPDATE SET json = excluded.json
                """,
                (day, plant_id, json.dumps(summary)),
            )

        conn.commit()
        return aggregates
    finally:
        conn.close()


if __name__ == "__main__":
    rollup_daily()
