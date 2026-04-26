from __future__ import annotations

import csv
import gzip
import io
from typing import Iterable, Iterator

from config import settings
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from services.telemetry import telemetry_store
from services.plant_telemetry import plant_telemetry_store


MIN_LOOKBACK_HOURS = 1.0 / 60.0  # one minute
MAX_POT_SAMPLES = max(settings.pot_telemetry_max_rows, 1)
CSV_FIELDNAMES = [
    "potId",
    "timestamp",
    "timestampMs",
    "moisture_pct",
    "temperature_c",
    "humidity_pct",
    "pressure_hpa",
    "solar_radiation_w_m2",
    "wind_speed_m_s",
    "valve_open",
    "fan_on",
    "mister_on",
    "light_on",
    "flow_rate_lpm",
    "waterLow",
    "waterCutoff",
    "soilRaw",
    "source",
    "requestId",
]


router = APIRouter(prefix="/telemetry", tags=["telemetry"])


@router.get("/live")
async def get_live_telemetry(
    hours: float = Query(default=24.0, ge=0.5, le=168.0, description="Lookback window in hours"),
    limit: int = Query(default=288, ge=1, le=4096, description="Maximum samples to return"),
):
    samples = await telemetry_store.list_samples(hours=hours, limit=limit)
    return {
        "requested_hours": hours,
        "limit": limit,
        "count": len(samples),
        "data": [sample.to_payload() for sample in samples],
    }


@router.get("/pots/{pot_id}")
async def get_pot_telemetry(
    pot_id: str,
    hours: float = Query(
        default=24.0,
        ge=MIN_LOOKBACK_HOURS,
        le=168.0,
        description="Lookback window in hours",
    ),
    limit: int = Query(
        default=1440,
        ge=1,
        le=MAX_POT_SAMPLES,
        description="Maximum samples to return",
    ),
):
    normalized, samples = await _fetch_pot_samples(pot_id, hours=hours, limit=limit)
    return {
        "potId": normalized or pot_id,
        "requested_hours": hours,
        "limit": limit,
        "count": len(samples),
        "data": samples,
    }


@router.get("/pots/{pot_id}/export")
async def export_pot_telemetry(
    pot_id: str,
    hours: float = Query(
        default=72.0,
        ge=MIN_LOOKBACK_HOURS,
        le=168.0,
        description="Lookback window in hours",
    ),
    limit: int | None = Query(
        default=None,
        ge=1,
        le=MAX_POT_SAMPLES,
        description="Maximum samples to return",
    ),
    gzip_output: bool = Query(
        default=False,
        alias="gzip",
        description="Set to true to stream gzip-compressed CSV",
    ),
) -> StreamingResponse:
    normalized, samples = await _fetch_pot_samples(
        pot_id,
        hours=hours,
        limit=limit if limit is not None else MAX_POT_SAMPLES,
    )
    filename_root = (normalized or pot_id or "pot") + "-telemetry"
    csv_stream = _iter_csv_bytes(samples)
    media_type = "text/csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename_root}.csv"'}
    if gzip_output:
        media_type = "text/csv"
        headers["Content-Encoding"] = "gzip"
        headers["Content-Disposition"] = f'attachment; filename="{filename_root}.csv.gz"'
        stream = _gzip_stream(csv_stream)
    else:
        stream = csv_stream
    return StreamingResponse(stream, media_type=media_type, headers=headers)


async def _fetch_pot_samples(pot_id: str, *, hours: float, limit: int):
    normalized = pot_id.strip().lower()
    if not normalized:
        return normalized, []
    samples = await plant_telemetry_store.list(normalized, hours=hours, limit=limit)
    return normalized, samples


def _iter_csv_bytes(samples: Iterable[dict]) -> Iterator[bytes]:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDNAMES, extrasaction="ignore")
    writer.writeheader()
    yield buffer.getvalue().encode("utf-8")
    buffer.seek(0)
    buffer.truncate(0)
    for sample in samples:
        writer.writerow({field: sample.get(field) for field in CSV_FIELDNAMES})
        yield buffer.getvalue().encode("utf-8")
        buffer.seek(0)
        buffer.truncate(0)


def _gzip_stream(source: Iterable[bytes]) -> Iterator[bytes]:
    buffer = io.BytesIO()
    gzip_file = gzip.GzipFile(fileobj=buffer, mode="wb")
    try:
        for chunk in source:
            if not chunk:
                continue
            gzip_file.write(chunk)
            gzip_file.flush()
            data = buffer.getvalue()
            if data:
                yield data
                buffer.seek(0)
                buffer.truncate(0)
    finally:
        gzip_file.close()
        remaining = buffer.getvalue()
        if remaining:
            yield remaining
