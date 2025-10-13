"""ProjectPlant live data logger.

This module maintains a rolling live window inside SQLite and continuously
archives older rows into append-only CSV files. It is designed to ingest
JSON blobs from a local weather source (or any other JSON publisher) and
store normalized fields alongside the raw payload for later analysis.

Usage (stand-alone script):

    python -m pi.logger.live_logger \\
        --weather-url http://localhost:9000/api/weather/live

Environment variables mirror the CLI flags and take precedence over defaults.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.error import URLError
from urllib.request import urlopen

LOGGER = logging.getLogger("projectplant.live_logger")


def _env_flag(name: str, default: Optional[str] = None) -> Optional[str]:
    """Fetch environment variable for CLI compatibility."""
    return os.getenv(name, default)


def _parse_dt_iso(ts: str) -> datetime:
    """Parse ISO-8601 timestamps with support for Z suffix."""
    # Allow bare integers as milliseconds-since-epoch
    if ts.isdigit():
        as_int = int(ts)
        # Heuristic: treat 13-digit numbers as ms, otherwise seconds
        if len(ts) >= 13:
            return datetime.fromtimestamp(as_int / 1000, tz=timezone.utc)
        return datetime.fromtimestamp(as_int, tz=timezone.utc)

    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def _coerce_float(value: Any) -> Optional[float]:
    """Attempt to coerce a value into float; return None on failure."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_first(data: Dict[str, Any], keys: Iterable[str]) -> Optional[Any]:
    """Return the first matching key present in the dict."""
    for key in keys:
        if key in data:
            return data[key]
    return None


@dataclass
class NormalizedRecord:
    """Normalized weather/telemetry record."""

    ts: datetime
    source: str
    raw_json: str
    temperature_c: Optional[float] = None
    humidity_pct: Optional[float] = None
    pressure_hpa: Optional[float] = None
    wind_speed_mps: Optional[float] = None
    wind_dir_deg: Optional[float] = None
    rainfall_mm: Optional[float] = None

    def as_row(self) -> Dict[str, Any]:
        """Return dict matching live_readings schema."""
        return {
            "ts": self.ts.isoformat().replace("+00:00", "Z"),
            "source": self.source,
            "temperature_c": self.temperature_c,
            "humidity_pct": self.humidity_pct,
            "pressure_hpa": self.pressure_hpa,
            "wind_speed_mps": self.wind_speed_mps,
            "wind_dir_deg": self.wind_dir_deg,
            "rainfall_mm": self.rainfall_mm,
            "raw_json": self.raw_json,
        }


class LiveArchive:
    """Manage live readings with rolling retention plus historical archive."""

    def __init__(
        self,
        db_path: Path,
        history_dir: Path,
        retention_hours: int = 72,
    ) -> None:
        history_dir.mkdir(parents=True, exist_ok=True)
        db_path.parent.mkdir(parents=True, exist_ok=True)

        self._db_path = db_path
        self._history_dir = history_dir
        self._retention = timedelta(hours=retention_hours)

        self._conn = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS live_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                source TEXT NOT NULL,
                temperature_c REAL,
                humidity_pct REAL,
                pressure_hpa REAL,
                wind_speed_mps REAL,
                wind_dir_deg REAL,
                rainfall_mm REAL,
                raw_json TEXT NOT NULL
            );
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_live_ts ON live_readings(ts);"
        )
        self._conn.commit()

    def insert(self, record: NormalizedRecord) -> None:
        """Insert a normalized record into the live database."""
        row = record.as_row()
        LOGGER.debug("Insert live reading ts=%s source=%s", row["ts"], row["source"])
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO live_readings(ts, source, temperature_c, humidity_pct,
                                          pressure_hpa, wind_speed_mps,
                                          wind_dir_deg, rainfall_mm, raw_json)
                VALUES (:ts, :source, :temperature_c, :humidity_pct, :pressure_hpa,
                        :wind_speed_mps, :wind_dir_deg, :rainfall_mm, :raw_json);
                """,
                row,
            )

    def archive_old(self) -> int:
        """Move rows older than retention into daily CSV archives.

        Returns the number of rows archived.
        """
        cutoff = datetime.now(timezone.utc) - self._retention
        cutoff_iso = cutoff.isoformat().replace("+00:00", "Z")

        LOGGER.debug("Archiving rows older than %s", cutoff_iso)
        rows = self._conn.execute(
            """
            SELECT id, ts, source, temperature_c, humidity_pct, pressure_hpa,
                   wind_speed_mps, wind_dir_deg, rainfall_mm, raw_json
            FROM live_readings
            WHERE ts < ?
            ORDER BY ts ASC;
            """,
            (cutoff_iso,),
        ).fetchall()
        if not rows:
            return 0

        # Group by YYYY-MM-DD for file naming
        grouped: Dict[str, list] = {}
        for row in rows:
            ts: str = row["ts"]
            day = ts[:10]
            grouped.setdefault(day, []).append(row)

        archived_ids = []
        for day, day_rows in grouped.items():
            month_dir = self._history_dir / day[:7]
            month_dir.mkdir(parents=True, exist_ok=True)
            out_file = month_dir / f"{day}.csv"
            write_header = not out_file.exists()
            with out_file.open("a", newline="", encoding="utf-8") as fh:
                writer = csv.writer(fh)
                if write_header:
                    writer.writerow(
                        [
                            "id",
                            "ts",
                            "source",
                            "temperature_c",
                            "humidity_pct",
                            "pressure_hpa",
                            "wind_speed_mps",
                            "wind_dir_deg",
                            "rainfall_mm",
                            "raw_json",
                        ]
                    )
                for row in day_rows:
                    writer.writerow(
                        [
                            row["id"],
                            row["ts"],
                            row["source"],
                            row["temperature_c"],
                            row["humidity_pct"],
                            row["pressure_hpa"],
                            row["wind_speed_mps"],
                            row["wind_dir_deg"],
                            row["rainfall_mm"],
                            row["raw_json"],
                        ]
                    )
                    archived_ids.append(row["id"])

        if archived_ids:
            placeholders = ",".join("?" for _ in archived_ids)
            with self._conn:
                self._conn.execute(
                    f"DELETE FROM live_readings WHERE id IN ({placeholders});",
                    archived_ids,
                )

        LOGGER.info("Archived %d rows before %s", len(archived_ids), cutoff_iso)
        return len(archived_ids)


def normalize_weather_payload(payload: Dict[str, Any], source: str) -> NormalizedRecord:
    """Normalize a weather payload into a standard record."""
    ts_raw = (
        _extract_first(
            payload,
            ("timestamp", "ts", "time", "datetime", "observed_at", "epoch"),
        )
        or datetime.now(timezone.utc).isoformat()
    )

    if isinstance(ts_raw, (int, float)):
        ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
    else:
        ts = _parse_dt_iso(str(ts_raw))
    ts = ts.astimezone(timezone.utc)

    temperature = _extract_first(payload, ("temperature_c", "temp_c", "temperature"))
    humidity = _extract_first(payload, ("humidity_pct", "humidity", "relative_humidity"))
    pressure = _extract_first(payload, ("pressure_hpa", "pressure", "pressure_pa"))
    wind_speed = _extract_first(
        payload, ("wind_speed_mps", "wind_speed", "wind_speed_ms", "wind_speed_kph")
    )
    wind_dir = _extract_first(payload, ("wind_dir_deg", "wind_direction", "wind_bearing"))
    rainfall = _extract_first(payload, ("rainfall_mm", "rain_mm", "precip_mm"))

    # Convert units if needed
    if pressure and isinstance(pressure, (int, float)) and float(pressure) > 2000:
        # Assume Pascals -> convert to hPa
        pressure = float(pressure) / 100.0

    if wind_speed and isinstance(wind_speed, (int, float)) and float(wind_speed) > 60:
        # Assume km/h -> convert to m/s
        wind_speed = float(wind_speed) / 3.6

    record = NormalizedRecord(
        ts=ts,
        source=source,
        raw_json=json.dumps(payload, separators=(",", ":"), sort_keys=True),
        temperature_c=_coerce_float(temperature),
        humidity_pct=_coerce_float(humidity),
        pressure_hpa=_coerce_float(pressure),
        wind_speed_mps=_coerce_float(wind_speed),
        wind_dir_deg=_coerce_float(wind_dir),
        rainfall_mm=_coerce_float(rainfall),
    )
    return record


def fetch_weather(url: str, timeout: float = 10.0) -> Dict[str, Any]:
    """Fetch JSON weather from the given URL."""
    with urlopen(url, timeout=timeout) as response:
        if response.status >= 400:
            raise RuntimeError(f"Weather HTTP {response.status}")
        body = response.read()
    return json.loads(body.decode("utf-8"))


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ProjectPlant live weather logger")
    parser.add_argument("--weather-url", default=_env_flag("WEATHER_URL"))
    parser.add_argument("--source-id", default=_env_flag("WEATHER_SOURCE", "local_weather"))
    parser.add_argument(
        "--db",
        default=_env_flag("WEATHER_LIVE_DB", "data/weather_live.sqlite"),
        help="Path to SQLite file for 72h window",
    )
    parser.add_argument(
        "--history-dir",
        default=_env_flag("WEATHER_HISTORY_DIR", "data/history"),
        help="Directory for daily CSV archives",
    )
    parser.add_argument(
        "--retention-hours",
        type=int,
        default=int(_env_flag("WEATHER_RETENTION_HOURS", "72")),
        help="Retention window for live readings",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=int(_env_flag("WEATHER_POLL_SECONDS", "60")),
        help="Polling interval for the weather source",
    )
    parser.add_argument(
        "--archive-interval",
        type=int,
        default=int(_env_flag("WEATHER_ARCHIVE_INTERVAL", "600")),
        help="How often to run archiver (seconds)",
    )
    parser.add_argument(
        "--log-level",
        default=_env_flag("WEATHER_LOG_LEVEL", "INFO"),
        help="Logging level (DEBUG, INFO, ...)",
    )
    return parser


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    if not args.weather_url:
        LOGGER.error("Weather URL required (use --weather-url or WEATHER_URL env)")
        return 1

    archive = LiveArchive(
        db_path=Path(args.db),
        history_dir=Path(args.history_dir),
        retention_hours=args.retention_hours,
    )

    next_archive = time.monotonic()
    poll_interval = max(5, args.poll_seconds)

    LOGGER.info("Starting logger: url=%s retention=%dh", args.weather_url, args.retention_hours)

    while True:
        start = time.monotonic()
        try:
            payload = fetch_weather(args.weather_url)
            record = normalize_weather_payload(payload, args.source_id)
            archive.insert(record)
        except URLError as exc:
            LOGGER.warning("Weather fetch failed: %s", exc)
        except Exception as exc:
            LOGGER.exception("Error ingesting weather payload: %s", exc)

        now = time.monotonic()
        if now >= next_archive:
            try:
                archived = archive.archive_old()
                LOGGER.debug("Archive cycle completed archived=%d", archived)
            except Exception as exc:
                LOGGER.exception("Archive failed: %s", exc)
            next_archive = now + max(60, args.archive_interval)

        elapsed = time.monotonic() - start
        sleep_s = max(1.0, poll_interval - elapsed)
        time.sleep(sleep_s)


if __name__ == "__main__":
    sys.exit(main())

