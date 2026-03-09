from __future__ import annotations

import json
import math
import sqlite3
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from config import settings
from models import (
    DesiredOperation,
    EnrollRequest,
    HubCheckInRequest,
    HubOperationRecord,
    HubRecord,
    HubUpdateRequest,
    ReleaseManifest,
    ReleaseRecord,
    RolloutRecord,
    RolloutRequest,
    RolloutHubStatus,
)
from security import utc_now_iso


def _json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


class FleetStore:
    def __init__(self, db_path: str, artifact_dir: str) -> None:
        self._db_path = Path(db_path)
        self._artifact_dir = Path(artifact_dir)
        self._lock = threading.RLock()
        self._init_db()
        self._seed_bootstrap_tokens()

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS bootstrap_tokens (
                    token TEXT PRIMARY KEY,
                    site TEXT,
                    created_at TEXT NOT NULL,
                    used_at TEXT
                );
                CREATE TABLE IF NOT EXISTS hubs (
                    hub_id TEXT PRIMARY KEY,
                    public_key TEXT NOT NULL,
                    hostname TEXT NOT NULL,
                    advertised_name TEXT,
                    site TEXT,
                    channel TEXT NOT NULL,
                    local_ip_addresses TEXT NOT NULL,
                    agent_version TEXT NOT NULL,
                    hub_version TEXT,
                    ui_version TEXT,
                    managed_services TEXT NOT NULL,
                    disk_free_bytes INTEGER,
                    uptime_seconds INTEGER,
                    last_boot_at TEXT,
                    mosquitto_enabled INTEGER NOT NULL DEFAULT 0,
                    mqtt_broker_mode TEXT NOT NULL DEFAULT 'external',
                    tags TEXT NOT NULL DEFAULT '[]',
                    maintenance_mode INTEGER NOT NULL DEFAULT 0,
                    enrolled_at TEXT NOT NULL,
                    last_check_in_at TEXT,
                    current_release_id TEXT,
                    last_known_good_release_id TEXT
                );
                CREATE TABLE IF NOT EXISTS releases (
                    release_id TEXT PRIMARY KEY,
                    channel TEXT NOT NULL,
                    hub_version TEXT NOT NULL,
                    ui_version TEXT NOT NULL,
                    agent_min_version TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    manifest_signature_path TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rollouts (
                    rollout_id TEXT PRIMARY KEY,
                    release_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    selector_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rollout_targets (
                    rollout_id TEXT NOT NULL,
                    hub_id TEXT NOT NULL,
                    batch_number INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    operation_id TEXT,
                    PRIMARY KEY (rollout_id, hub_id)
                );
                CREATE TABLE IF NOT EXISTS hub_operations (
                    operation_id TEXT PRIMARY KEY,
                    hub_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    release_id TEXT,
                    rollout_id TEXT,
                    status TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.commit()

    def _seed_bootstrap_tokens(self) -> None:
        if not settings.fleet_bootstrap_tokens:
            return
        with self._connect() as conn:
            for token in settings.fleet_bootstrap_tokens:
                conn.execute(
                    "INSERT OR IGNORE INTO bootstrap_tokens(token, site, created_at, used_at) VALUES(?, ?, ?, NULL)",
                    (token, None, utc_now_iso()),
                )
            conn.commit()

    def reset(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                DELETE FROM rollout_targets;
                DELETE FROM hub_operations;
                DELETE FROM rollouts;
                DELETE FROM releases;
                DELETE FROM hubs;
                DELETE FROM bootstrap_tokens;
                """
            )
            conn.commit()
        self._seed_bootstrap_tokens()
    def create_bootstrap_token(self, token: str, *, site: str | None = None) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO bootstrap_tokens(token, site, created_at, used_at) VALUES(?, ?, ?, NULL)",
                (token, site, utc_now_iso()),
            )
            conn.commit()

    def enroll_hub(self, request: EnrollRequest) -> HubRecord:
        with self._lock:
            now = utc_now_iso()
            with self._connect() as conn:
                token_row = conn.execute(
                    "SELECT token, site, used_at FROM bootstrap_tokens WHERE token = ?",
                    (request.bootstrapToken,),
                ).fetchone()
                if token_row is None:
                    raise ValueError("Invalid bootstrap token")
                if token_row["used_at"]:
                    raise ValueError("Bootstrap token already used")

                inventory = request.inventory
                conn.execute("UPDATE bootstrap_tokens SET used_at = ? WHERE token = ?", (now, request.bootstrapToken))
                conn.execute(
                    """
                    INSERT OR REPLACE INTO hubs(
                        hub_id, public_key, hostname, advertised_name, site, channel,
                        local_ip_addresses, agent_version, hub_version, ui_version,
                        managed_services, disk_free_bytes, uptime_seconds, last_boot_at,
                        mosquitto_enabled, mqtt_broker_mode, tags, maintenance_mode,
                        enrolled_at, last_check_in_at, current_release_id, last_known_good_release_id
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)
                    """,
                    (
                        request.hubId,
                        request.publicKey,
                        inventory.hostname,
                        inventory.advertisedName,
                        inventory.site or token_row["site"],
                        inventory.channel,
                        _json_dumps(inventory.localIpAddresses),
                        inventory.agentVersion,
                        inventory.hubVersion,
                        inventory.uiVersion,
                        _json_dumps(inventory.managedServices),
                        inventory.diskFreeBytes,
                        inventory.uptimeSeconds,
                        inventory.lastBootAt,
                        1 if inventory.mosquittoEnabled else 0,
                        inventory.mqttBrokerMode,
                        "[]",
                        now,
                        now,
                    ),
                )
                conn.commit()
                return self.get_hub(request.hubId, conn=conn)

    def get_hub_public_key(self, hub_id: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT public_key FROM hubs WHERE hub_id = ?", (hub_id,)).fetchone()
            return None if row is None else str(row["public_key"])

    def list_hubs(self, *, site: str | None = None, channel: str | None = None, query: str | None = None) -> list[HubRecord]:
        clauses: list[str] = []
        params: list[Any] = []
        if site:
            clauses.append("site = ?")
            params.append(site)
        if channel:
            clauses.append("channel = ?")
            params.append(channel)
        if query:
            clauses.append("(hub_id LIKE ? OR hostname LIKE ? OR COALESCE(advertised_name, '') LIKE ?)")
            params.extend([f"%{query}%", f"%{query}%", f"%{query}%"])
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(f"SELECT * FROM hubs {where} ORDER BY hub_id", params).fetchall()
            return [self._hub_from_row(row) for row in rows]

    def get_hub(self, hub_id: str, *, conn: sqlite3.Connection | None = None) -> HubRecord:
        own_conn = conn is None
        conn = conn or self._connect()
        try:
            row = conn.execute("SELECT * FROM hubs WHERE hub_id = ?", (hub_id,)).fetchone()
            if row is None:
                raise KeyError(hub_id)
            return self._hub_from_row(row)
        finally:
            if own_conn:
                conn.close()

    def update_hub(self, hub_id: str, request: HubUpdateRequest) -> HubRecord:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM hubs WHERE hub_id = ?", (hub_id,)).fetchone()
            if row is None:
                raise KeyError(hub_id)
            tags = request.tags if request.tags is not None else json.loads(str(row["tags"] or "[]"))
            conn.execute(
                "UPDATE hubs SET advertised_name = ?, site = ?, channel = ?, tags = ?, maintenance_mode = ? WHERE hub_id = ?",
                (
                    request.advertisedName if request.advertisedName is not None else row["advertised_name"],
                    request.site if request.site is not None else row["site"],
                    request.channel if request.channel is not None else row["channel"],
                    _json_dumps(tags),
                    1 if (request.maintenanceMode if request.maintenanceMode is not None else bool(row["maintenance_mode"])) else 0,
                    hub_id,
                ),
            )
            conn.commit()
            return self.get_hub(hub_id, conn=conn)
    def record_check_in(self, request: HubCheckInRequest) -> DesiredOperation | None:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM hubs WHERE hub_id = ?", (request.hubId,)).fetchone()
                if row is None:
                    raise KeyError(request.hubId)
                now = utc_now_iso()
                inv = request.inventory
                conn.execute(
                    """
                    UPDATE hubs
                    SET hostname = ?, advertised_name = ?, site = ?, channel = ?,
                        local_ip_addresses = ?, agent_version = ?, hub_version = ?, ui_version = ?,
                        managed_services = ?, disk_free_bytes = ?, uptime_seconds = ?, last_boot_at = ?,
                        mosquitto_enabled = ?, mqtt_broker_mode = ?, last_check_in_at = ?
                    WHERE hub_id = ?
                    """,
                    (
                        inv.hostname,
                        inv.advertisedName,
                        inv.site,
                        inv.channel,
                        _json_dumps(inv.localIpAddresses),
                        inv.agentVersion,
                        inv.hubVersion,
                        inv.uiVersion,
                        _json_dumps(inv.managedServices),
                        inv.diskFreeBytes,
                        inv.uptimeSeconds,
                        inv.lastBootAt,
                        1 if inv.mosquittoEnabled else 0,
                        inv.mqttBrokerMode,
                        now,
                        request.hubId,
                    ),
                )
                if request.operationResult is not None:
                    self._apply_operation_result(
                        conn,
                        request.hubId,
                        request.operationResult.operationId,
                        request.operationResult.status,
                        request.operationResult.releaseId,
                        request.operationResult.detail,
                    )
                desired = self._next_desired_operation(conn, request.hubId)
                conn.commit()
                return desired

    def register_release(self, manifest: ReleaseManifest, signature_path: str) -> tuple[ReleaseRecord, bool]:
        now = utc_now_iso()
        payload = _json_dumps(manifest.model_dump(mode="json"))
        with self._connect() as conn:
            existing = conn.execute("SELECT release_id FROM releases WHERE release_id = ?", (manifest.releaseId,)).fetchone()
            created = existing is None
            conn.execute(
                """
                INSERT OR REPLACE INTO releases(
                    release_id, channel, hub_version, ui_version, agent_min_version,
                    manifest_json, created_at, status, manifest_signature_path
                ) VALUES(?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM releases WHERE release_id = ?), ?), ?, ?)
                """,
                (
                    manifest.releaseId,
                    manifest.channel,
                    manifest.hubVersion,
                    manifest.uiVersion,
                    manifest.agentMinVersion,
                    payload,
                    manifest.releaseId,
                    now,
                    "ready",
                    signature_path,
                ),
            )
            conn.commit()
            return self.get_release(manifest.releaseId, conn=conn), created

    def list_releases(self, *, channel: str | None = None) -> list[ReleaseRecord]:
        params: list[Any] = []
        where = ""
        if channel:
            where = "WHERE channel = ?"
            params.append(channel)
        with self._connect() as conn:
            rows = conn.execute(f"SELECT * FROM releases {where} ORDER BY created_at DESC", params).fetchall()
            return [self._release_from_row(row) for row in rows]

    def get_release(self, release_id: str, *, conn: sqlite3.Connection | None = None) -> ReleaseRecord:
        own_conn = conn is None
        conn = conn or self._connect()
        try:
            row = conn.execute("SELECT * FROM releases WHERE release_id = ?", (release_id,)).fetchone()
            if row is None:
                raise KeyError(release_id)
            return self._release_from_row(row)
        finally:
            if own_conn:
                conn.close()

    def queue_manual_rollback(self, hub_id: str) -> HubOperationRecord:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT current_release_id, last_known_good_release_id FROM hubs WHERE hub_id = ?",
                (hub_id,),
            ).fetchone()
            if row is None:
                raise KeyError(hub_id)
            release_id = str(row["last_known_good_release_id"] or row["current_release_id"] or "") or None
            operation_id = self._queue_operation(conn, hub_id, "rollback_release", release_id, None)
            conn.commit()
            return self.get_operation(operation_id, conn=conn)

    def get_operation(self, operation_id: str, *, conn: sqlite3.Connection | None = None) -> HubOperationRecord:
        own_conn = conn is None
        conn = conn or self._connect()
        try:
            row = conn.execute("SELECT * FROM hub_operations WHERE operation_id = ?", (operation_id,)).fetchone()
            if row is None:
                raise KeyError(operation_id)
            return self._operation_from_row(row)
        finally:
            if own_conn:
                conn.close()
    def create_rollout(self, request: RolloutRequest) -> RolloutRecord:
        release = self.get_release(request.releaseId)
        targets = self._resolve_selector(request.selector.model_dump(exclude_none=True))
        if not targets:
            raise ValueError("No hubs matched the rollout selector")
        rollout_id = f"rollout-{uuid4().hex[:12]}"
        now = utc_now_iso()
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO rollouts(rollout_id, release_id, status, selector_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
                    (rollout_id, release.releaseId, "active", _json_dumps(request.selector.model_dump(exclude_none=True)), now, now),
                )
                for hub_id, batch_number in self._compute_batches(targets):
                    target_status = "pending" if batch_number == 0 else "waiting"
                    operation_id = None
                    if batch_number == 0:
                        operation_id = self._queue_operation(conn, hub_id, "install_release", release.releaseId, rollout_id)
                    conn.execute(
                        "INSERT INTO rollout_targets(rollout_id, hub_id, batch_number, status, operation_id) VALUES(?, ?, ?, ?, ?)",
                        (rollout_id, hub_id, batch_number, target_status, operation_id),
                    )
                conn.commit()
                return self.get_rollout(rollout_id, conn=conn)

    def get_rollout(self, rollout_id: str, *, conn: sqlite3.Connection | None = None) -> RolloutRecord:
        own_conn = conn is None
        conn = conn or self._connect()
        try:
            row = conn.execute("SELECT * FROM rollouts WHERE rollout_id = ?", (rollout_id,)).fetchone()
            if row is None:
                raise KeyError(rollout_id)
            targets = conn.execute(
                "SELECT hub_id, batch_number, status, operation_id FROM rollout_targets WHERE rollout_id = ? ORDER BY batch_number, hub_id",
                (rollout_id,),
            ).fetchall()
            return RolloutRecord(
                rolloutId=str(row["rollout_id"]),
                releaseId=str(row["release_id"]),
                status=str(row["status"]),
                createdAt=str(row["created_at"]),
                updatedAt=str(row["updated_at"]),
                selector=json.loads(str(row["selector_json"])),
                targets=[
                    RolloutHubStatus(
                        hubId=str(target["hub_id"]),
                        batchNumber=int(target["batch_number"]),
                        status=str(target["status"]),
                        operationId=str(target["operation_id"]) if target["operation_id"] else None,
                    )
                    for target in targets
                ],
            )
        finally:
            if own_conn:
                conn.close()

    def list_rollouts(self) -> list[RolloutRecord]:
        with self._connect() as conn:
            rows = conn.execute("SELECT rollout_id FROM rollouts ORDER BY created_at DESC").fetchall()
            return [self.get_rollout(str(row["rollout_id"]), conn=conn) for row in rows]

    def pause_rollout(self, rollout_id: str) -> RolloutRecord:
        with self._connect() as conn:
            updated = conn.execute(
                "UPDATE rollouts SET status = 'paused', updated_at = ? WHERE rollout_id = ?",
                (utc_now_iso(), rollout_id),
            ).rowcount
            if updated == 0:
                raise KeyError(rollout_id)
            conn.commit()
            return self.get_rollout(rollout_id, conn=conn)

    def resume_rollout(self, rollout_id: str) -> RolloutRecord:
        with self._lock:
            with self._connect() as conn:
                updated = conn.execute(
                    "UPDATE rollouts SET status = 'active', updated_at = ? WHERE rollout_id = ?",
                    (utc_now_iso(), rollout_id),
                ).rowcount
                if updated == 0:
                    raise KeyError(rollout_id)
                self._maybe_activate_next_batch(conn, rollout_id)
                conn.commit()
                return self.get_rollout(rollout_id, conn=conn)

    def _next_desired_operation(self, conn: sqlite3.Connection, hub_id: str) -> DesiredOperation | None:
        row = conn.execute(
            "SELECT * FROM hub_operations WHERE hub_id = ? AND status IN ('pending', 'in_progress') ORDER BY created_at LIMIT 1",
            (hub_id,),
        ).fetchone()
        if row is None:
            return None
        if row["status"] == "pending":
            conn.execute(
                "UPDATE hub_operations SET status = 'in_progress', updated_at = ? WHERE operation_id = ?",
                (utc_now_iso(), row["operation_id"]),
            )
            row = conn.execute("SELECT * FROM hub_operations WHERE operation_id = ?", (row["operation_id"],)).fetchone()
        manifest = None
        artifacts = []
        manifest_url = None
        signature_url = None
        if row["release_id"]:
            release = self.get_release(str(row["release_id"]), conn=conn)
            manifest = release.manifest
            artifacts = release.manifest.artifacts
            manifest_url = f"/api/v1/releases/{release.releaseId}/manifest"
            signature_url = f"/api/v1/releases/{release.releaseId}/manifest.sig"
        return DesiredOperation(
            operationId=str(row["operation_id"]),
            type=str(row["type"]),
            releaseId=str(row["release_id"]) if row["release_id"] else None,
            rolloutId=str(row["rollout_id"]) if row["rollout_id"] else None,
            manifest=manifest,
            manifestUrl=manifest_url,
            signatureUrl=signature_url,
            artifacts=artifacts,
            createdAt=str(row["created_at"]),
        )

    def _queue_operation(self, conn: sqlite3.Connection, hub_id: str, op_type: str, release_id: str | None, rollout_id: str | None) -> str:
        operation_id = f"op-{uuid4().hex[:12]}"
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO hub_operations(operation_id, hub_id, type, release_id, rollout_id, status, detail_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'pending', '{}', ?, ?)",
            (operation_id, hub_id, op_type, release_id, rollout_id, now, now),
        )
        return operation_id
    def _apply_operation_result(
        self,
        conn: sqlite3.Connection,
        hub_id: str,
        operation_id: str,
        status: str,
        release_id: str | None,
        detail: dict[str, Any],
    ) -> None:
        op_row = conn.execute(
            "SELECT * FROM hub_operations WHERE operation_id = ? AND hub_id = ?",
            (operation_id, hub_id),
        ).fetchone()
        if op_row is None:
            raise KeyError(operation_id)
        now = utc_now_iso()
        conn.execute(
            "UPDATE hub_operations SET status = ?, detail_json = ?, updated_at = ? WHERE operation_id = ?",
            (status, _json_dumps(detail), now, operation_id),
        )

        effective_release = release_id or (str(op_row["release_id"]) if op_row["release_id"] else None)
        if status == "succeeded" and op_row["type"] == "install_release" and effective_release:
            conn.execute(
                "UPDATE hubs SET current_release_id = ?, last_known_good_release_id = ? WHERE hub_id = ?",
                (effective_release, effective_release, hub_id),
            )
        elif status in {"rolled_back", "failed"} and op_row["type"] == "rollback_release" and effective_release:
            conn.execute("UPDATE hubs SET current_release_id = ? WHERE hub_id = ?", (effective_release, hub_id))

        rollout_id = str(op_row["rollout_id"]) if op_row["rollout_id"] else None
        if rollout_id:
            conn.execute(
                "UPDATE rollout_targets SET status = ?, operation_id = ? WHERE rollout_id = ? AND hub_id = ?",
                (status, operation_id, rollout_id, hub_id),
            )
            self._update_rollout_after_operation(conn, rollout_id)

    def _update_rollout_after_operation(self, conn: sqlite3.Connection, rollout_id: str) -> None:
        rollout = conn.execute("SELECT * FROM rollouts WHERE rollout_id = ?", (rollout_id,)).fetchone()
        if rollout is None or str(rollout["status"]) == "paused":
            return
        targets = conn.execute(
            "SELECT batch_number, status FROM rollout_targets WHERE rollout_id = ? ORDER BY batch_number, hub_id",
            (rollout_id,),
        ).fetchall()
        active_batches = [
            int(row["batch_number"])
            for row in targets
            if str(row["status"]) in {"pending", "in_progress", "succeeded", "failed", "rolled_back"}
        ]
        if not active_batches:
            return
        current_batch = min(active_batches)
        batch_rows = [row for row in targets if int(row["batch_number"]) == current_batch]
        failures = sum(1 for row in batch_rows if str(row["status"]) in {"failed", "rolled_back"})
        completed = all(str(row["status"]) in {"succeeded", "failed", "rolled_back"} for row in batch_rows)

        if current_batch == 0 and failures > 0:
            conn.execute("UPDATE rollouts SET status = 'paused', updated_at = ? WHERE rollout_id = ?", (utc_now_iso(), rollout_id))
            return
        if failures >= 2:
            conn.execute("UPDATE rollouts SET status = 'paused', updated_at = ? WHERE rollout_id = ?", (utc_now_iso(), rollout_id))
            return
        if completed:
            if self._maybe_activate_next_batch(conn, rollout_id):
                return
            conn.execute("UPDATE rollouts SET status = 'completed', updated_at = ? WHERE rollout_id = ?", (utc_now_iso(), rollout_id))

    def _maybe_activate_next_batch(self, conn: sqlite3.Connection, rollout_id: str) -> bool:
        rollout = conn.execute("SELECT release_id, status FROM rollouts WHERE rollout_id = ?", (rollout_id,)).fetchone()
        if rollout is None or str(rollout["status"]) != "active":
            return False
        next_batch_row = conn.execute(
            "SELECT MIN(batch_number) AS batch_number FROM rollout_targets WHERE rollout_id = ? AND status = 'waiting'",
            (rollout_id,),
        ).fetchone()
        if next_batch_row is None or next_batch_row["batch_number"] is None:
            return False
        batch_number = int(next_batch_row["batch_number"])
        hub_rows = conn.execute(
            "SELECT hub_id FROM rollout_targets WHERE rollout_id = ? AND batch_number = ? AND status = 'waiting' ORDER BY hub_id",
            (rollout_id, batch_number),
        ).fetchall()
        for hub_row in hub_rows:
            hub_id = str(hub_row["hub_id"])
            operation_id = self._queue_operation(conn, hub_id, "install_release", str(rollout["release_id"]), rollout_id)
            conn.execute(
                "UPDATE rollout_targets SET status = 'pending', operation_id = ? WHERE rollout_id = ? AND hub_id = ?",
                (operation_id, rollout_id, hub_id),
            )
        conn.execute("UPDATE rollouts SET updated_at = ? WHERE rollout_id = ?", (utc_now_iso(), rollout_id))
        return True

    def _resolve_selector(self, selector: dict[str, Any]) -> list[str]:
        hubs = self.list_hubs(site=selector.get("site"), channel=selector.get("channel"))
        if selector.get("hubIds"):
            wanted = {str(item) for item in selector["hubIds"]}
            hubs = [hub for hub in hubs if hub.hubId in wanted]
        return [hub.hubId for hub in hubs]

    def _compute_batches(self, targets: list[str]) -> list[tuple[str, int]]:
        ordered = sorted(dict.fromkeys(targets))
        if not ordered:
            return []
        batches: list[tuple[str, int]] = [(ordered[0], 0)]
        remaining = ordered[1:]
        batch_number = 1
        while remaining:
            size = max(1, min(5, math.ceil(len(remaining) * 0.2)))
            chunk, remaining = remaining[:size], remaining[size:]
            batches.extend((hub_id, batch_number) for hub_id in chunk)
            batch_number += 1
        return batches
    def _hub_from_row(self, row: sqlite3.Row) -> HubRecord:
        return HubRecord(
            hubId=str(row["hub_id"]),
            hostname=str(row["hostname"]),
            advertisedName=str(row["advertised_name"]) if row["advertised_name"] else None,
            site=str(row["site"]) if row["site"] else None,
            channel=str(row["channel"]),
            localIpAddresses=json.loads(str(row["local_ip_addresses"] or "[]")),
            agentVersion=str(row["agent_version"]),
            hubVersion=str(row["hub_version"]) if row["hub_version"] else None,
            uiVersion=str(row["ui_version"]) if row["ui_version"] else None,
            managedServices=json.loads(str(row["managed_services"] or "[]")),
            diskFreeBytes=row["disk_free_bytes"],
            uptimeSeconds=row["uptime_seconds"],
            lastBootAt=str(row["last_boot_at"]) if row["last_boot_at"] else None,
            mosquittoEnabled=bool(row["mosquitto_enabled"]),
            mqttBrokerMode=str(row["mqtt_broker_mode"]),
            tags=json.loads(str(row["tags"] or "[]")),
            maintenanceMode=bool(row["maintenance_mode"]),
            enrolledAt=str(row["enrolled_at"]),
            lastCheckInAt=str(row["last_check_in_at"]) if row["last_check_in_at"] else None,
            currentReleaseId=str(row["current_release_id"]) if row["current_release_id"] else None,
            lastKnownGoodReleaseId=str(row["last_known_good_release_id"]) if row["last_known_good_release_id"] else None,
            publicKey=str(row["public_key"]),
        )

    def _release_from_row(self, row: sqlite3.Row) -> ReleaseRecord:
        manifest = ReleaseManifest.model_validate(json.loads(str(row["manifest_json"])))
        return ReleaseRecord(
            releaseId=str(row["release_id"]),
            channel=str(row["channel"]),
            hubVersion=str(row["hub_version"]),
            uiVersion=str(row["ui_version"]),
            agentMinVersion=str(row["agent_min_version"]),
            manifest=manifest,
            createdAt=str(row["created_at"]),
            status=str(row["status"]),
        )

    def _operation_from_row(self, row: sqlite3.Row) -> HubOperationRecord:
        return HubOperationRecord(
            operationId=str(row["operation_id"]),
            hubId=str(row["hub_id"]),
            type=str(row["type"]),
            status=str(row["status"]),
            releaseId=str(row["release_id"]) if row["release_id"] else None,
            rolloutId=str(row["rollout_id"]) if row["rollout_id"] else None,
            detail=json.loads(str(row["detail_json"] or "{}")),
            createdAt=str(row["created_at"]),
            updatedAt=str(row["updated_at"]),
        )


fleet_store = FleetStore(settings.fleet_database_path, settings.fleet_artifact_dir)
