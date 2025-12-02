from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import settings

MIN_WINDOW_HOURS = 1.0 / 60.0  # one minute


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_iso(timestamp: datetime) -> str:
    iso = timestamp.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def _coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return None
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            result = float(value.strip())
        except ValueError:
            return None
        if result != result or result in (float("inf"), float("-inf")):
            return None
        return result
    return None


def _coerce_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "on", "yes"}:
            return True
        if lowered in {"0", "false", "off", "no"}:
            return False
    return None


@dataclass(slots=True)
class PotTelemetryRow:
    pot_id: str
    timestamp_iso: str
    timestamp_ms: Optional[int]
    moisture: Optional[float]
    temperature: Optional[float]
    humidity: Optional[float]
    pressure: Optional[float]
    solar: Optional[float]
    wind: Optional[float]
    valve_open: Optional[bool]
    fan_on: Optional[bool]
    mister_on: Optional[bool]
    flow_rate: Optional[float]
    water_low: Optional[bool]
    water_cutoff: Optional[bool]
    soil_raw: Optional[float]
    source: str
    request_id: Optional[str]

    def as_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "potId": self.pot_id,
            "timestamp": self.timestamp_iso,
            "timestampMs": self.timestamp_ms,
            "moisture_pct": self.moisture,
            "temperature_c": self.temperature,
            "humidity_pct": self.humidity,
            "pressure_hpa": self.pressure,
            "solar_radiation_w_m2": self.solar,
            "wind_speed_m_s": self.wind,
            "source": self.source,
            "requestId": self.request_id,
        }
        if self.valve_open is not None:
            payload["valve_open"] = self.valve_open
            payload["valveOpen"] = self.valve_open
        if self.fan_on is not None:
            payload["fan_on"] = self.fan_on
            payload["fanOn"] = self.fan_on
        if self.mister_on is not None:
            payload["mister_on"] = self.mister_on
            payload["misterOn"] = self.mister_on
        if self.flow_rate is not None:
            payload["flow_rate_lpm"] = self.flow_rate
            payload["flowRateLpm"] = self.flow_rate
        if self.water_low is not None:
            payload["waterLow"] = self.water_low
        if self.water_cutoff is not None:
            payload["waterCutoff"] = self.water_cutoff
        if self.soil_raw is not None:
            payload["soilRaw"] = self.soil_raw
        return payload


class PotTelemetryStore:
    def __init__(
        self,
        *,
        db_path: Path,
        retention_hours: float,
        max_rows: int,
    ) -> None:
        self._db_path = db_path
        self._retention = max(retention_hours, 0.0)
        self._max_rows = max(max_rows, 100)
        self._lock = asyncio.Lock()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, detect_types=sqlite3.PARSE_DECLTYPES, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pot_telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pot_id TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    ts_ms INTEGER,
                    moisture REAL,
                    temperature REAL,
                    humidity REAL,
                    pressure REAL,
                    solar REAL,
                    wind REAL,
                    valve_open INTEGER,
                    flow_rate REAL,
                    water_low INTEGER,
                    water_cutoff INTEGER,
                    soil_raw REAL,
                    source TEXT NOT NULL,
                    request_id TEXT
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_pot_ts ON pot_telemetry(pot_id, ts);")
            for column_def in (
                ("water_low", "INTEGER"),
                ("water_cutoff", "INTEGER"),
                ("soil_raw", "REAL"),
                ("fan_on", "INTEGER"),
                ("mister_on", "INTEGER"),
            ):
                try:
                    conn.execute(
                        f"ALTER TABLE pot_telemetry ADD COLUMN {column_def[0]} {column_def[1]};"
                    )
                except sqlite3.OperationalError:
                    # Column already exists
                    pass
            conn.commit()

    async def record(
        self,
        *,
        pot_id: str,
        timestamp: Optional[str],
        timestamp_ms: Optional[int | float],
        moisture: Any,
        temperature: Any,
        humidity: Any,
        pressure: Any = None,
        solar: Any = None,
        wind: Any = None,
        valve_open: Any = None,
        fan_on: Any = None,
        mister_on: Any = None,
        flow_rate: Any = None,
        water_low: Any = None,
        water_cutoff: Any = None,
        soil_raw: Any = None,
        source: str = "sensor",
        request_id: Optional[str] = None,
    ) -> None:
        normalized_pot = (pot_id or "").strip().lower()
        if not normalized_pot:
            return
        iso = self._normalize_timestamp(timestamp, timestamp_ms)
        row = PotTelemetryRow(
            pot_id=normalized_pot,
            timestamp_iso=iso,
            timestamp_ms=int(timestamp_ms) if isinstance(timestamp_ms, (int, float)) else None,
            moisture=_coerce_float(moisture),
            temperature=_coerce_float(temperature),
            humidity=_coerce_float(humidity),
            pressure=_coerce_float(pressure),
            solar=_coerce_float(solar),
            wind=_coerce_float(wind),
            valve_open=_coerce_bool(valve_open),
            fan_on=_coerce_bool(fan_on),
            mister_on=_coerce_bool(mister_on),
            flow_rate=_coerce_float(flow_rate),
            water_low=_coerce_bool(water_low),
            water_cutoff=_coerce_bool(water_cutoff),
            soil_raw=_coerce_float(soil_raw),
            source=source or "sensor",
            request_id=request_id,
        )

        async with self._lock:
            await asyncio.to_thread(self._insert_row, row)

    def _insert_row(self, row: PotTelemetryRow) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO pot_telemetry
                    (pot_id, ts, ts_ms, moisture, temperature, humidity, pressure, solar, wind, valve_open, fan_on, mister_on, flow_rate, water_low, water_cutoff, soil_raw, source, request_id)
                VALUES
                    (:pot_id, :ts, :ts_ms, :moisture, :temperature, :humidity, :pressure, :solar, :wind, :valve_open, :fan_on, :mister_on, :flow_rate, :water_low, :water_cutoff, :soil_raw, :source, :request_id);
                """,
                {
                    "pot_id": row.pot_id,
                    "ts": row.timestamp_iso,
                    "ts_ms": row.timestamp_ms,
                    "moisture": row.moisture,
                    "temperature": row.temperature,
                    "humidity": row.humidity,
                    "pressure": row.pressure,
                    "solar": row.solar,
                    "wind": row.wind,
                    "valve_open": 1 if row.valve_open is True else 0 if row.valve_open is False else None,
                    "fan_on": 1 if row.fan_on is True else 0 if row.fan_on is False else None,
                    "mister_on": 1 if row.mister_on is True else 0 if row.mister_on is False else None,
                    "flow_rate": row.flow_rate,
                    "water_low": 1 if row.water_low is True else 0 if row.water_low is False else None,
                    "water_cutoff": 1 if row.water_cutoff is True else 0 if row.water_cutoff is False else None,
                    "soil_raw": row.soil_raw,
                    "source": row.source,
                    "request_id": row.request_id,
                },
            )
            if self._retention > 0:
                cutoff_iso = _ensure_iso(_utc_now() - timedelta(hours=self._retention))
                conn.execute("DELETE FROM pot_telemetry WHERE ts < ?", (cutoff_iso,))

            total_rows = conn.execute("SELECT COUNT(1) FROM pot_telemetry").fetchone()[0]
            if total_rows > self._max_rows:
                surplus = total_rows - self._max_rows
                conn.execute(
                    """
                    DELETE FROM pot_telemetry
                    WHERE id IN (
                        SELECT id FROM pot_telemetry ORDER BY ts ASC LIMIT ?
                    );
                    """,
                    (surplus,),
                )
            conn.commit()

    async def list(
        self,
        pot_id: str,
        *,
        hours: float = 24.0,
        limit: int = 1440,
    ) -> List[Dict[str, Any]]:
        if not pot_id:
            return []
        window = max(hours, MIN_WINDOW_HOURS)
        cutoff = _ensure_iso(_utc_now() - timedelta(hours=window))
        clamped_limit = max(1, min(limit, self._max_rows))
        async with self._lock:
            rows = await asyncio.to_thread(self._select_rows, pot_id, cutoff, clamped_limit)
        return [row.as_payload() for row in rows]

    def _select_rows(self, pot_id: str, cutoff_iso: str, limit: int) -> List[PotTelemetryRow]:
        normalized = (pot_id or "").strip().lower()
        if not normalized:
            return []
        with self._connect() as conn:
            cursor = conn.execute(
                """
                SELECT pot_id, ts, ts_ms, moisture, temperature, humidity, pressure, solar, wind, valve_open, fan_on, mister_on, flow_rate, water_low, water_cutoff, soil_raw, source, request_id
                FROM pot_telemetry
                WHERE pot_id = ? AND ts >= ?
                ORDER BY ts ASC
                LIMIT ?;
                """,
                (normalized, cutoff_iso, limit),
            )
            results: List[PotTelemetryRow] = []
            for row in cursor:
                results.append(
                    PotTelemetryRow(
                        pot_id=row["pot_id"],
                        timestamp_iso=row["ts"],
                        timestamp_ms=row["ts_ms"],
                        moisture=row["moisture"],
                        temperature=row["temperature"],
                        humidity=row["humidity"],
                        pressure=row["pressure"],
                        solar=row["solar"],
                        wind=row["wind"],
                        valve_open=bool(row["valve_open"]) if row["valve_open"] is not None else None,
                        fan_on=bool(row["fan_on"]) if row["fan_on"] is not None else None,
                        mister_on=bool(row["mister_on"]) if row["mister_on"] is not None else None,
                        flow_rate=row["flow_rate"],
                        water_low=bool(row["water_low"]) if row["water_low"] is not None else None,
                        water_cutoff=bool(row["water_cutoff"]) if row["water_cutoff"] is not None else None,
                        soil_raw=row["soil_raw"],
                        source=row["source"],
                        request_id=row["request_id"],
                    )
                )
            return results

    async def clear(self) -> None:
        async with self._lock:
            await asyncio.to_thread(self._truncate)

    def _truncate(self) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM pot_telemetry;")
            conn.commit()

    def _normalize_timestamp(self, timestamp: Optional[str], timestamp_ms: Optional[int | float]) -> str:
        if isinstance(timestamp, str) and timestamp.strip():
            try:
                dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return _ensure_iso(dt)
            except ValueError:
                pass
        if isinstance(timestamp_ms, (int, float)):
            try:
                dt = datetime.fromtimestamp(float(timestamp_ms) / 1000.0, tz=timezone.utc)
                return _ensure_iso(dt)
            except (OverflowError, ValueError):
                pass
        return _ensure_iso(_utc_now())


def _resolve_db_path() -> Path:
    configured = settings.pot_telemetry_db
    return Path(configured)


plant_telemetry_store = PotTelemetryStore(
    db_path=_resolve_db_path(),
    retention_hours=settings.pot_telemetry_retention_hours,
    max_rows=settings.pot_telemetry_max_rows,
)
