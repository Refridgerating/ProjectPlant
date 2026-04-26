from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

from db_models.migrations import ensure_schema_version


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    iso = _ensure_utc(value).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _round_coord(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat, 4), round(lon, 4))


@dataclass(frozen=True)
class HrrrSolarHistoryRow:
    lat: float
    lon: float
    valid_time: datetime
    solar_radiation_w_m2: float
    run_cycle: datetime
    forecast_hour: int
    fetched_at: datetime


class HrrrSolarHistoryStore:
    def __init__(self, *, db_path: Path, retention_hours: float = 72.0) -> None:
        self._db_path = Path(db_path)
        self._retention = max(retention_hours, 0.0)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @property
    def db_path(self) -> Path:
        return self._db_path

    @property
    def retention_hours(self) -> float:
        return self._retention

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            ensure_schema_version(conn)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hrrr_solar_history (
                    lat REAL NOT NULL,
                    lon REAL NOT NULL,
                    valid_time TEXT NOT NULL,
                    solar_radiation_w_m2 REAL NOT NULL,
                    run_cycle TEXT NOT NULL,
                    forecast_hour INTEGER NOT NULL,
                    fetched_at TEXT NOT NULL,
                    PRIMARY KEY (lat, lon, valid_time)
                );
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_hrrr_solar_history_lookup
                ON hrrr_solar_history(lat, lon, valid_time);
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_hrrr_solar_history_valid_time
                ON hrrr_solar_history(valid_time);
                """
            )
            conn.commit()

    def upsert(
        self,
        *,
        lat: float,
        lon: float,
        valid_time: datetime,
        solar_radiation_w_m2: float,
        run_cycle: datetime,
        forecast_hour: int,
        fetched_at: datetime | None = None,
    ) -> HrrrSolarHistoryRow:
        rounded_lat, rounded_lon = _round_coord(lat, lon)
        valid_dt = _ensure_utc(valid_time)
        run_dt = _ensure_utc(run_cycle)
        fetched_dt = _ensure_utc(fetched_at or datetime.now(timezone.utc))
        row = HrrrSolarHistoryRow(
            lat=rounded_lat,
            lon=rounded_lon,
            valid_time=valid_dt,
            solar_radiation_w_m2=float(solar_radiation_w_m2),
            run_cycle=run_dt,
            forecast_hour=int(forecast_hour),
            fetched_at=fetched_dt,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO hrrr_solar_history (
                    lat,
                    lon,
                    valid_time,
                    solar_radiation_w_m2,
                    run_cycle,
                    forecast_hour,
                    fetched_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(lat, lon, valid_time) DO UPDATE SET
                    solar_radiation_w_m2 = excluded.solar_radiation_w_m2,
                    run_cycle = excluded.run_cycle,
                    forecast_hour = excluded.forecast_hour,
                    fetched_at = excluded.fetched_at;
                """,
                (
                    row.lat,
                    row.lon,
                    _isoformat(row.valid_time),
                    row.solar_radiation_w_m2,
                    _isoformat(row.run_cycle),
                    row.forecast_hour,
                    _isoformat(row.fetched_at),
                ),
            )
            conn.commit()
        return row

    def get(self, lat: float, lon: float, valid_time: datetime) -> HrrrSolarHistoryRow | None:
        rounded_lat, rounded_lon = _round_coord(lat, lon)
        valid_iso = _isoformat(_ensure_utc(valid_time))
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT lat, lon, valid_time, solar_radiation_w_m2, run_cycle, forecast_hour, fetched_at
                FROM hrrr_solar_history
                WHERE lat = ? AND lon = ? AND valid_time = ?
                LIMIT 1;
                """,
                (rounded_lat, rounded_lon, valid_iso),
            ).fetchone()
        return self._row_from_db(row)

    def latest_for(self, lat: float, lon: float) -> HrrrSolarHistoryRow | None:
        rounded_lat, rounded_lon = _round_coord(lat, lon)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT lat, lon, valid_time, solar_radiation_w_m2, run_cycle, forecast_hour, fetched_at
                FROM hrrr_solar_history
                WHERE lat = ? AND lon = ?
                ORDER BY valid_time DESC
                LIMIT 1;
                """,
                (rounded_lat, rounded_lon),
            ).fetchone()
        return self._row_from_db(row)

    def list_range(
        self,
        lat: float,
        lon: float,
        *,
        start: datetime,
        end: datetime,
    ) -> list[HrrrSolarHistoryRow]:
        rounded_lat, rounded_lon = _round_coord(lat, lon)
        start_iso = _isoformat(_ensure_utc(start))
        end_iso = _isoformat(_ensure_utc(end))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT lat, lon, valid_time, solar_radiation_w_m2, run_cycle, forecast_hour, fetched_at
                FROM hrrr_solar_history
                WHERE lat = ? AND lon = ? AND valid_time >= ? AND valid_time <= ?
                ORDER BY valid_time ASC;
                """,
                (rounded_lat, rounded_lon, start_iso, end_iso),
            ).fetchall()
        return [parsed for row in rows if (parsed := self._row_from_db(row)) is not None]

    def prune(self, *, now: datetime | None = None) -> int:
        if self._retention <= 0:
            return 0
        cutoff = _ensure_utc(now or datetime.now(timezone.utc)) - timedelta(hours=self._retention)
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM hrrr_solar_history WHERE valid_time < ?;",
                (_isoformat(cutoff),),
            )
            conn.commit()
            return int(cursor.rowcount or 0)

    def stats(self) -> dict[str, object]:
        exists = self._db_path.exists()
        size_bytes = self._db_path.stat().st_size if exists else 0
        with self._connect() as conn:
            count_row = conn.execute("SELECT COUNT(1) AS row_count FROM hrrr_solar_history;").fetchone()
            bounds_row = conn.execute(
                """
                SELECT
                    MIN(valid_time) AS oldest_valid_time,
                    MAX(valid_time) AS newest_valid_time,
                    MIN(fetched_at) AS oldest_fetched_at,
                    MAX(fetched_at) AS newest_fetched_at
                FROM hrrr_solar_history;
                """
            ).fetchone()
        row_count = int(count_row["row_count"]) if count_row is not None else 0
        oldest_valid = _parse_iso(bounds_row["oldest_valid_time"]) if bounds_row is not None else None
        newest_valid = _parse_iso(bounds_row["newest_valid_time"]) if bounds_row is not None else None
        oldest_fetched = _parse_iso(bounds_row["oldest_fetched_at"]) if bounds_row is not None else None
        newest_fetched = _parse_iso(bounds_row["newest_fetched_at"]) if bounds_row is not None else None
        return {
            "db_path": str(self._db_path),
            "exists": exists,
            "size_bytes": size_bytes,
            "row_count": row_count,
            "retention_hours": self._retention,
            "oldest_valid_time": oldest_valid,
            "newest_valid_time": newest_valid,
            "oldest_fetched_at": oldest_fetched,
            "newest_fetched_at": newest_fetched,
        }

    @staticmethod
    def _row_from_db(row: sqlite3.Row | None) -> HrrrSolarHistoryRow | None:
        if row is None:
            return None
        valid_time = _parse_iso(row["valid_time"])
        run_cycle = _parse_iso(row["run_cycle"])
        fetched_at = _parse_iso(row["fetched_at"])
        if valid_time is None or run_cycle is None or fetched_at is None:
            return None
        return HrrrSolarHistoryRow(
            lat=float(row["lat"]),
            lon=float(row["lon"]),
            valid_time=valid_time,
            solar_radiation_w_m2=float(row["solar_radiation_w_m2"]),
            run_cycle=run_cycle,
            forecast_hour=int(row["forecast_hour"]),
            fetched_at=fetched_at,
        )


__all__ = [
    "HrrrSolarHistoryRow",
    "HrrrSolarHistoryStore",
]
