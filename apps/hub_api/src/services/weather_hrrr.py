from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import tempfile
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Deque, Dict, List, Optional, Set, Tuple

import httpx

from config import settings
from services.hrrr_active_location import HrrrActiveLocation, HrrrActiveLocationStore
from services.hrrr_solar_history import HrrrSolarHistoryRow, HrrrSolarHistoryStore
from services.telemetry import telemetry_store

logger = logging.getLogger("projectplant.hub.weather.hrrr")


def _ensure_eccodes_environment() -> None:
    if {"ECCODES_DEFINITION_PATH", "ECCODES_SAMPLES_PATH"}.issubset(os.environ):
        return
    try:
        import eccodes  # type: ignore  # noqa: PLC0415
    except ImportError:
        return
    base = Path(eccodes.__file__).resolve().parent
    local_candidates = [
        Path("C:/eccodes/definitions"),
        Path("C:/tools/eccodes/definitions"),
    ]
    local_sample_candidates = [
        Path("C:/eccodes/samples"),
        Path("C:/tools/eccodes/samples"),
    ]
    definition_candidates = [
        base / "definitions",
        base / "share" / "eccodes" / "definitions",
        base.parent / "share" / "eccodes" / "definitions",
        *local_candidates,
    ]
    sample_candidates = [
        base / "samples",
        base / "share" / "eccodes" / "samples",
        base.parent / "share" / "eccodes" / "samples",
        *local_sample_candidates,
    ]
    for candidate in definition_candidates:
        if candidate.exists():
            os.environ.setdefault("ECCODES_DEFINITION_PATH", str(candidate))
            break
    else:
        os.environ.setdefault("ECCODES_DEFINITION_PATH", "/MEMFS/definitions")

    for candidate in sample_candidates:
        if candidate.exists():
            os.environ.setdefault("ECCODES_SAMPLES_PATH", str(candidate))
            break
    else:
        os.environ.setdefault("ECCODES_SAMPLES_PATH", "/MEMFS/samples")


_ensure_eccodes_environment()

try:  # pragma: no cover - exercised only when eccodes is available
    import eccodes  # type: ignore
except ImportError:  # pragma: no cover - surfaced via explicit guard
    eccodes = None  # type: ignore

_ECCODES_LOCK = threading.RLock()


def _ensure_utc(value: Optional[datetime] = None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _round_coord(lat: float, lon: float) -> Tuple[float, float]:
    return (round(lat, 4), round(lon, 4))


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        cleaned = value.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned).astimezone(timezone.utc)
    except Exception:  # pragma: no cover - defensive parsing
        return None


@dataclass(frozen=True)
class HrrrRun:
    cycle: datetime
    forecast_hour: int

    @property
    def valid_time(self) -> datetime:
        return self.cycle + timedelta(hours=self.forecast_hour)

    @property
    def filename(self) -> str:
        return f"hrrr.t{self.cycle:%H}z.wrfsfcf{self.forecast_hour:02d}.grib2"

    @property
    def date_folder(self) -> str:
        return f"hrrr.{self.cycle:%Y%m%d}"


@dataclass(frozen=True)
class HrrrSample:
    run: HrrrRun
    temperature_c: Optional[float]
    humidity_pct: Optional[float]
    wind_speed_m_s: Optional[float]
    pressure_hpa: Optional[float]
    solar_radiation_w_m2: Optional[float]
    solar_radiation_diffuse_w_m2: Optional[float]
    solar_radiation_direct_w_m2: Optional[float]
    solar_radiation_clear_w_m2: Optional[float]
    solar_radiation_clear_up_w_m2: Optional[float]
    metadata: Dict[str, object]

    def source_tag(self) -> str:
        run = self.run
        return (
            "hrrr_forecast:"
            f"cycle={run.cycle:%Y%m%dT%H}Z:"
            f"fh={run.forecast_hour:02d}"
        )

    def as_environment_kwargs(self) -> Dict[str, object]:
        return {
            "timestamp": self.run.valid_time,
            "temperature_c": self.temperature_c,
            "humidity_pct": self.humidity_pct,
            "pressure_hpa": self.pressure_hpa,
            "solar_radiation_w_m2": self.solar_radiation_w_m2,
            "wind_speed_m_s": self.wind_speed_m_s,
            "source": self.source_tag(),
        }


@dataclass(frozen=True)
class HrrrFetchStatus:
    timestamp: datetime
    lat: float
    lon: float
    run_cycle: Optional[datetime]
    forecast_hour: Optional[int]
    valid_time: Optional[datetime]
    status: str
    detail: Optional[str] = None
    persisted: Optional[bool] = None
    duration_s: Optional[float] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "timestamp": _isoformat(self.timestamp),
            "lat": self.lat,
            "lon": self.lon,
            "run_cycle": _isoformat(self.run_cycle),
            "forecast_hour": self.forecast_hour,
            "valid_time": _isoformat(self.valid_time),
            "status": self.status,
            "detail": self.detail,
            "persisted": self.persisted,
            "duration_s": round(self.duration_s, 3) if self.duration_s is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, object]) -> "HrrrFetchStatus":
        return cls(
            timestamp=_parse_iso(payload.get("timestamp")) or datetime.now(timezone.utc),
            lat=float(payload.get("lat", 0.0)),
            lon=float(payload.get("lon", 0.0)),
            run_cycle=_parse_iso(payload.get("run_cycle")),
            forecast_hour=int(payload["forecast_hour"]) if payload.get("forecast_hour") is not None else None,
            valid_time=_parse_iso(payload.get("valid_time")),
            status=str(payload.get("status", "unknown")),
            detail=payload.get("detail") or None,
            persisted=payload.get("persisted"),
            duration_s=float(payload["duration_s"]) if payload.get("duration_s") is not None else None,
        )


class HrrrDependencyError(RuntimeError):
    """Raised when optional GRIB dependencies are missing."""


class HrrrDataUnavailable(RuntimeError):
    """Raised when the requested HRRR asset cannot be downloaded."""


_HRRR_FILTER_PATH = "/cgi-bin/filter_hrrr_2d.pl"
_HRRR_SUBREGION_MARGIN_DEGREES = 0.35
_SOLAR_SHORT_NAMES = ("dswrf", "sdswrf", "swdn")



def compute_target_run(
    when: Optional[datetime] = None,
    *,
    availability_delay: Optional[timedelta] = None,
    max_forecast_hour: Optional[int] = None,
) -> HrrrRun:
    reference = _ensure_utc(when)
    delay = availability_delay or timedelta(minutes=settings.hrrr_availability_delay_minutes)
    horizon = max_forecast_hour if max_forecast_hour is not None else settings.hrrr_max_forecast_hour

    valid_hour = reference.replace(minute=0, second=0, microsecond=0)
    cycle_candidate = (reference - delay).replace(minute=0, second=0, microsecond=0)

    if valid_hour < cycle_candidate:
        cycle_candidate = valid_hour

    forecast_hour = int((valid_hour - cycle_candidate).total_seconds() // 3600)
    if forecast_hour < 0:
        cycle_candidate = valid_hour
        forecast_hour = 0

    if forecast_hour > horizon:
        cycle_candidate = valid_hour - timedelta(hours=horizon)
        forecast_hour = horizon

    cycle_candidate = cycle_candidate.astimezone(timezone.utc)
    return HrrrRun(cycle=cycle_candidate, forecast_hour=forecast_hour)


class HrrrWeatherService:
    def __init__(
        self,
        *,
        cache_dir: Optional[Path] = None,
        solar_history_db: Optional[Path] = None,
        active_location_path: Optional[Path] = None,
        base_url: Optional[str] = None,
        domain: Optional[str] = None,
        availability_delay: Optional[timedelta] = None,
        max_forecast_hour: Optional[int] = None,
        cache_max_age: Optional[timedelta] = None,
        solar_retention: Optional[timedelta] = None,
        refresh_interval: Optional[timedelta] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        fetch_history_limit: int = 200,
    ) -> None:
        self._cache_dir = Path(cache_dir or settings.hrrr_cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        retention_hours = (
            solar_retention.total_seconds() / 3600.0
            if solar_retention is not None
            else float(settings.hrrr_solar_retention_hours)
        )
        self._solar_store = HrrrSolarHistoryStore(
            db_path=Path(solar_history_db or settings.hrrr_solar_history_db),
            retention_hours=retention_hours,
        )
        self._active_location_store = HrrrActiveLocationStore(
            Path(active_location_path or settings.hrrr_active_location_path)
        )
        self._base_url = (base_url or settings.hrrr_base_url).rstrip("/")
        self._domain = domain or settings.hrrr_domain
        self._availability_delay = availability_delay or timedelta(minutes=settings.hrrr_availability_delay_minutes)
        self._max_forecast_hour = max_forecast_hour if max_forecast_hour is not None else settings.hrrr_max_forecast_hour
        max_age_minutes = (
            cache_max_age.total_seconds() / 60.0
            if cache_max_age is not None
            else settings.hrrr_cache_max_age_minutes
        )
        self._cache_max_age = timedelta(minutes=max_age_minutes) if max_age_minutes > 0 else timedelta(0)
        interval_minutes = (
            refresh_interval.total_seconds() / 60.0
            if refresh_interval is not None
            else settings.hrrr_refresh_interval_minutes
        )
        self._refresh_interval = (
            timedelta(minutes=interval_minutes)
            if interval_minutes and interval_minutes > 0
            else None
        )
        self._selected_refresh_minutes: Optional[float] = interval_minutes if interval_minutes else None
        self._allowed_refresh_minutes: tuple[float, ...] = (15.0, 60.0)
        self._http_client = http_client
        self._refresh_locks: Dict[Tuple[float, float, str], asyncio.Lock] = {}
        self._latest_lock = asyncio.Lock()
        self._latest_samples: Dict[Tuple[float, float], HrrrSample] = {}
        self._last_refresh: Dict[Tuple[float, float], datetime] = {}
        self._last_run_valid: Dict[Tuple[float, float], datetime] = {}
        self._default_location: Optional[Tuple[float, float]] = None
        self._active_location: Optional[HrrrActiveLocation] = self._load_initial_active_location()
        self._scheduler_task: Optional[asyncio.Task[None]] = None
        self._scheduler_stop: Optional[asyncio.Event] = None
        self._background_tasks: Set[asyncio.Task[None]] = set()
        self._cache_cleanup_lock = asyncio.Lock()
        self._last_cache_cleanup: Optional[datetime] = None
        self._fetch_log_path = self._cache_dir / "fetch_status.jsonl"
        self._fetch_history: Deque[HrrrFetchStatus] = deque(maxlen=max(fetch_history_limit, 1))
        self._fetch_history_lock = asyncio.Lock()
        self._max_backfill_runs = max(int(round(self._solar_store.retention_hours)), 1)
        if self._active_location is not None:
            self._default_location = _round_coord(self._active_location.lat, self._active_location.lon)
        self._load_fetch_history()

    def refresh_presets(self) -> tuple[float, ...]:
        return self._allowed_refresh_minutes

    def _load_initial_active_location(self) -> Optional[HrrrActiveLocation]:
        persisted = self._active_location_store.get()
        if persisted is not None:
            return persisted
        if settings.hrrr_default_lat is None or settings.hrrr_default_lon is None:
            return None
        return HrrrActiveLocation(
            lat=float(settings.hrrr_default_lat),
            lon=float(settings.hrrr_default_lon),
            accuracy_m=None,
            source="config_fallback",
            observed_at=None,
            updated_at=datetime.now(timezone.utc),
        )

    def configure_default_location(self, lat: float, lon: float) -> None:
        location = HrrrActiveLocation(
            lat=float(lat),
            lon=float(lon),
            accuracy_m=None,
            source="configured",
            observed_at=None,
            updated_at=datetime.now(timezone.utc),
        )
        self._active_location = location
        self._default_location = _round_coord(location.lat, location.lon)

    async def get_active_location(self) -> Optional[HrrrActiveLocation]:
        async with self._latest_lock:
            return self._active_location

    async def set_active_location(
        self,
        *,
        lat: float,
        lon: float,
        accuracy_m: float | None,
        source: str,
        observed_at: Optional[datetime] = None,
    ) -> HrrrActiveLocation:
        location = await asyncio.to_thread(
            self._active_location_store.upsert,
            lat=lat,
            lon=lon,
            accuracy_m=accuracy_m,
            source=source,
            observed_at=observed_at,
        )
        refresh_needed = False
        async with self._latest_lock:
            previous = self._active_location
            previous_key = _round_coord(previous.lat, previous.lon) if previous is not None else None
            current_key = _round_coord(location.lat, location.lon)
            self._active_location = location
            self._default_location = current_key
            refresh_needed = previous_key != current_key
        await self.start_scheduler()
        if refresh_needed and settings.hrrr_enabled:
            self._track_background_task(
                asyncio.create_task(
                    self._refresh_default_in_background(),
                    name="hrrr-active-location-refresh",
                )
            )
        return location

    def _track_background_task(self, task: asyncio.Task[None]) -> None:
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def _refresh_default_in_background(self) -> None:
        try:
            await self._run_default_refresh_cycle()
        except HrrrDataUnavailable as exc:
            logger.info("HRRR data unavailable after active location sync: %s", exc)
        except HrrrDependencyError as exc:
            logger.warning("HRRR refresh skipped after active location sync: %s", exc)
        except Exception as exc:  # pragma: no cover - defensive logging
            logger.warning("HRRR refresh failed after active location sync: %s", exc)

    def set_refresh_interval(self, interval: Optional[timedelta]) -> None:
        if interval is None or interval.total_seconds() <= 0:
            self._refresh_interval = None
            self._selected_refresh_minutes = None
            return
        self._refresh_interval = interval
        self._selected_refresh_minutes = interval.total_seconds() / 60.0

    async def select_refresh_minutes(self, minutes: float) -> None:
        if minutes not in self._allowed_refresh_minutes:
            raise ValueError(f"Unsupported HRRR refresh interval: {minutes} minutes")
        self.set_refresh_interval(timedelta(minutes=minutes))
        if self._scheduler_task is not None and not self._scheduler_task.done():
            await self.stop_scheduler()
        await self.start_scheduler()

    async def status(self, *, history_limit: int = 10) -> Dict[str, object]:
        running = self._scheduler_task is not None and not self._scheduler_task.done()
        interval_minutes = (
            self._refresh_interval.total_seconds() / 60.0
            if self._refresh_interval is not None
            else None
        )
        async with self._latest_lock:
            default_location = self._default_location
            active_location = self._active_location
            default_payload = (
                {"lat": active_location.lat, "lon": active_location.lon}
                if active_location is not None
                else None
            )
            last_refresh = self._last_refresh.get(default_location) if default_location is not None else None
            last_valid = self._last_run_valid.get(default_location) if default_location is not None else None
            cached_points = len(self._latest_samples)
        if default_location is not None and last_valid is None:
            latest_row = await asyncio.to_thread(self._solar_store.latest_for, *default_location)
            if latest_row is not None:
                last_valid = latest_row.valid_time
        async with self._fetch_history_lock:
            history = list(self._fetch_history)
        if history_limit is not None and history_limit > 0:
            history = history[-history_limit:]
        solar_stats = await asyncio.to_thread(self._solar_store.stats)
        return {
            "enabled": settings.hrrr_enabled,
            "scheduler_running": running,
            "refresh_interval_minutes": interval_minutes,
            "selected_refresh_minutes": self._selected_refresh_minutes,
            "refresh_options": list(self._allowed_refresh_minutes),
            "default_location": default_payload,
            "location_source": active_location.source if active_location is not None else None,
            "location_observed_at": _isoformat(active_location.observed_at) if active_location is not None else None,
            "location_updated_at": _isoformat(active_location.updated_at) if active_location is not None else None,
            "last_refresh": _isoformat(last_refresh),
            "last_valid_time": _isoformat(last_valid),
            "cache_dir": str(self._cache_dir),
            "domain": self._domain,
            "cached_points": cached_points,
            "recent_fetches": [entry.to_dict() for entry in history],
            "fetch_log_path": str(self._fetch_log_path),
            "solar_history_db": solar_stats["db_path"],
            "solar_history_bytes": solar_stats["size_bytes"],
            "solar_history_rows": solar_stats["row_count"],
            "solar_retention_hours": solar_stats["retention_hours"],
            "solar_oldest_valid_time": _isoformat(solar_stats["oldest_valid_time"]),
            "solar_newest_valid_time": _isoformat(solar_stats["newest_valid_time"]),
        }

    async def close(self) -> None:
        await self.stop_scheduler()
        background_tasks = list(self._background_tasks)
        self._background_tasks.clear()
        for task in background_tasks:
            task.cancel()
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    async def start_scheduler(self) -> None:
        if not settings.hrrr_enabled:
            return
        if self._scheduler_task and not self._scheduler_task.done():
            return
        if self._default_location is None or self._refresh_interval is None:
            return
        self._scheduler_stop = asyncio.Event()
        self._scheduler_task = asyncio.create_task(self._scheduler_loop(), name="hrrr-refresh")
        logger.info(
            "HRRR scheduler started (interval=%s, location=%s)",
            self._refresh_interval,
            self._default_location,
        )

    async def stop_scheduler(self) -> None:
        if self._scheduler_task is None:
            return
        stop_event = self._scheduler_stop
        if stop_event is not None:
            stop_event.set()
        task = self._scheduler_task
        self._scheduler_task = None
        self._scheduler_stop = None
        try:
            await task
        except asyncio.CancelledError:  # pragma: no cover - cooperative cancellation path
            pass
        except Exception as exc:  # pragma: no cover - defensive logging
            logger.warning("HRRR scheduler terminated with error: %s", exc)
        else:
            logger.info("HRRR scheduler stopped")

    async def refresh_point(
        self,
        lat: float,
        lon: float,
        *,
        when: Optional[datetime] = None,
        persist: bool = True,
    ) -> HrrrSample:
        key = _round_coord(lat, lon)
        started = datetime.now(timezone.utc)
        run = compute_target_run(
            when,
            availability_delay=self._availability_delay,
            max_forecast_hour=self._max_forecast_hour,
        )
        try:
            refresh_lock_key = (key[0], key[1], _isoformat(run.valid_time) or run.valid_time.isoformat())
            lock = self._refresh_locks.setdefault(refresh_lock_key, asyncio.Lock())
            async with lock:
                row = await asyncio.to_thread(self._solar_store.get, key[0], key[1], run.valid_time)
                if row is not None and self._row_satisfies_run(row, run):
                    sample = self._row_to_sample(row, lat, lon)
                else:
                    sample = await self._fetch_and_store_solar(run, lat, lon)
            finished = datetime.now(timezone.utc)
            async with self._latest_lock:
                self._latest_samples[key] = sample
                self._last_refresh[key] = finished
                self._last_run_valid[key] = sample.run.valid_time
            if persist:
                await telemetry_store.record_environment(**sample.as_environment_kwargs())
            await self._log_fetch_status(
                HrrrFetchStatus(
                    timestamp=started,
                    lat=key[0],
                    lon=key[1],
                    run_cycle=sample.run.cycle,
                    forecast_hour=sample.run.forecast_hour,
                    valid_time=sample.run.valid_time,
                    status="success",
                    detail=None,
                    persisted=persist,
                    duration_s=(finished - started).total_seconds(),
                )
            )
            await self._maybe_cleanup_cache()
            return sample
        except Exception as exc:
            finished = datetime.now(timezone.utc)
            await self._log_fetch_status(
                HrrrFetchStatus(
                    timestamp=started,
                    lat=key[0],
                    lon=key[1],
                    run_cycle=run.cycle,
                    forecast_hour=run.forecast_hour,
                    valid_time=None,
                    status="error",
                    detail=str(exc),
                    persisted=False,
                    duration_s=(finished - started).total_seconds(),
                )
            )
            raise

    async def refresh_default(self, *, persist: bool = True) -> Optional[HrrrSample]:
        location = await self.get_active_location()
        if location is None:
            return None
        return await self.refresh_point(location.lat, location.lon, persist=persist)

    async def latest_for(self, lat: float, lon: float) -> Optional[HrrrSample]:
        key = _round_coord(lat, lon)
        async with self._latest_lock:
            sample = self._latest_samples.get(key)
        if sample is not None:
            return sample
        row = await asyncio.to_thread(self._solar_store.latest_for, key[0], key[1])
        if row is None:
            return None
        sample = self._row_to_sample(row, lat, lon)
        async with self._latest_lock:
            self._latest_samples[key] = sample
            self._last_run_valid[key] = sample.run.valid_time
        return sample

    async def latest_default(self) -> Optional[HrrrSample]:
        location = await self.get_active_location()
        if location is None:
            return None
        return await self.latest_for(location.lat, location.lon)

    async def get_or_refresh_default(self) -> Optional[HrrrSample]:
        sample = await self.latest_default()
        if sample is not None:
            return sample
        return await self.refresh_default()

    async def fetch_history(self, *, limit: Optional[int] = None) -> List[Dict[str, object]]:
        async with self._fetch_history_lock:
            history = list(self._fetch_history)
        if limit is not None and limit > 0:
            history = history[-limit:]
        return [entry.to_dict() for entry in history]

    async def history_for(
        self,
        lat: float,
        lon: float,
        *,
        hours: float,
        end: Optional[datetime] = None,
    ) -> tuple[list[HrrrSample], list[str]]:
        if hours <= 0:
            return [], []
        reference = _ensure_utc(end).replace(minute=0, second=0, microsecond=0)
        requested_hours = max(1, min(int(math.ceil(hours)), int(round(self._solar_store.retention_hours))))
        start = reference - timedelta(hours=requested_hours - 1)
        rows = await asyncio.to_thread(self._solar_store.list_range, lat, lon, start=start, end=reference)
        by_valid = {row.valid_time.replace(minute=0, second=0, microsecond=0): row for row in rows}
        errors: list[str] = []
        for offset in range(requested_hours):
            target = start + timedelta(hours=offset)
            if target in by_valid:
                continue
            try:
                sample = await self.refresh_point(lat, lon, when=target, persist=False)
            except (HrrrDependencyError, HrrrDataUnavailable) as exc:
                errors.append(str(exc))
                continue
            except Exception as exc:  # pragma: no cover - defensive logging
                errors.append(str(exc))
                continue
            row = await asyncio.to_thread(self._solar_store.get, lat, lon, sample.run.valid_time)
            if row is not None:
                by_valid[target] = row
        samples = [self._row_to_sample(row, lat, lon) for _, row in sorted(by_valid.items())]
        return samples, sorted(set(errors))

    async def solar_store_stats(self) -> Dict[str, object]:
        return await asyncio.to_thread(self._solar_store.stats)

    async def _scheduler_loop(self) -> None:
        assert self._scheduler_stop is not None
        stop_event = self._scheduler_stop
        while not stop_event.is_set():
            if self._default_location is None or self._refresh_interval is None:
                break
            try:
                await self._run_default_refresh_cycle()
            except HrrrDataUnavailable as exc:
                logger.info("HRRR data unavailable for scheduled refresh: %s", exc)
            except HrrrDependencyError as exc:
                logger.warning("HRRR refresh skipped (missing dependency): %s", exc)
                break
            except Exception as exc:  # pragma: no cover - defensive logging
                logger.warning("HRRR scheduled refresh failed: %s", exc)
            if stop_event.is_set() or self._refresh_interval is None:
                break
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._refresh_interval.total_seconds())
            except asyncio.TimeoutError:
                continue
        logger.debug("HRRR scheduler loop exiting")

    async def _run_default_refresh_cycle(self) -> None:
        location = await self.get_active_location()
        if location is None:
            return
        lat, lon = location.lat, location.lon
        key = _round_coord(lat, lon)
        now = datetime.now(timezone.utc)
        async with self._latest_lock:
            last_valid = self._last_run_valid.get(key)
        if last_valid is None:
            row = await asyncio.to_thread(self._solar_store.latest_for, lat, lon)
            if row is not None:
                last_valid = row.valid_time
        targets: List[datetime] = []
        if last_valid is not None:
            candidate = last_valid + timedelta(hours=1)
            steps = 0
            while candidate <= now and steps < self._max_backfill_runs:
                targets.append(candidate)
                candidate += timedelta(hours=1)
                steps += 1
        if not targets:
            targets.append(now)
        for target in targets:
            await self.refresh_point(lat, lon, when=target, persist=True)

    @staticmethod
    def _should_retry_grib_error(exc: RuntimeError) -> bool:
        message = str(exc).lower()
        return any(
            token in message
            for token in (
                "flex scanner internal error",
                "syntax error",
                "cannot create handle",
                "no definitions found",
                "top == 0",
                "unable to find definition files directory",
            )
        )

    def _row_satisfies_run(self, row: HrrrSolarHistoryRow, run: HrrrRun) -> bool:
        return row.valid_time == run.valid_time and row.run_cycle >= run.cycle

    def _row_to_sample(self, row: HrrrSolarHistoryRow, lat: float, lon: float) -> HrrrSample:
        run = HrrrRun(cycle=row.run_cycle, forecast_hour=row.forecast_hour)
        return HrrrSample(
            run=run,
            temperature_c=None,
            humidity_pct=None,
            wind_speed_m_s=None,
            pressure_hpa=None,
            solar_radiation_w_m2=row.solar_radiation_w_m2,
            solar_radiation_diffuse_w_m2=None,
            solar_radiation_direct_w_m2=None,
            solar_radiation_clear_w_m2=None,
            solar_radiation_clear_up_w_m2=None,
            metadata={
                "cycle": run.cycle.isoformat(timespec="seconds"),
                "forecast_hour": run.forecast_hour,
                "valid_time": run.valid_time.isoformat(timespec="seconds"),
                "domain": self._domain,
                "source": "noaa_hrrr",
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "fetched_at": row.fetched_at.isoformat(timespec="seconds"),
            },
        )

    async def _fetch_and_store_solar(self, run: HrrrRun, lat: float, lon: float) -> HrrrSample:
        attempt = 0
        while True:
            fd, temp_name = tempfile.mkstemp(dir=str(self._cache_dir), prefix="hrrr-solar-", suffix=".grib2")
            os.close(fd)
            grib_path = Path(temp_name)
            try:
                await self._download_grib(run, lat, lon, grib_path)
                raw_values = await asyncio.to_thread(self._extract_point_fields, grib_path, lat, lon)
                sample = self._convert_values(run, raw_values, lat, lon)
                row = await asyncio.to_thread(
                    self._solar_store.upsert,
                    lat=lat,
                    lon=lon,
                    valid_time=sample.run.valid_time,
                    solar_radiation_w_m2=sample.solar_radiation_w_m2 or 0.0,
                    run_cycle=sample.run.cycle,
                    forecast_hour=sample.run.forecast_hour,
                )
                await asyncio.to_thread(self._solar_store.prune)
                return self._row_to_sample(row, lat, lon)
            except RuntimeError as exc:
                if attempt >= 1 or not self._should_retry_grib_error(exc):
                    raise
                attempt += 1
            finally:
                grib_path.unlink(missing_ok=True)

    async def _download_grib(self, run: HrrrRun, lat: float, lon: float, target: Path) -> None:
        client = await self._get_client()
        target.parent.mkdir(parents=True, exist_ok=True)
        url, params = self._build_filtered_request(run, lat, lon)
        logger.info("Downloading filtered HRRR solar %s params=%s", url, params)
        async with client.stream("GET", url, params=params) as response:
            if response.status_code == 404:
                raise HrrrDataUnavailable(f"HRRR product not available for {run.filename}")
            response.raise_for_status()
            with target.open("wb") as handle:
                async for chunk in response.aiter_bytes(1024 * 128):
                    handle.write(chunk)
        if target.stat().st_size == 0:
            raise HrrrDataUnavailable(f"Filtered HRRR response empty for {run.filename}")

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            timeout = httpx.Timeout(settings.weather_request_timeout)
            self._http_client = httpx.AsyncClient(timeout=timeout)
        return self._http_client

    def _build_filtered_request(self, run: HrrrRun, lat: float, lon: float) -> tuple[str, dict[str, str]]:
        base = httpx.URL(self._base_url)
        top = min(lat + _HRRR_SUBREGION_MARGIN_DEGREES, 90.0)
        bottom = max(lat - _HRRR_SUBREGION_MARGIN_DEGREES, -90.0)
        left = max(lon - _HRRR_SUBREGION_MARGIN_DEGREES, -180.0)
        right = min(lon + _HRRR_SUBREGION_MARGIN_DEGREES, 180.0)
        params = {
            "file": run.filename,
            "lev_surface": "on",
            "var_DSWRF": "on",
            "subregion": "",
            "toplat": f"{top:.4f}",
            "leftlon": f"{left:.4f}",
            "rightlon": f"{right:.4f}",
            "bottomlat": f"{bottom:.4f}",
            "dir": f"/{run.date_folder}/{self._domain}",
        }
        return str(base.copy_with(path=_HRRR_FILTER_PATH, query=None)), params

    def _metadata_path(self, target: Path) -> Path:
        return target.with_suffix(target.suffix + ".json")

    def _extract_point_fields(self, grib_path: Path, lat: float, lon: float) -> Dict[str, float]:
        if eccodes is None:
            raise HrrrDependencyError(
                "eccodes-python is required to parse HRRR GRIB files. Install it via `pip install eccodes`."
            )
        values: Dict[str, float] = {}
        # ecCodes has global parser state and is not thread-safe unless the library
        # is compiled with threading support. We serialize access so that concurrent
        # refreshes do not trip the fatal Flex scanner error.
        with _ECCODES_LOCK:
            with grib_path.open("rb") as handle:
                while True:
                    gid = eccodes.codes_grib_new_from_file(handle)
                    if gid is None:
                        break
                    try:
                        short_name = eccodes.codes_get_string(gid, "shortName")
                        level_type = eccodes.codes_get_string(gid, "typeOfLevel")
                        level = int(eccodes.codes_get_long(gid, "level"))
                        if short_name.lower() in _SOLAR_SHORT_NAMES and level_type == "surface" and level == 0:
                            nearest = eccodes.codes_grib_find_nearest(gid, lat, lon)[0]
                            values["solar_down_w_m2"] = float(nearest.value)
                            break
                    except eccodes.CodesInternalError:
                        # Skip broken messages but keep the parser alive
                        continue
                    finally:
                        eccodes.codes_release(gid)
        if "solar_down_w_m2" not in values:
            raise HrrrDataUnavailable(f"DSWRF field missing from filtered HRRR response: {grib_path.name}")
        return values

    def _convert_values(self, run: HrrrRun, raw: Dict[str, float], lat: float, lon: float) -> HrrrSample:
        solar_radiation_w_m2 = raw.get("solar_down_w_m2")
        if solar_radiation_w_m2 is None:
            raise HrrrDataUnavailable(f"HRRR solar value missing for {run.filename}")

        metadata = {
            "cycle": run.cycle.isoformat(timespec="seconds"),
            "forecast_hour": run.forecast_hour,
            "valid_time": run.valid_time.isoformat(timespec="seconds"),
            "domain": self._domain,
            "source": "noaa_hrrr",
            "lat": round(lat, 5),
            "lon": round(lon, 5),
        }
        return HrrrSample(
            run=run,
            temperature_c=None,
            humidity_pct=None,
            wind_speed_m_s=None,
            pressure_hpa=None,
            solar_radiation_w_m2=solar_radiation_w_m2,
            solar_radiation_diffuse_w_m2=None,
            solar_radiation_direct_w_m2=None,
            solar_radiation_clear_w_m2=None,
            solar_radiation_clear_up_w_m2=None,
            metadata=metadata,
        )

    async def _log_fetch_status(self, entry: HrrrFetchStatus) -> None:
        async with self._fetch_history_lock:
            self._fetch_history.append(entry)
        await asyncio.to_thread(self._append_fetch_log, entry)

    def _append_fetch_log(self, entry: HrrrFetchStatus) -> None:
        try:
            with self._fetch_log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry.to_dict(), separators=(",", ":")) + "\n")
        except OSError as exc:  # pragma: no cover - best-effort logging
            logger.debug("Failed to append HRRR fetch log: %s", exc)

    def _load_fetch_history(self) -> None:
        if not self._fetch_log_path.exists():
            return
        try:
            lines = self._fetch_log_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        for line in lines[-self._fetch_history.maxlen :]:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:  # pragma: no cover - corrupted entries
                continue
            self._fetch_history.append(HrrrFetchStatus.from_dict(payload))

    async def _maybe_cleanup_cache(self) -> None:
        if self._cache_max_age <= timedelta(0):
            return
        now = datetime.now(timezone.utc)
        async with self._cache_cleanup_lock:
            if self._last_cache_cleanup and (now - self._last_cache_cleanup) < timedelta(minutes=5):
                return
            self._last_cache_cleanup = now
        cutoff = now - self._cache_max_age
        await asyncio.to_thread(self._evict_cache, cutoff)

    def _evict_cache(self, cutoff: datetime) -> None:
        if not self._cache_dir.exists():
            return
        removed = 0
        for path in self._cache_dir.rglob("*.grib2"):
            try:
                modified = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            except FileNotFoundError:
                continue
            if modified >= cutoff:
                continue
            path.unlink(missing_ok=True)
            meta = self._metadata_path(path)
            if meta.exists():
                meta.unlink(missing_ok=True)
            removed += 1
        if removed:
            logger.info("HRRR cache eviction removed %s files", removed)


hrrr_weather_service = HrrrWeatherService()

__all__ = [
    "HrrrWeatherService",
    "HrrrSample",
    "HrrrRun",
    "HrrrFetchStatus",
    "HrrrDataUnavailable",
    "HrrrDependencyError",
    "compute_target_run",
    "hrrr_weather_service",
]

