from __future__ import annotations

import struct
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from services.schedule_timezone import resolve_schedule_timezone_info

ROOT = Path(__file__).resolve().parents[1]


def _write_minimal_tzif(path: Path, footer: str) -> None:
    header = b"TZif2" + (b"\0" * 15) + struct.pack(">6l", 0, 0, 0, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + header + b"\n" + footer.encode("ascii") + b"\n")


def _make_runtime_dir() -> Path:
    runtime_dir = ROOT / "data" / f"test-schedule-timezone-{uuid4().hex}"
    runtime_dir.mkdir(parents=True, exist_ok=False)
    return runtime_dir


def test_resolve_schedule_timezone_prefers_env_override() -> None:
    runtime_dir = _make_runtime_dir()
    try:
        info = resolve_schedule_timezone_info(
            override="EST5EDT,M3.2.0/2,M11.1.0/2",
            now=datetime(2026, 3, 16, 12, 0, tzinfo=timezone.utc),
            localtime_path=runtime_dir / "etc" / "localtime",
            timezone_path=runtime_dir / "etc" / "timezone",
            zoneinfo_root=runtime_dir / "usr" / "share" / "zoneinfo",
        )

        assert info.posix_tz == "EST5EDT,M3.2.0/2,M11.1.0/2"
        assert info.source == "env"
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


def test_resolve_schedule_timezone_reads_localtime_footer() -> None:
    runtime_dir = _make_runtime_dir()
    try:
        localtime_path = runtime_dir / "etc" / "localtime"
        _write_minimal_tzif(localtime_path, "EST5EDT,M3.2.0/2,M11.1.0/2")

        info = resolve_schedule_timezone_info(
            localtime_path=localtime_path,
            timezone_path=runtime_dir / "etc" / "timezone",
            zoneinfo_root=runtime_dir / "usr" / "share" / "zoneinfo",
        )

        assert info.posix_tz == "EST5EDT,M3.2.0/2,M11.1.0/2"
        assert info.source == "localtime"
        assert info.zone_name is None
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


def test_resolve_schedule_timezone_uses_timezone_file_zoneinfo() -> None:
    runtime_dir = _make_runtime_dir()
    try:
        timezone_path = runtime_dir / "etc" / "timezone"
        timezone_path.parent.mkdir(parents=True, exist_ok=True)
        timezone_path.write_text("America/New_York\n", encoding="utf-8")

        zoneinfo_root = runtime_dir / "usr" / "share" / "zoneinfo"
        _write_minimal_tzif(zoneinfo_root / "America" / "New_York", "EST5EDT,M3.2.0/2,M11.1.0/2")

        info = resolve_schedule_timezone_info(
            localtime_path=runtime_dir / "etc" / "localtime",
            timezone_path=timezone_path,
            zoneinfo_root=zoneinfo_root,
        )

        assert info.posix_tz == "EST5EDT,M3.2.0/2,M11.1.0/2"
        assert info.zone_name == "America/New_York"
        assert info.source == "timezone-file"
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)
