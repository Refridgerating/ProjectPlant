from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Sequence

from services.hrrr_solar_history import HrrrSolarHistoryStore

logger = logging.getLogger("projectplant.hub.weather.cache")

CACHE_ENTRY_ORDERS = {"newest", "oldest", "largest", "smallest"}
CACHE_ENTRY_KINDS = {"grib", "metadata", "log", "other"}


def format_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    iso = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def normalize_kind_filter(kinds: Sequence[str] | None) -> set[str] | None:
    if not kinds:
        return None
    normalized: set[str] = set()
    for value in kinds:
        token = (value or "").strip().lower()
        if not token:
            continue
        if token not in CACHE_ENTRY_KINDS:
            raise ValueError(f"Unsupported file kind: {value}")
        normalized.add(token)
    return normalized or None


def scan_cache_summary(cache_dir: Path) -> dict[str, object]:
    stats = scan_cache_dir(cache_dir, create=True)
    return {
        "cache_dir": stats["cache_dir"],
        "total_files": stats["total_files"],
        "total_bytes": stats["total_bytes"],
        "latest_modified": format_timestamp(stats["latest_modified"]),
    }


def collect_cache_entries(
    cache_dir: Path,
    *,
    limit: int,
    order: str,
    kinds: Iterable[str] | None = None,
    create: bool = True,
) -> dict[str, object]:
    normalized_order = order if order in CACHE_ENTRY_ORDERS else "newest"
    kind_filter = set(kinds) if kinds else None
    summary = scan_cache_dir(cache_dir, create=create)
    entries = [
        entry
        for entry in summary["entries"]
        if kind_filter is None or entry["kind"] in kind_filter
    ]
    reverse = normalized_order in {"newest", "largest"}
    if normalized_order in {"newest", "oldest"}:
        key = lambda entry: entry["_modified_dt"] or datetime.min.replace(tzinfo=timezone.utc)
    else:
        key = lambda entry: entry["bytes"]
    sorted_entries = sorted(entries, key=key, reverse=reverse)[:limit]
    payload_entries: list[dict[str, object]] = []
    for item in sorted_entries:
        payload_entries.append(
            {
                "path": item["path"],
                "bytes": item["bytes"],
                "modified": format_timestamp(item["_modified_dt"]),
                "kind": item["kind"],
                "cycle": item.get("cycle"),
                "forecast_hour": item.get("forecast_hour"),
                "valid_time": item.get("valid_time"),
                "domain": item.get("domain"),
                "has_metadata": item.get("has_metadata"),
            }
        )
    return {
        "cache_dir": summary["cache_dir"],
        "total_files": summary["total_files"],
        "file_count": summary["file_count"],
        "total_bytes": summary["total_bytes"],
        "order": normalized_order,
        "limit": limit,
        "entries": payload_entries,
    }


def scan_cache_dir(cache_dir: Path, *, create: bool = False) -> dict[str, object]:
    root = cache_dir.resolve()
    if create:
        root.mkdir(parents=True, exist_ok=True)
    file_count = 0
    total_bytes = 0
    latest_modified: datetime | None = None
    oldest_modified: datetime | None = None
    entries: list[dict[str, object]] = []

    if not root.exists():
        return {
            "entries": [],
            "cache_dir": str(root),
            "file_count": 0,
            "total_files": 0,
            "total_bytes": 0,
            "latest_modified": None,
            "oldest_modified": None,
        }

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        file_count += 1
        total_bytes += stat.st_size
        modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        if latest_modified is None or modified > latest_modified:
            latest_modified = modified
        if oldest_modified is None or modified < oldest_modified:
            oldest_modified = modified
        metadata = read_grib_metadata(path.with_suffix(path.suffix + ".json")) if classify_cache_file(path) == "grib" else None
        cycle, forecast_hour, valid_time, domain = parse_cache_metadata(path, root, metadata)
        entries.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": stat.st_size,
                "modified": format_timestamp(modified),
                "_modified_dt": modified,
                "kind": classify_cache_file(path),
                "cycle": cycle,
                "forecast_hour": forecast_hour,
                "valid_time": valid_time,
                "domain": domain,
                "has_metadata": path.suffix.lower() == ".grib2" and path.with_suffix(path.suffix + ".json").exists(),
            }
        )

    return {
        "entries": entries,
        "cache_dir": str(root),
        "file_count": file_count,
        "total_files": file_count,
        "total_bytes": total_bytes,
        "latest_modified": latest_modified,
        "oldest_modified": oldest_modified,
    }


def delete_cache_entries(
    cache_dir: Path,
    entries: Sequence[str],
    include_metadata: bool,
    *,
    invalid_status: str = "error",
    count_metadata_processed: bool = True,
) -> dict[str, object]:
    cache_root = cache_dir.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    processed = 0
    bytes_removed = 0
    details: list[dict[str, object]] = []
    for raw in entries:
        try:
            targets = resolve_cache_targets(cache_root, raw, include_metadata=include_metadata)
        except ValueError as exc:
            details.append({"path": raw, "status": invalid_status, "detail": str(exc), "bytes": None})
            continue
        for index, target in enumerate(targets):
            rel = target.relative_to(cache_root).as_posix()
            if not target.exists():
                details.append({"path": rel, "status": "missing", "bytes": None})
                continue
            if target.is_dir():
                details.append(
                    {
                        "path": rel,
                        "status": "skipped",
                        "detail": "Directories are not supported. Select individual files instead.",
                        "bytes": None,
                    }
                )
                continue
            try:
                size = target.stat().st_size
            except FileNotFoundError:
                details.append({"path": rel, "status": "missing", "bytes": None})
                continue
            target.unlink(missing_ok=True)
            if index == 0 or count_metadata_processed:
                processed += 1
            bytes_removed += size
            details.append({"path": rel, "status": "deleted", "bytes": size})
    logger.info("Deleted %s HRRR cache entries (%s bytes)", processed, bytes_removed)
    return {"processed": processed, "bytes_removed": bytes_removed, "details": details}


def store_cache_entries(
    cache_dir: Path,
    archive_dir: Path,
    entries: Sequence[str],
    include_metadata: bool,
    label: str | None,
    *,
    invalid_status: str = "error",
    timestamp_suffix: str = "",
    label_separator: str = "-",
    label_style: str = "slug",
    detail_paths: str = "source",
    count_metadata_processed: bool = True,
) -> dict[str, object]:
    cache_root = cache_dir.resolve()
    archive_root = archive_dir.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    archive_root.mkdir(parents=True, exist_ok=True)
    slug = slugify_label(label)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + timestamp_suffix
    folder = f"{timestamp}{label_separator}{slug}" if slug else timestamp
    destination_root = archive_root / folder
    destination_root.mkdir(parents=True, exist_ok=True)
    response_label = label if label_style == "raw" else slug

    processed = 0
    bytes_moved = 0
    details: list[dict[str, object]] = []
    for raw in entries:
        try:
            targets = resolve_cache_targets(cache_root, raw, include_metadata=include_metadata)
        except ValueError as exc:
            details.append({"path": raw, "status": invalid_status, "detail": str(exc), "bytes": None})
            continue
        for index, target in enumerate(targets):
            rel_path = target.relative_to(cache_root)
            rel = rel_path.as_posix()
            if not target.exists():
                details.append({"path": rel, "status": "missing", "bytes": None})
                continue
            if target.is_dir():
                details.append(
                    {
                        "path": rel,
                        "status": "skipped",
                        "detail": "Directories are not supported. Select individual files instead.",
                        "bytes": None,
                    }
                )
                continue
            destination_path = destination_root / rel_path
            if destination_path.exists():
                details.append(
                    {
                        "path": rel,
                        "status": "skipped",
                        "detail": "Destination already contains a file with this name.",
                        "bytes": None,
                    }
                )
                continue
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                size = target.stat().st_size
            except FileNotFoundError:
                details.append({"path": rel, "status": "missing", "bytes": None})
                continue
            try:
                shutil.move(str(target), str(destination_path))
            except OSError as exc:
                details.append({"path": rel, "status": "error", "detail": str(exc), "bytes": None})
                continue
            if index == 0 or count_metadata_processed:
                processed += 1
            bytes_moved += size
            detail_path = (destination_path.relative_to(archive_root).as_posix() if detail_paths == "archive" else rel)
            details.append({"path": detail_path, "status": "stored", "bytes": size})
    logger.info("Stored %s HRRR cache entries (%s bytes) into %s", processed, bytes_moved, destination_root)
    return {
        "processed": processed,
        "bytes_moved": bytes_moved,
        "destination": str(destination_root),
        "label": response_label,
        "details": details,
    }


def resolve_cache_targets(cache_root: Path, entry: str, *, include_metadata: bool) -> list[Path]:
    target = resolve_cache_entry(cache_root, entry)
    targets = [target]
    if include_metadata and target.suffix.lower() == ".grib2":
        targets.append(target.with_suffix(target.suffix + ".json"))
    return targets


def resolve_cache_entry(cache_root: Path, entry: str) -> Path:
    rel = Path(entry.strip().lstrip("/\\"))
    if rel.is_absolute():
        raise ValueError("Absolute paths are not allowed.")
    cleaned_parts: list[str] = []
    for part in rel.parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError("Path traversal segments are not allowed.")
        cleaned_parts.append(part)
    if not cleaned_parts:
        raise ValueError("Empty entry path.")
    candidate = cache_root.joinpath(*cleaned_parts).resolve()
    try:
        candidate.relative_to(cache_root)
    except ValueError as exc:
        raise ValueError("Entry escapes the HRRR cache directory.") from exc
    return candidate


def classify_cache_file(path: Path) -> str:
    name = path.name.lower()
    if name == "fetch_status.jsonl" or name.endswith(".jsonl") or "log" in name:
        return "log"
    if name.endswith(".grib2.json"):
        return "metadata"
    if name.endswith(".grib2"):
        return "grib"
    if path.suffix.lower() == ".json":
        return "metadata"
    return "other"


def read_grib_metadata(path: Path) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def parse_cache_metadata(
    path: Path,
    root: Path,
    metadata: dict[str, object] | None = None,
) -> tuple[str | None, int | None, str | None, str | None]:
    if metadata:
        forecast = metadata.get("forecast_hour")
        return (
            str(metadata["cycle"]) if metadata.get("cycle") is not None else None,
            int(forecast) if forecast is not None else None,
            str(metadata["valid_time"]) if metadata.get("valid_time") is not None else None,
            str(metadata["domain"]) if metadata.get("domain") is not None else None,
        )
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return None, None, None, None
    if len(parts) < 2:
        return None, None, None, None
    date_part = parts[0]
    domain = parts[1] if len(parts) > 1 else None
    date_match = re.match(r"hrrr\.(\d{8})", date_part)
    run_match = re.match(r"hrrr\.t(\d{2})z\.wrfsfcf(\d{2})", path.name)
    if not date_match or not run_match:
        return None, None, None, domain
    day = date_match.group(1)
    hour = run_match.group(1)
    forecast_hour = int(run_match.group(2))
    try:
        cycle_dt = datetime.strptime(day + hour, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    except ValueError:
        return None, None, None, domain
    valid_dt = cycle_dt + timedelta(hours=forecast_hour)
    return format_timestamp(cycle_dt), forecast_hour, format_timestamp(valid_dt), domain


def slugify_label(label: str | None) -> str | None:
    if not label:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", label.strip())
    cleaned = cleaned.strip("-_")
    return cleaned or None


def scan_solar_history_store(db_path: Path, retention_hours: float) -> dict[str, object]:
    store = HrrrSolarHistoryStore(db_path=db_path, retention_hours=retention_hours)
    stats = store.stats()
    return {
        "db_path": stats["db_path"],
        "size_bytes": int(stats["size_bytes"]),
        "row_count": int(stats["row_count"]),
        "retention_hours": float(stats["retention_hours"]),
        "oldest_valid_time": stats["oldest_valid_time"],
        "newest_valid_time": stats["newest_valid_time"],
    }
