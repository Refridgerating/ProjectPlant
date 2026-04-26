from __future__ import annotations

import struct
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

_TZIF_HEADER_SIZE = 44
_TZIF_MAGIC = b"TZif"
_DEFAULT_LOCALTIME_PATH = Path("/etc/localtime")
_DEFAULT_TIMEZONE_PATH = Path("/etc/timezone")
_DEFAULT_ZONEINFO_ROOT = Path("/usr/share/zoneinfo")


@dataclass(frozen=True, slots=True)
class ScheduleTimezoneInfo:
    offset_minutes: int
    posix_tz: str | None
    zone_name: str | None
    source: str

    @property
    def signature(self) -> tuple[int, str | None]:
        return (self.offset_minutes, self.posix_tz)


def resolve_schedule_timezone_info(
    *,
    override: str | None = None,
    now: datetime | None = None,
    localtime_path: Path = _DEFAULT_LOCALTIME_PATH,
    timezone_path: Path = _DEFAULT_TIMEZONE_PATH,
    zoneinfo_root: Path = _DEFAULT_ZONEINFO_ROOT,
) -> ScheduleTimezoneInfo:
    offset_minutes = current_local_offset_minutes(now=now)
    cleaned_override = _normalize_timezone_text(override)
    if cleaned_override:
        return ScheduleTimezoneInfo(
            offset_minutes=offset_minutes,
            posix_tz=cleaned_override,
            zone_name=None,
            source="env",
        )

    zone_name = _read_timezone_name(timezone_path)
    localtime_posix = _extract_posix_tz_from_file(localtime_path) if localtime_path.is_file() else None
    if localtime_posix:
        return ScheduleTimezoneInfo(
            offset_minutes=offset_minutes,
            posix_tz=localtime_posix,
            zone_name=zone_name,
            source="localtime",
        )

    tzfile_path = _resolve_tzfile_path(
        localtime_path=localtime_path,
        zoneinfo_root=zoneinfo_root,
        zone_name=zone_name,
    )
    posix_tz = _extract_posix_tz_from_file(tzfile_path) if tzfile_path is not None else None
    source = "offset-only"
    if posix_tz and zone_name:
        source = "timezone-file"
    elif posix_tz:
        source = "localtime"

    return ScheduleTimezoneInfo(
        offset_minutes=offset_minutes,
        posix_tz=posix_tz,
        zone_name=zone_name,
        source=source,
    )


def current_local_offset_minutes(*, now: datetime | None = None) -> int:
    effective_now = now.astimezone() if now is not None else datetime.now().astimezone()
    offset = effective_now.utcoffset()
    if offset is None:
        return 0
    return int(offset.total_seconds() // 60)


def _normalize_timezone_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _read_timezone_name(timezone_path: Path) -> str | None:
    try:
        contents = timezone_path.read_text(encoding="utf-8")
    except OSError:
        return None

    for line in contents.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#"):
            return candidate
    return None


def _resolve_tzfile_path(
    *,
    localtime_path: Path,
    zoneinfo_root: Path,
    zone_name: str | None,
) -> Path | None:
    if zone_name:
        candidate = zoneinfo_root / zone_name
        if candidate.is_file():
            return candidate
    if localtime_path.is_file():
        return localtime_path
    return None


def _extract_posix_tz_from_file(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    return _extract_posix_tz_from_tzif(data)


def _extract_posix_tz_from_tzif(data: bytes) -> str | None:
    if len(data) < _TZIF_HEADER_SIZE or data[:4] != _TZIF_MAGIC:
        return None

    version = data[4:5]
    if version not in {b"2", b"3", b"4"}:
        return None

    try:
        offset = _TZIF_HEADER_SIZE
        offset = _skip_tzif_data_block(data, offset, time_size=4)
        if data[offset : offset + 4] != _TZIF_MAGIC:
            return None
        offset += _TZIF_HEADER_SIZE
        offset = _skip_tzif_data_block(data, offset, time_size=8)
    except (IndexError, struct.error, ValueError):
        return None

    if offset >= len(data) or data[offset : offset + 1] != b"\n":
        return None

    footer_end = data.find(b"\n", offset + 1)
    if footer_end < 0:
        return None

    footer = data[offset + 1 : footer_end]
    if not footer:
        return None
    try:
        decoded = footer.decode("ascii")
    except UnicodeDecodeError:
        return None
    if any(ord(ch) < 32 or ord(ch) > 126 for ch in decoded):
        return None
    return decoded or None


def _skip_tzif_data_block(data: bytes, header_offset: int, *, time_size: int) -> int:
    counts = struct.unpack(">6l", data[header_offset - 24 : header_offset])
    ttisutcnt, ttisstdcnt, leapcnt, timecnt, typecnt, charcnt = counts
    data_length = (
        (timecnt * time_size)
        + timecnt
        + (typecnt * 6)
        + charcnt
        + (leapcnt * (time_size + 4))
        + ttisstdcnt
        + ttisutcnt
    )
    next_offset = header_offset + data_length
    if next_offset > len(data):
        raise ValueError("invalid tzif data block length")
    return next_offset


__all__ = [
    "ScheduleTimezoneInfo",
    "current_local_offset_minutes",
    "resolve_schedule_timezone_info",
]
