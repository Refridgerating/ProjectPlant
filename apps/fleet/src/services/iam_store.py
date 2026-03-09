from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from auth.jwt import AccessTokenClaims, create_access_token, ensure_jwks_schema
from auth.totp import (
    generate_recovery_codes,
    generate_totp_secret,
    hash_recovery_code,
    provisioning_uri,
    render_otpauth_svg,
    verify_totp,
)
from config import settings
from models import (
    AccountCreateRequest,
    AccountListResponse,
    AccountRecord,
    AccountSummary,
    AccountUpdateRequest,
    AuditEventRecord,
    AuthenticatedPrincipal,
    BootstrapArtifact,
    BootstrapCompleteRequest,
    BootstrapCompleteResponse,
    BootstrapStartResponse,
    BootstrapStatusResponse,
    EffectiveAccessResponse,
    HubAssignmentCreateRequest,
    HubAssignmentRecord,
    HubAssignmentUpdateRequest,
    LocalAuthRequest,
    LocalAuthResponse,
    MasterStateRecord,
    MasterTransferRequest,
    MembershipCreateRequest,
    MembershipRecord,
    MembershipUpdateRequest,
    MfaEnrollmentCompleteRequest,
    MfaEnrollmentStartResponse,
    MfaVerifyRequest,
    OrganizationCreateRequest,
    OrganizationRecord,
    OrganizationUpdateRequest,
    PolicyBindingRecord,
    PolicyCreateRequest,
    PolicyUpdateRequest,
    RecoveryChallengeResponse,
    RecoveryCodesRotateResponse,
    RecoveryCompleteRequest,
    RecoveryStatusResponse,
    RotateRecoveryKeyRequest,
    SecurityStatusResponse,
    SiteCreateRequest,
    SiteRecord,
    SiteUpdateRequest,
    SystemRole,
)
from security import (
    decrypt_sensitive_value,
    encrypt_sensitive_value,
    hash_password,
    recovery_public_key_fingerprint,
    sha256_hexdigest,
    utc_now_iso,
    verify_password,
    verify_recovery_signature,
)


ALL_CAPABILITIES = {
    "master.transfer",
    "master.activate_backup",
    "master.deactivate_backup",
    "master.rotate_recovery_key",
    "fleet.view",
    "hub.view",
    "hub.control",
    "hub.update",
    "hub.rollback",
    "release.view",
    "release.register",
    "rollout.view",
    "rollout.execute",
    "rollout.pause",
    "rollout.resume",
    "account.view",
    "account.manage",
    "policy.view",
    "policy.manage",
    "audit.view",
    "recovery.manage",
}
ROLE_BASELINE_CAPABILITIES: dict[SystemRole, set[str]] = {
    "master": set(ALL_CAPABILITIES),
    "administrator": {
        "fleet.view",
        "hub.view",
        "hub.control",
        "release.view",
        "rollout.view",
        "account.view",
        "account.manage",
        "audit.view",
        "policy.view",
    },
    "user": {"hub.view", "hub.control"},
}


def utc_now_plus(seconds: int) -> str:
    value = datetime.now(timezone.utc) + timedelta(seconds=max(1, int(seconds)))
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _slugify(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or f"item-{uuid4().hex[:8]}"


class IamStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._init_db()

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
                CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    system_role TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    recovery_only INTEGER NOT NULL DEFAULT 0,
                    must_change_password INTEGER NOT NULL DEFAULT 0,
                    mfa_required INTEGER NOT NULL DEFAULT 0,
                    last_login_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    session_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    system_role TEXT NOT NULL,
                    recovery_session INTEGER NOT NULL DEFAULT 0,
                    mfa_verified_at TEXT,
                    token_version INTEGER NOT NULL DEFAULT 1,
                    access_expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    revoked_at TEXT,
                    remote_addr TEXT,
                    user_agent TEXT
                );
                CREATE TABLE IF NOT EXISTS master_state (
                    singleton_key TEXT PRIMARY KEY,
                    primary_account_id TEXT,
                    backup_account_id TEXT,
                    backup_active INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT
                );
                CREATE TABLE IF NOT EXISTS bootstrap_state (
                    singleton_key TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    bootstrap_expires_at TEXT,
                    bootstrap_consumed_at TEXT,
                    bootstrap_nonce TEXT,
                    bootstrap_nonce_expires_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_keys (
                    key_id TEXT PRIMARY KEY,
                    public_key TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    rotated_at TEXT
                );
                CREATE TABLE IF NOT EXISTS recovery_challenges (
                    challenge_id TEXT PRIMARY KEY,
                    challenge TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    used_at TEXT
                );
                CREATE TABLE IF NOT EXISTS audit_events (
                    event_id TEXT PRIMARY KEY,
                    actor_account_id TEXT,
                    actor_role TEXT,
                    event_type TEXT NOT NULL,
                    target_type TEXT,
                    target_id TEXT,
                    outcome TEXT NOT NULL,
                    remote_addr TEXT,
                    user_agent TEXT,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS organizations (
                    org_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL UNIQUE,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sites (
                    site_id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    network_label TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(org_id, slug)
                );
                CREATE TABLE IF NOT EXISTS memberships (
                    membership_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS policy_bindings (
                    policy_id TEXT PRIMARY KEY,
                    principal_type TEXT NOT NULL,
                    principal_id TEXT NOT NULL,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    effect TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS hub_assignments (
                    hub_id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL,
                    site_id TEXT NOT NULL,
                    assigned_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mfa_factors (
                    factor_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    secret_ciphertext TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
                    code_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    code_hash TEXT NOT NULL,
                    used_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS login_challenges (
                    challenge_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    factor_type TEXT NOT NULL,
                    secret_ciphertext TEXT,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    used_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO master_state(singleton_key, backup_active) VALUES('master', 0);
                INSERT OR IGNORE INTO bootstrap_state(singleton_key, enabled, created_at) VALUES('bootstrap', 0, '1970-01-01T00:00:00Z');
                """
            )
            conn.commit()
        ensure_jwks_schema()
        self._sync_scope_catalog()

    def reset(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                DELETE FROM auth_sessions;
                DELETE FROM accounts;
                DELETE FROM recovery_keys;
                DELETE FROM recovery_challenges;
                DELETE FROM audit_events;
                DELETE FROM memberships;
                DELETE FROM policy_bindings;
                DELETE FROM hub_assignments;
                DELETE FROM organizations;
                DELETE FROM sites;
                DELETE FROM mfa_factors;
                DELETE FROM mfa_recovery_codes;
                DELETE FROM login_challenges;
                UPDATE master_state SET primary_account_id = NULL, backup_account_id = NULL, backup_active = 0, updated_at = NULL WHERE singleton_key = 'master';
                UPDATE bootstrap_state SET enabled = 0, bootstrap_expires_at = NULL, bootstrap_consumed_at = NULL, bootstrap_nonce = NULL, bootstrap_nonce_expires_at = NULL, created_at = '1970-01-01T00:00:00Z' WHERE singleton_key = 'bootstrap';
                """
            )
            conn.commit()
        self._sync_scope_catalog()

    @staticmethod
    def _parse_timestamp(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def _is_expired(self, value: str) -> bool:
        return self._parse_timestamp(value) <= datetime.now(timezone.utc)

    def _bootstrap_artifact(self, *, allow_missing: bool = False) -> BootstrapArtifact | None:
        path = Path(settings.fleet_bootstrap_artifact_path)
        if not path.exists():
            if allow_missing:
                return None
            raise ValueError(f"Bootstrap artifact not found at {path}")
        return BootstrapArtifact.model_validate_json(path.read_text(encoding="utf-8"))

    def _bootstrap_state_row(self) -> sqlite3.Row | None:
        with self._connect() as conn:
            return conn.execute("SELECT * FROM bootstrap_state WHERE singleton_key = 'bootstrap'").fetchone()

    def _master_state_row(self, conn: sqlite3.Connection | None = None) -> sqlite3.Row | None:
        own = conn is None
        conn = conn or self._connect()
        try:
            return conn.execute("SELECT * FROM master_state WHERE singleton_key = 'master'").fetchone()
        finally:
            if own:
                conn.close()

    def _scope_exists(self, conn: sqlite3.Connection, scope_type: str, scope_id: str) -> bool:
        if scope_type == "organization":
            return conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (scope_id,)).fetchone() is not None
        if scope_type == "site":
            return conn.execute("SELECT 1 FROM sites WHERE site_id = ?", (scope_id,)).fetchone() is not None
        if scope_type == "hub":
            return conn.execute("SELECT 1 FROM hubs WHERE hub_id = ?", (scope_id,)).fetchone() is not None
        return False

    def _membership_from_row(self, row: sqlite3.Row) -> MembershipRecord:
        return MembershipRecord(
            membershipId=str(row["membership_id"]),
            accountId=str(row["account_id"]),
            scopeType=str(row["scope_type"]),
            scopeId=str(row["scope_id"]),
            role=str(row["role"]),
            active=bool(row["active"]),
            createdAt=str(row["created_at"]),
            updatedAt=str(row["updated_at"]),
        )

    def _policy_from_row(self, row: sqlite3.Row) -> PolicyBindingRecord:
        return PolicyBindingRecord(
            policyId=str(row["policy_id"]),
            principalType=str(row["principal_type"]),
            principalId=str(row["principal_id"]),
            scopeType=str(row["scope_type"]),
            scopeId=str(row["scope_id"]),
            capability=str(row["capability"]),
            effect=str(row["effect"]),
            createdAt=str(row["created_at"]),
            updatedAt=str(row["updated_at"]),
        )

    def _hub_assignment_from_row(self, row: sqlite3.Row) -> HubAssignmentRecord:
        return HubAssignmentRecord(hubId=str(row["hub_id"]), orgId=str(row["org_id"]), siteId=str(row["site_id"]), assignedAt=str(row["assigned_at"]))

    def _organization_from_row(self, row: sqlite3.Row) -> OrganizationRecord:
        return OrganizationRecord(orgId=str(row["org_id"]), name=str(row["name"]), slug=str(row["slug"]), active=bool(row["active"]), createdAt=str(row["created_at"]), updatedAt=str(row["updated_at"]))

    def _site_from_row(self, row: sqlite3.Row) -> SiteRecord:
        return SiteRecord(siteId=str(row["site_id"]), orgId=str(row["org_id"]), name=str(row["name"]), slug=str(row["slug"]), networkLabel=str(row["network_label"]) if row["network_label"] else None, active=bool(row["active"]), createdAt=str(row["created_at"]), updatedAt=str(row["updated_at"]))

    def _list_memberships_for_account(self, conn: sqlite3.Connection, account_id: str) -> list[MembershipRecord]:
        rows = conn.execute("SELECT * FROM memberships WHERE account_id = ? ORDER BY created_at ASC", (account_id,)).fetchall()
        return [self._membership_from_row(row) for row in rows]

    def _account_from_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> AccountRecord:
        mfa_enabled = conn.execute("SELECT 1 FROM mfa_factors WHERE account_id = ? AND enabled = 1 LIMIT 1", (row["account_id"],)).fetchone() is not None
        return AccountRecord(
            accountId=str(row["account_id"]),
            email=str(row["email"]),
            displayName=str(row["display_name"]),
            systemRole=str(row["system_role"]),
            active=bool(row["active"]),
            recoveryOnly=bool(row["recovery_only"]),
            mustChangePassword=bool(row["must_change_password"]),
            mfaEnabled=mfa_enabled,
            mfaRequired=bool(row["mfa_required"]),
            lastLoginAt=str(row["last_login_at"]) if row["last_login_at"] else None,
            memberships=self._list_memberships_for_account(conn, str(row["account_id"])),
            createdAt=str(row["created_at"]),
            updatedAt=str(row["updated_at"]),
        )

    def _summary_from_account(self, account: AccountRecord) -> AccountSummary:
        return AccountSummary(
            accountId=account.accountId,
            email=account.email,
            displayName=account.displayName,
            systemRole=account.systemRole,
            active=account.active,
            mustChangePassword=account.mustChangePassword,
            mfaEnabled=account.mfaEnabled,
            lastLoginAt=account.lastLoginAt,
            memberships=account.memberships,
        )

    def _audit_from_row(self, row: sqlite3.Row) -> AuditEventRecord:
        return AuditEventRecord(
            eventId=str(row["event_id"]),
            actorAccountId=str(row["actor_account_id"]) if row["actor_account_id"] else None,
            actorRole=str(row["actor_role"]) if row["actor_role"] else None,
            eventType=str(row["event_type"]),
            targetType=str(row["target_type"]) if row["target_type"] else None,
            targetId=str(row["target_id"]) if row["target_id"] else None,
            outcome=str(row["outcome"]),
            remoteAddr=str(row["remote_addr"]) if row["remote_addr"] else None,
            userAgent=str(row["user_agent"]) if row["user_agent"] else None,
            metadata=json.loads(str(row["metadata_json"] or "{}")),
            createdAt=str(row["created_at"]),
        )
    def _create_default_org(self, conn: sqlite3.Connection) -> str:
        row = conn.execute("SELECT org_id FROM organizations ORDER BY created_at ASC LIMIT 1").fetchone()
        if row is not None:
            return str(row["org_id"])
        now = utc_now_iso()
        org_id = "org-default"
        conn.execute(
            "INSERT INTO organizations(org_id, name, slug, active, created_at, updated_at) VALUES(?, 'Default Organization', 'default', 1, ?, ?)",
            (org_id, now, now),
        )
        return org_id

    def _ensure_site(self, conn: sqlite3.Connection, org_id: str, site_name: str) -> str:
        network_label = site_name.strip() or "unassigned"
        row = conn.execute("SELECT site_id FROM sites WHERE org_id = ? AND network_label = ? LIMIT 1", (org_id, network_label)).fetchone()
        if row is not None:
            return str(row["site_id"])
        slug = _slugify(network_label)
        site_id = f"site-{slug}"
        if conn.execute("SELECT 1 FROM sites WHERE site_id = ?", (site_id,)).fetchone() is not None:
            site_id = f"site-{slug}-{uuid4().hex[:6]}"
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO sites(site_id, org_id, name, slug, network_label, active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
            (site_id, org_id, network_label, slug, network_label, now, now),
        )
        return site_id

    def _sync_scope_catalog(self) -> None:
        with self._connect() as conn:
            org_id = self._create_default_org(conn)
            hubs_table = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hubs'").fetchone()
            if hubs_table is not None:
                hub_rows = conn.execute("SELECT hub_id, site FROM hubs").fetchall()
                for hub in hub_rows:
                    site_name = str(hub["site"] or "unassigned")
                    site_id = self._ensure_site(conn, org_id, site_name)
                    conn.execute(
                        "INSERT OR IGNORE INTO hub_assignments(hub_id, org_id, site_id, assigned_at) VALUES(?, ?, ?, ?)",
                        (str(hub["hub_id"]), org_id, site_id, utc_now_iso()),
                    )
            conn.commit()

    def audit_event(
        self,
        *,
        event_type: str,
        outcome: str,
        actor_account_id: str | None = None,
        actor_role: SystemRole | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        remote_addr: str | None = None,
        user_agent: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AuditEventRecord:
        event = AuditEventRecord(
            eventId=f"audit-{uuid4().hex[:12]}",
            actorAccountId=actor_account_id,
            actorRole=actor_role,
            eventType=event_type,
            targetType=target_type,
            targetId=target_id,
            outcome=outcome,
            remoteAddr=remote_addr,
            userAgent=user_agent,
            metadata=metadata or {},
            createdAt=utc_now_iso(),
        )
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO audit_events(event_id, actor_account_id, actor_role, event_type, target_type, target_id, outcome, remote_addr, user_agent, metadata_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event.eventId,
                    event.actorAccountId,
                    event.actorRole,
                    event.eventType,
                    event.targetType,
                    event.targetId,
                    event.outcome,
                    event.remoteAddr,
                    event.userAgent,
                    json.dumps(event.metadata, separators=(",", ":"), ensure_ascii=True),
                    event.createdAt,
                ),
            )
            conn.commit()
        return event

    def _recent_failure_count(self, conn: sqlite3.Connection, event_type: str, *, account_id: str | None = None, email: str | None = None, remote_addr: str | None = None) -> int:
        threshold = datetime.now(timezone.utc) - timedelta(seconds=settings.auth_login_rate_limit_window_seconds)
        rows = conn.execute(
            "SELECT metadata_json, remote_addr, actor_account_id, created_at FROM audit_events WHERE event_type = ? AND outcome = 'failed' AND created_at >= ?",
            (event_type, threshold.isoformat(timespec="seconds").replace("+00:00", "Z")),
        ).fetchall()
        count = 0
        for row in rows:
            meta = json.loads(str(row["metadata_json"] or "{}"))
            if account_id and str(row["actor_account_id"] or meta.get("accountId") or "") != account_id:
                continue
            if email and str(meta.get("email") or "").lower() != email.lower():
                continue
            if remote_addr and str(row["remote_addr"] or "") != remote_addr:
                continue
            count += 1
        return count

    def _assert_rate_limit(self, conn: sqlite3.Connection, *, event_type: str, account_id: str | None = None, email: str | None = None, remote_addr: str | None = None) -> None:
        attempts = self._recent_failure_count(conn, event_type, account_id=account_id, email=email, remote_addr=remote_addr)
        if attempts >= settings.auth_login_rate_limit_attempts:
            raise ValueError("Too many failed authentication attempts")

    def _insert_account(
        self,
        conn: sqlite3.Connection,
        *,
        email: str,
        password: str,
        display_name: str,
        system_role: SystemRole,
        active: bool,
        recovery_only: bool,
        must_change_password: bool = False,
    ) -> AccountRecord:
        account_id = f"acct-{uuid4().hex[:12]}"
        now = utc_now_iso()
        conn.execute(
            """
            INSERT INTO accounts(account_id, email, display_name, password_hash, system_role, active, recovery_only, must_change_password, mfa_required, last_login_at, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                account_id,
                email.strip().lower(),
                display_name.strip() or email.strip().lower(),
                hash_password(password),
                system_role,
                1 if active else 0,
                1 if recovery_only else 0,
                1 if must_change_password else 0,
                1 if system_role == "master" else 0,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM accounts WHERE account_id = ?", (account_id,)).fetchone()
        assert row is not None
        return self._account_from_row(conn, row)

    def _create_membership(self, conn: sqlite3.Connection, payload: MembershipCreateRequest) -> MembershipRecord:
        if payload.role == "master":
            raise ValueError("Master cannot be granted through membership")
        if not self._scope_exists(conn, payload.scopeType, payload.scopeId):
            raise ValueError("Scope not found")
        membership_id = f"mem-{uuid4().hex[:12]}"
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO memberships(membership_id, account_id, scope_type, scope_id, role, active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
            (membership_id, payload.accountId, payload.scopeType, payload.scopeId, payload.role, now, now),
        )
        row = conn.execute("SELECT * FROM memberships WHERE membership_id = ?", (membership_id,)).fetchone()
        assert row is not None
        return self._membership_from_row(row)

    def _mfa_enabled(self, conn: sqlite3.Connection, account_id: str) -> bool:
        return conn.execute("SELECT 1 FROM mfa_factors WHERE account_id = ? AND enabled = 1 LIMIT 1", (account_id,)).fetchone() is not None

    def _session_mfa_verified_at(self, conn: sqlite3.Connection, session_id: str) -> str | None:
        row = conn.execute("SELECT mfa_verified_at FROM auth_sessions WHERE session_id = ?", (session_id,)).fetchone()
        return None if row is None or not row["mfa_verified_at"] else str(row["mfa_verified_at"])

    def _create_session(
        self,
        conn: sqlite3.Connection,
        account: AccountRecord,
        *,
        remote_addr: str | None,
        user_agent: str | None,
        recovery_session: bool,
        mfa_satisfied: bool,
    ) -> dict[str, Any]:
        session_id = f"sess-{uuid4().hex[:12]}"
        ttl = settings.auth_master_access_token_ttl_seconds if account.systemRole == "master" else settings.auth_user_access_token_ttl_seconds
        now = utc_now_iso()
        mfa_verified_at = now if mfa_satisfied else None
        conn.execute(
            """
            INSERT INTO auth_sessions(session_id, account_id, system_role, recovery_session, mfa_verified_at, token_version, access_expires_at, created_at, revoked_at, remote_addr, user_agent)
            VALUES(?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)
            """,
            (
                session_id,
                account.accountId,
                account.systemRole,
                1 if recovery_session else 0,
                mfa_verified_at,
                utc_now_plus(ttl),
                now,
                remote_addr,
                user_agent,
            ),
        )
        conn.execute("UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE account_id = ?", (now, now, account.accountId))
        effective = self.get_effective_access(account.accountId, session_id=session_id, conn=conn)
        token = create_access_token(
            account.accountId,
            conn=conn,
            session_id=session_id,
            system_role=account.systemRole,
            email=account.email,
            capabilities=effective.capabilities,
            scopes=effective.scopes,
            organization_ids=effective.organizations,
            site_ids=effective.sites,
            hub_ids=effective.hubs,
            is_primary_master=effective.isPrimaryMaster,
            is_backup_master=effective.isBackupMaster,
            master_controls_enabled=effective.masterControlsEnabled,
            mfa_satisfied=effective.mfaSatisfied,
            recovery_session=recovery_session,
            expires_in_seconds=ttl,
        )
        return {"token": token, "expiresIn": ttl, "sessionId": session_id, "effective": effective}
    def primary_master_exists(self) -> bool:
        with self._connect() as conn:
            row = self._master_state_row(conn)
            return bool(row and row["primary_account_id"])

    def get_master_state(self) -> MasterStateRecord:
        with self._connect() as conn:
            row = self._master_state_row(conn)
            return MasterStateRecord(
                primaryAccountId=str(row["primary_account_id"]) if row and row["primary_account_id"] else None,
                backupAccountId=str(row["backup_account_id"]) if row and row["backup_account_id"] else None,
                backupActive=bool(row["backup_active"]) if row else False,
                updatedAt=str(row["updated_at"]) if row and row["updated_at"] else None,
            )

    def get_bootstrap_status(self) -> BootstrapStatusResponse:
        artifact = self._bootstrap_artifact(allow_missing=True)
        has_primary = self.primary_master_exists()
        return BootstrapStatusResponse(
            bootstrapEnabled=bool(artifact) and not has_primary,
            primaryMasterExists=has_primary,
            bootstrapExpiresAt=artifact.bootstrapExpiresAt if artifact else None,
        )

    def _sync_recovery_key(self, conn: sqlite3.Connection) -> None:
        key_path = Path(settings.fleet_recovery_public_key_path)
        fingerprint = recovery_public_key_fingerprint(str(key_path))
        if not fingerprint or not key_path.exists():
            return
        existing = conn.execute("SELECT key_id FROM recovery_keys WHERE status = 'active' LIMIT 1").fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO recovery_keys(key_id, public_key, fingerprint, status, created_at, rotated_at) VALUES(?, ?, ?, 'active', ?, NULL)",
                (f"rec-{uuid4().hex[:12]}", key_path.read_text(encoding="utf-8").strip(), fingerprint, utc_now_iso()),
            )

    def start_bootstrap(self, token: str, remote_addr: str | None, user_agent: str | None) -> BootstrapStartResponse:
        with self._lock:
            artifact = self._bootstrap_artifact()
            if self.primary_master_exists():
                raise ValueError("Bootstrap unavailable after primary master is created")
            if self._is_expired(artifact.bootstrapExpiresAt):
                raise ValueError("Bootstrap artifact expired")
            if sha256_hexdigest(token.strip().encode("utf-8")) != artifact.bootstrapTokenHash:
                self.audit_event(event_type="bootstrap.start", outcome="failed", remote_addr=remote_addr, user_agent=user_agent, metadata={"reason": "token mismatch"})
                raise ValueError("Invalid bootstrap token")
            nonce = uuid4().hex
            with self._connect() as conn:
                conn.execute(
                    "UPDATE bootstrap_state SET enabled = 1, bootstrap_expires_at = ?, bootstrap_consumed_at = NULL, bootstrap_nonce = ?, bootstrap_nonce_expires_at = ?, created_at = ? WHERE singleton_key = 'bootstrap'",
                    (artifact.bootstrapExpiresAt, nonce, utc_now_plus(settings.fleet_bootstrap_nonce_ttl_seconds), utc_now_iso()),
                )
                conn.commit()
            self.audit_event(event_type="bootstrap.start", outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent, metadata={"primaryEmail": artifact.primaryMasterEmail})
            return BootstrapStartResponse(
                bootstrapNonce=nonce,
                primaryEmail=artifact.primaryMasterEmail,
                backupEmail=artifact.backupMaster.email if artifact.backupMaster else None,
                bootstrapExpiresAt=artifact.bootstrapExpiresAt,
            )

    def complete_bootstrap(self, payload: BootstrapCompleteRequest, remote_addr: str | None, user_agent: str | None) -> BootstrapCompleteResponse:
        with self._lock:
            artifact = self._bootstrap_artifact()
            state = self._bootstrap_state_row()
            if self.primary_master_exists():
                raise ValueError("Bootstrap unavailable after primary master is created")
            if payload.password != payload.confirmPassword:
                raise ValueError("Password confirmation does not match")
            if sha256_hexdigest(payload.bootstrapToken.strip().encode("utf-8")) != artifact.bootstrapTokenHash:
                raise ValueError("Invalid bootstrap token")
            if self._is_expired(artifact.bootstrapExpiresAt):
                raise ValueError("Bootstrap artifact expired")
            if state is None or str(state["bootstrap_nonce"] or "") != payload.bootstrapNonce:
                raise ValueError("Invalid bootstrap nonce")
            if self._is_expired(str(state["bootstrap_nonce_expires_at"] or "1970-01-01T00:00:00Z")):
                raise ValueError("Bootstrap nonce expired")
            expected_fingerprint = artifact.recoveryPublicKeyFingerprint
            installed_fingerprint = recovery_public_key_fingerprint()
            if expected_fingerprint and expected_fingerprint != installed_fingerprint:
                raise ValueError("Recovery public key fingerprint mismatch")
            with self._connect() as conn:
                primary = self._insert_account(
                    conn,
                    email=artifact.primaryMasterEmail,
                    password=payload.password,
                    display_name=payload.displayName or artifact.primaryMasterDisplayName or artifact.primaryMasterEmail,
                    system_role="master",
                    active=True,
                    recovery_only=False,
                )
                backup = None
                if artifact.backupMaster is not None:
                    backup = self._insert_account(
                        conn,
                        email=artifact.backupMaster.email,
                        password=uuid4().hex + uuid4().hex,
                        display_name=artifact.backupMaster.displayName or artifact.backupMaster.email,
                        system_role="master",
                        active=False,
                        recovery_only=True,
                    )
                now = utc_now_iso()
                conn.execute(
                    "UPDATE master_state SET primary_account_id = ?, backup_account_id = ?, backup_active = 0, updated_at = ? WHERE singleton_key = 'master'",
                    (primary.accountId, backup.accountId if backup else None, now),
                )
                conn.execute(
                    "UPDATE bootstrap_state SET enabled = 0, bootstrap_expires_at = ?, bootstrap_consumed_at = ?, bootstrap_nonce = NULL, bootstrap_nonce_expires_at = NULL, created_at = ? WHERE singleton_key = 'bootstrap'",
                    (artifact.bootstrapExpiresAt, now, now),
                )
                self._sync_recovery_key(conn)
                session = self._create_session(conn, primary, remote_addr=remote_addr, user_agent=user_agent, recovery_session=False, mfa_satisfied=False)
                conn.commit()
            path = Path(settings.fleet_bootstrap_artifact_path)
            if path.exists():
                path.unlink()
            self.audit_event(actor_account_id=primary.accountId, actor_role="master", event_type="bootstrap.complete", target_type="account", target_id=primary.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
            return BootstrapCompleteResponse(
                access_token=session["token"],
                expires_in=session["expiresIn"],
                account=primary,
                effectiveAccess=session["effective"],
                masterState=self.get_master_state(),
            )

    def create_account(self, *, email: str, password: str, display_name: str, system_role: SystemRole = "user", active: bool = True, recovery_only: bool = False, must_change_password: bool = False) -> AccountRecord:
        with self._connect() as conn:
            account = self._insert_account(
                conn,
                email=email,
                password=password,
                display_name=display_name,
                system_role=system_role,
                active=active,
                recovery_only=recovery_only,
                must_change_password=must_change_password,
            )
            conn.commit()
            return account

    def authenticate_local(self, payload: LocalAuthRequest, remote_addr: str | None, user_agent: str | None) -> LocalAuthResponse:
        email = payload.email.strip().lower()
        with self._lock:
            with self._connect() as conn:
                self._assert_rate_limit(conn, event_type="auth.local", email=email, remote_addr=remote_addr)
                row = conn.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
                if row is None or not verify_password(str(row["password_hash"]), payload.password):
                    self.audit_event(event_type="auth.local", outcome="failed", remote_addr=remote_addr, user_agent=user_agent, metadata={"email": email})
                    raise ValueError("Invalid email or password")
                account = self._account_from_row(conn, row)
                state = self.get_master_state()
                if account.recoveryOnly and (not state.backupActive or state.backupAccountId != account.accountId):
                    raise ValueError("Backup master is not active")
                if not account.active:
                    raise ValueError("Account is inactive")
                if account.systemRole == "master" and self._mfa_enabled(conn, account.accountId):
                    challenge_id = f"mfa-{uuid4().hex[:12]}"
                    expires_at = utc_now_plus(settings.auth_mfa_challenge_ttl_seconds)
                    conn.execute(
                        "INSERT INTO login_challenges(challenge_id, account_id, purpose, factor_type, secret_ciphertext, expires_at, created_at, used_at, attempts) VALUES(?, ?, 'login', 'totp', NULL, ?, ?, NULL, 0)",
                        (challenge_id, account.accountId, expires_at, utc_now_iso()),
                    )
                    conn.commit()
                    self.audit_event(actor_account_id=account.accountId, actor_role=account.systemRole, event_type="auth.mfa.challenge.issued", target_type="account", target_id=account.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
                    return LocalAuthResponse(mfaRequired=True, challengeId=challenge_id, factorType="totp", expiresAt=expires_at)
                session = self._create_session(conn, account, remote_addr=remote_addr, user_agent=user_agent, recovery_session=False, mfa_satisfied=False)
                conn.commit()
            self.audit_event(actor_account_id=account.accountId, actor_role=account.systemRole, event_type="auth.local", target_type="account", target_id=account.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
            return LocalAuthResponse(access_token=session["token"], expires_in=session["expiresIn"], account=account, effectiveAccess=session["effective"])

    def verify_mfa(self, payload: MfaVerifyRequest, remote_addr: str | None, user_agent: str | None) -> LocalAuthResponse:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM login_challenges WHERE challenge_id = ?", (payload.challengeId,)).fetchone()
                if row is None:
                    raise ValueError("MFA challenge not found")
                account_id = str(row["account_id"])
                self._assert_rate_limit(conn, event_type="auth.mfa.verify", account_id=account_id, remote_addr=remote_addr)
                if row["used_at"]:
                    raise ValueError("MFA challenge already used")
                if self._is_expired(str(row["expires_at"])):
                    raise ValueError("MFA challenge expired")
                account_row = conn.execute("SELECT * FROM accounts WHERE account_id = ?", (account_id,)).fetchone()
                if account_row is None:
                    raise ValueError("Account not found")
                factor_row = conn.execute("SELECT * FROM mfa_factors WHERE account_id = ? AND enabled = 1 LIMIT 1", (account_id,)).fetchone()
                if factor_row is None:
                    raise ValueError("MFA is not enrolled for this account")
                code = payload.code.strip()
                valid = verify_totp(decrypt_sensitive_value(str(factor_row["secret_ciphertext"])), code)
                if not valid:
                    recovery_rows = conn.execute("SELECT code_id, code_hash FROM mfa_recovery_codes WHERE account_id = ? AND used_at IS NULL", (account_id,)).fetchall()
                    normalized = hash_recovery_code(code)
                    matched = next((recovery for recovery in recovery_rows if str(recovery["code_hash"]) == normalized), None)
                    if matched is not None:
                        conn.execute("UPDATE mfa_recovery_codes SET used_at = ? WHERE code_id = ?", (utc_now_iso(), str(matched["code_id"])))
                        valid = True
                if not valid:
                    conn.execute("UPDATE login_challenges SET attempts = attempts + 1 WHERE challenge_id = ?", (payload.challengeId,))
                    conn.commit()
                    self.audit_event(actor_account_id=account_id, actor_role=str(account_row["system_role"]), event_type="auth.mfa.verify", target_type="account", target_id=account_id, outcome="failed", remote_addr=remote_addr, user_agent=user_agent, metadata={"challengeId": payload.challengeId})
                    raise ValueError("Invalid MFA code")
                conn.execute("UPDATE login_challenges SET used_at = ? WHERE challenge_id = ?", (utc_now_iso(), payload.challengeId))
                account = self._account_from_row(conn, account_row)
                session = self._create_session(conn, account, remote_addr=remote_addr, user_agent=user_agent, recovery_session=False, mfa_satisfied=True)
                conn.commit()
            self.audit_event(actor_account_id=account.accountId, actor_role=account.systemRole, event_type="auth.mfa.verify", target_type="account", target_id=account.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
            return LocalAuthResponse(access_token=session["token"], expires_in=session["expiresIn"], account=account, effectiveAccess=session["effective"])
    def revoke_session(self, principal: AuthenticatedPrincipal) -> None:
        with self._connect() as conn:
            conn.execute("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id = ?", (utc_now_iso(), principal.sessionId))
            conn.commit()

    def principal_from_claims(self, claims: AccessTokenClaims) -> AuthenticatedPrincipal:
        with self._connect() as conn:
            session_row = conn.execute("SELECT * FROM auth_sessions WHERE session_id = ?", (claims.session_id,)).fetchone()
            if session_row is None:
                raise ValueError("Session not found")
            if session_row["revoked_at"]:
                raise ValueError("Session revoked")
            if self._is_expired(str(session_row["access_expires_at"])):
                raise ValueError("Session expired")
            account_row = conn.execute("SELECT * FROM accounts WHERE account_id = ?", (claims.account_id,)).fetchone()
            if account_row is None:
                raise ValueError("Account not found")
            account = self._account_from_row(conn, account_row)
            if not account.active:
                raise ValueError("Account inactive")
            state = self.get_master_state()
            is_primary = state.primaryAccountId == account.accountId
            is_backup = bool(state.backupActive and state.backupAccountId == account.accountId)
            if account.systemRole == "master" and not (is_primary or is_backup):
                raise ValueError("Master account is not active")
            effective = self.get_effective_access(account.accountId, session_id=str(session_row["session_id"]), conn=conn)
            return AuthenticatedPrincipal(
                accountId=account.accountId,
                email=account.email,
                sessionId=str(session_row["session_id"]),
                systemRole=effective.systemRole,
                isPrimaryMaster=is_primary,
                isBackupMaster=is_backup,
                masterControlsEnabled=effective.masterControlsEnabled,
                recoverySession=bool(session_row["recovery_session"]),
                mfaRequired=effective.mfaRequired,
                mfaSatisfied=effective.mfaSatisfied,
                capabilities=effective.capabilities,
                scopes=effective.scopes,
                organizations=effective.organizations,
                sites=effective.sites,
                hubs=effective.hubs,
            )

    def get_account(self, account_id: str, *, conn: sqlite3.Connection | None = None) -> AccountRecord:
        own = conn is None
        conn = conn or self._connect()
        try:
            row = conn.execute("SELECT * FROM accounts WHERE account_id = ?", (account_id,)).fetchone()
            if row is None:
                raise KeyError(account_id)
            return self._account_from_row(conn, row)
        finally:
            if own:
                conn.close()

    def _policy_rows_for(self, conn: sqlite3.Connection, account_id: str, system_role: SystemRole) -> list[sqlite3.Row]:
        return conn.execute(
            "SELECT * FROM policy_bindings WHERE (principal_type = 'account' AND principal_id = ?) OR (principal_type = 'role' AND principal_id = ?)",
            (account_id, system_role),
        ).fetchall()

    def _resolve_scope_sets(self, conn: sqlite3.Connection, account: AccountRecord) -> tuple[set[str], set[str], set[str], list[str]]:
        if account.systemRole == "master":
            org_ids = {str(row["org_id"]) for row in conn.execute("SELECT org_id FROM organizations").fetchall()}
            site_ids = {str(row["site_id"]) for row in conn.execute("SELECT site_id FROM sites").fetchall()}
            hub_ids = {str(row["hub_id"]) for row in conn.execute("SELECT hub_id FROM hubs").fetchall()} if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='hubs'").fetchone() else set()
            return org_ids, site_ids, hub_ids, ["ecosystem"]

        memberships = [membership for membership in account.memberships if membership.active]
        org_ids = {membership.scopeId for membership in memberships if membership.scopeType == "organization"}
        site_ids = {membership.scopeId for membership in memberships if membership.scopeType == "site"}
        hub_ids = {membership.scopeId for membership in memberships if membership.scopeType == "hub"}

        if org_ids:
            placeholders = ",".join("?" * len(org_ids))
            site_ids.update(str(row["site_id"]) for row in conn.execute(f"SELECT site_id FROM sites WHERE org_id IN ({placeholders})", tuple(org_ids)).fetchall())
        if site_ids:
            placeholders = ",".join("?" * len(site_ids))
            hub_ids.update(str(row["hub_id"]) for row in conn.execute(f"SELECT hub_id FROM hub_assignments WHERE site_id IN ({placeholders})", tuple(site_ids)).fetchall())
        if org_ids:
            placeholders = ",".join("?" * len(org_ids))
            hub_ids.update(str(row["hub_id"]) for row in conn.execute(f"SELECT hub_id FROM hub_assignments WHERE org_id IN ({placeholders})", tuple(org_ids)).fetchall())

        for hub_id in list(hub_ids):
            row = conn.execute("SELECT site_id, org_id FROM hub_assignments WHERE hub_id = ?", (hub_id,)).fetchone()
            if row is not None:
                site_ids.add(str(row["site_id"]))
                org_ids.add(str(row["org_id"]))
        for site_id in list(site_ids):
            row = conn.execute("SELECT org_id FROM sites WHERE site_id = ?", (site_id,)).fetchone()
            if row is not None:
                org_ids.add(str(row["org_id"]))

        scopes = [f"organization:{org_id}" for org_id in sorted(org_ids)]
        scopes += [f"site:{site_id}" for site_id in sorted(site_ids)]
        scopes += [f"hub:{hub_id}" for hub_id in sorted(hub_ids)]
        return org_ids, site_ids, hub_ids, scopes

    def _effective_capabilities(self, conn: sqlite3.Connection, account: AccountRecord, org_ids: set[str], site_ids: set[str], hub_ids: set[str]) -> set[str]:
        if account.systemRole == "master":
            return set(ALL_CAPABILITIES)
        capabilities = set(ROLE_BASELINE_CAPABILITIES[account.systemRole])
        allow_matches: set[str] = set()
        deny_matches: set[str] = set()
        for row in self._policy_rows_for(conn, account.accountId, account.systemRole):
            capability = str(row["capability"])
            scope_type = str(row["scope_type"])
            scope_id = str(row["scope_id"])
            applies = (scope_type == "organization" and scope_id in org_ids) or (scope_type == "site" and scope_id in site_ids) or (scope_type == "hub" and scope_id in hub_ids)
            if not applies:
                continue
            if str(row["effect"]) == "allow":
                allow_matches.add(capability)
            else:
                deny_matches.add(capability)
        capabilities |= allow_matches
        capabilities -= deny_matches
        return capabilities

    def get_effective_access(self, account_id: str, *, session_id: str | None = None, conn: sqlite3.Connection | None = None) -> EffectiveAccessResponse:
        own = conn is None
        conn = conn or self._connect()
        try:
            account = self.get_account(account_id, conn=conn)
            state_row = self._master_state_row(conn)
            primary_account_id = str(state_row["primary_account_id"]) if state_row and state_row["primary_account_id"] else None
            backup_account_id = str(state_row["backup_account_id"]) if state_row and state_row["backup_account_id"] else None
            backup_active = bool(state_row["backup_active"]) if state_row else False
            is_primary = primary_account_id == account.accountId
            is_backup = bool(backup_active and backup_account_id == account.accountId)
            enabled = is_primary or is_backup
            org_ids, site_ids, hub_ids, scopes = self._resolve_scope_sets(conn, account)
            capabilities = sorted(self._effective_capabilities(conn, account, org_ids, site_ids, hub_ids))
            mfa_enabled = self._mfa_enabled(conn, account.accountId)
            mfa_satisfied = bool(session_id and self._session_mfa_verified_at(conn, session_id))
            return EffectiveAccessResponse(
                accountId=account.accountId,
                email=account.email,
                systemRole="master" if enabled else account.systemRole,
                isPrimaryMaster=is_primary,
                isBackupMaster=is_backup,
                masterControlsEnabled=enabled,
                capabilities=capabilities,
                scopes=scopes,
                organizations=sorted(org_ids),
                sites=sorted(site_ids),
                hubs=sorted(hub_ids),
                mfaRequired=bool(enabled and mfa_enabled),
                mfaSatisfied=bool(mfa_satisfied),
            )
        finally:
            if own:
                conn.close()

    def require_capability(self, principal: AuthenticatedPrincipal, capability: str, *, scope_type: str | None = None, scope_id: str | None = None, remote_addr: str | None = None, user_agent: str | None = None) -> None:
        allowed = capability in principal.capabilities
        if allowed and scope_type and scope_id:
            if scope_type == "organization":
                allowed = scope_id in principal.organizations
            elif scope_type == "site":
                allowed = scope_id in principal.sites
            elif scope_type == "hub":
                allowed = scope_id in principal.hubs
        if allowed and principal.systemRole == "master" and principal.mfaRequired and not principal.mfaSatisfied:
            allowed = False
        if not allowed:
            self.audit_event(actor_account_id=principal.accountId, actor_role=principal.systemRole, event_type="authz.denied", outcome="denied", remote_addr=remote_addr, user_agent=user_agent, metadata={"capability": capability, "scopeType": scope_type, "scopeId": scope_id})
            raise PermissionError("Capability denied")

    def list_accounts(self, actor: AuthenticatedPrincipal, *, q: str | None = None, role: SystemRole | None = None, org_id: str | None = None, site_id: str | None = None, active: bool | None = None) -> AccountListResponse:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM accounts ORDER BY email ASC").fetchall()
            accounts = [self._summary_from_account(self._account_from_row(conn, row)) for row in rows]
        filtered: list[AccountSummary] = []
        query = (q or "").strip().lower()
        for account in accounts:
            if role and account.systemRole != role:
                continue
            if active is not None and account.active != active:
                continue
            if query and query not in account.email.lower() and query not in account.displayName.lower():
                continue
            if org_id and not any(m.scopeType == "organization" and m.scopeId == org_id for m in account.memberships):
                continue
            if site_id and not any(m.scopeType == "site" and m.scopeId == site_id for m in account.memberships):
                continue
            if actor.systemRole != "master":
                if account.systemRole == "master":
                    continue
                actor_scopes = set(actor.organizations + actor.sites + actor.hubs)
                account_scopes = {membership.scopeId for membership in account.memberships if membership.active}
                if not actor_scopes.intersection(account_scopes):
                    continue
            filtered.append(account)
        return AccountListResponse(accounts=filtered)

    def create_account_for_actor(self, actor: AuthenticatedPrincipal, payload: AccountCreateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> AccountRecord:
        if actor.systemRole != "master" and payload.systemRole != "user":
            raise PermissionError("Only master can create administrator accounts")
        if payload.systemRole == "master":
            raise PermissionError("Master accounts cannot be created through account management")
        with self._lock:
            with self._connect() as conn:
                account = self._insert_account(
                    conn,
                    email=payload.email,
                    password=payload.temporaryPassword,
                    display_name=payload.displayName or payload.email,
                    system_role=payload.systemRole,
                    active=True,
                    recovery_only=False,
                    must_change_password=payload.mustChangePassword,
                )
                for membership in payload.memberships:
                    membership_payload = MembershipCreateRequest(accountId=account.accountId, scopeType=membership.scopeType, scopeId=membership.scopeId, role=membership.role)
                    if actor.systemRole != "master":
                        if membership_payload.role != "user":
                            raise PermissionError("Administrators can only create user-scoped memberships")
                        if membership_payload.scopeType == "organization" and membership_payload.scopeId not in actor.organizations:
                            raise PermissionError("Membership scope outside administrator access")
                        if membership_payload.scopeType == "site" and membership_payload.scopeId not in actor.sites:
                            raise PermissionError("Membership scope outside administrator access")
                        if membership_payload.scopeType == "hub" and membership_payload.scopeId not in actor.hubs:
                            raise PermissionError("Membership scope outside administrator access")
                    self._create_membership(conn, membership_payload)
                conn.commit()
                created = self.get_account(account.accountId, conn=conn)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="account.created", target_type="account", target_id=created.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return created

    def update_account_for_actor(self, actor: AuthenticatedPrincipal, account_id: str, payload: AccountUpdateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> AccountRecord:
        with self._lock:
            with self._connect() as conn:
                current = self.get_account(account_id, conn=conn)
                if actor.systemRole != "master":
                    if current.systemRole == "master":
                        raise PermissionError("Administrators cannot manage master accounts")
                    actor_scopes = set(actor.organizations + actor.sites + actor.hubs)
                    current_scopes = {membership.scopeId for membership in current.memberships if membership.active}
                    if not actor_scopes.intersection(current_scopes):
                        raise PermissionError("Account outside administrator scope")
                    if payload.systemRole and payload.systemRole != current.systemRole:
                        raise PermissionError("Administrators cannot change account roles")
                if payload.systemRole == "master":
                    raise PermissionError("Master role is protected")
                updates: list[str] = []
                params: list[Any] = []
                if payload.displayName is not None:
                    updates.append("display_name = ?")
                    params.append(payload.displayName.strip() or current.displayName)
                if payload.active is not None:
                    updates.append("active = ?")
                    params.append(1 if payload.active else 0)
                if payload.mustChangePassword is not None:
                    updates.append("must_change_password = ?")
                    params.append(1 if payload.mustChangePassword else 0)
                if payload.systemRole is not None:
                    updates.append("system_role = ?")
                    params.append(payload.systemRole)
                if not updates:
                    return current
                updates.append("updated_at = ?")
                params.append(utc_now_iso())
                params.append(account_id)
                conn.execute(f"UPDATE accounts SET {', '.join(updates)} WHERE account_id = ?", tuple(params))
                conn.commit()
                updated = self.get_account(account_id, conn=conn)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="account.updated", target_type="account", target_id=account_id, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return updated

    def list_organizations(self) -> list[OrganizationRecord]:
        self._sync_scope_catalog()
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM organizations ORDER BY name ASC").fetchall()
            return [self._organization_from_row(row) for row in rows]

    def create_organization(self, payload: OrganizationCreateRequest) -> OrganizationRecord:
        with self._connect() as conn:
            now = utc_now_iso()
            org_id = f"org-{_slugify(payload.slug)}"
            conn.execute("INSERT INTO organizations(org_id, name, slug, active, created_at, updated_at) VALUES(?, ?, ?, 1, ?, ?)", (org_id, payload.name.strip(), _slugify(payload.slug), now, now))
            conn.commit()
            row = conn.execute("SELECT * FROM organizations WHERE org_id = ?", (org_id,)).fetchone()
            assert row is not None
            return self._organization_from_row(row)

    def update_organization(self, org_id: str, payload: OrganizationUpdateRequest) -> OrganizationRecord:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM organizations WHERE org_id = ?", (org_id,)).fetchone()
            if row is None:
                raise KeyError(org_id)
            updates: list[str] = []
            params: list[Any] = []
            if payload.name is not None:
                updates.append("name = ?")
                params.append(payload.name.strip())
            if payload.slug is not None:
                updates.append("slug = ?")
                params.append(_slugify(payload.slug))
            if payload.active is not None:
                updates.append("active = ?")
                params.append(1 if payload.active else 0)
            updates.append("updated_at = ?")
            params.append(utc_now_iso())
            params.append(org_id)
            conn.execute(f"UPDATE organizations SET {', '.join(updates)} WHERE org_id = ?", tuple(params))
            conn.commit()
            next_row = conn.execute("SELECT * FROM organizations WHERE org_id = ?", (org_id,)).fetchone()
            assert next_row is not None
            return self._organization_from_row(next_row)

    def list_sites(self, *, org_id: str | None = None) -> list[SiteRecord]:
        self._sync_scope_catalog()
        with self._connect() as conn:
            if org_id:
                rows = conn.execute("SELECT * FROM sites WHERE org_id = ? ORDER BY name ASC", (org_id,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM sites ORDER BY name ASC").fetchall()
            return [self._site_from_row(row) for row in rows]

    def create_site(self, payload: SiteCreateRequest) -> SiteRecord:
        with self._connect() as conn:
            if conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (payload.orgId,)).fetchone() is None:
                raise KeyError(payload.orgId)
            now = utc_now_iso()
            site_id = f"site-{_slugify(payload.slug)}"
            if conn.execute("SELECT 1 FROM sites WHERE site_id = ?", (site_id,)).fetchone() is not None:
                site_id = f"site-{_slugify(payload.slug)}-{uuid4().hex[:6]}"
            conn.execute(
                "INSERT INTO sites(site_id, org_id, name, slug, network_label, active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
                (site_id, payload.orgId, payload.name.strip(), _slugify(payload.slug), payload.networkLabel.strip() if payload.networkLabel else None, now, now),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM sites WHERE site_id = ?", (site_id,)).fetchone()
            assert row is not None
            return self._site_from_row(row)
    def update_site(self, site_id: str, payload: SiteUpdateRequest) -> SiteRecord:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM sites WHERE site_id = ?", (site_id,)).fetchone()
            if row is None:
                raise KeyError(site_id)
            updates: list[str] = []
            params: list[Any] = []
            if payload.name is not None:
                updates.append("name = ?")
                params.append(payload.name.strip())
            if payload.slug is not None:
                updates.append("slug = ?")
                params.append(_slugify(payload.slug))
            if payload.networkLabel is not None:
                updates.append("network_label = ?")
                params.append(payload.networkLabel.strip() or None)
            if payload.active is not None:
                updates.append("active = ?")
                params.append(1 if payload.active else 0)
            updates.append("updated_at = ?")
            params.append(utc_now_iso())
            params.append(site_id)
            conn.execute(f"UPDATE sites SET {', '.join(updates)} WHERE site_id = ?", tuple(params))
            conn.commit()
            next_row = conn.execute("SELECT * FROM sites WHERE site_id = ?", (site_id,)).fetchone()
            assert next_row is not None
            return self._site_from_row(next_row)

    def create_membership_for_actor(self, actor: AuthenticatedPrincipal, payload: MembershipCreateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> MembershipRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can create memberships directly")
        with self._connect() as conn:
            membership = self._create_membership(conn, payload)
            conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="membership.created", target_type="membership", target_id=membership.membershipId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return membership

    def update_membership_for_actor(self, actor: AuthenticatedPrincipal, membership_id: str, payload: MembershipUpdateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> MembershipRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can update memberships directly")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM memberships WHERE membership_id = ?", (membership_id,)).fetchone()
            if row is None:
                raise KeyError(membership_id)
            updates: list[str] = []
            params: list[Any] = []
            if payload.active is not None:
                updates.append("active = ?")
                params.append(1 if payload.active else 0)
            if payload.role is not None:
                if payload.role == "master":
                    raise PermissionError("Master cannot be granted through membership")
                updates.append("role = ?")
                params.append(payload.role)
            updates.append("updated_at = ?")
            params.append(utc_now_iso())
            params.append(membership_id)
            conn.execute(f"UPDATE memberships SET {', '.join(updates)} WHERE membership_id = ?", tuple(params))
            conn.commit()
            next_row = conn.execute("SELECT * FROM memberships WHERE membership_id = ?", (membership_id,)).fetchone()
            assert next_row is not None
            membership = self._membership_from_row(next_row)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="membership.updated", target_type="membership", target_id=membership.membershipId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return membership

    def upsert_hub_assignment(self, hub_id: str, *, org_id: str, site_id: str) -> HubAssignmentRecord:
        with self._connect() as conn:
            if conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (org_id,)).fetchone() is None:
                raise KeyError(org_id)
            if conn.execute("SELECT 1 FROM sites WHERE site_id = ?", (site_id,)).fetchone() is None:
                raise KeyError(site_id)
            if conn.execute("SELECT 1 FROM hubs WHERE hub_id = ?", (hub_id,)).fetchone() is None:
                raise KeyError(hub_id)
            now = utc_now_iso()
            conn.execute("INSERT OR REPLACE INTO hub_assignments(hub_id, org_id, site_id, assigned_at) VALUES(?, ?, ?, ?)", (hub_id, org_id, site_id, now))
            conn.commit()
            row = conn.execute("SELECT * FROM hub_assignments WHERE hub_id = ?", (hub_id,)).fetchone()
            assert row is not None
            return self._hub_assignment_from_row(row)

    def create_hub_assignment_for_actor(self, actor: AuthenticatedPrincipal, payload: HubAssignmentCreateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> HubAssignmentRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can assign hubs")
        assignment = self.upsert_hub_assignment(payload.hubId, org_id=payload.orgId, site_id=payload.siteId)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="hub.assignment.updated", target_type="hub", target_id=payload.hubId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return assignment

    def update_hub_assignment_for_actor(self, actor: AuthenticatedPrincipal, hub_id: str, payload: HubAssignmentUpdateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> HubAssignmentRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can assign hubs")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM hub_assignments WHERE hub_id = ?", (hub_id,)).fetchone()
            if row is None:
                raise KeyError(hub_id)
            org_id = payload.orgId or str(row["org_id"])
            site_id = payload.siteId or str(row["site_id"])
        assignment = self.upsert_hub_assignment(hub_id, org_id=org_id, site_id=site_id)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="hub.assignment.updated", target_type="hub", target_id=hub_id, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return assignment

    def list_policies(self, *, principal_id: str | None = None, scope_type: str | None = None, scope_id: str | None = None, capability: str | None = None) -> list[PolicyBindingRecord]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM policy_bindings ORDER BY created_at DESC").fetchall()
        items = [self._policy_from_row(row) for row in rows]
        if principal_id:
            items = [item for item in items if item.principalId == principal_id]
        if scope_type:
            items = [item for item in items if item.scopeType == scope_type]
        if scope_id:
            items = [item for item in items if item.scopeId == scope_id]
        if capability:
            items = [item for item in items if item.capability == capability]
        return items

    def create_policy_for_actor(self, actor: AuthenticatedPrincipal, payload: PolicyCreateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> PolicyBindingRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can manage policies")
        if payload.capability == "master":
            raise PermissionError("Master is not a policy capability")
        with self._connect() as conn:
            if not self._scope_exists(conn, payload.scopeType, payload.scopeId):
                raise ValueError("Policy scope not found")
            policy_id = f"pol-{uuid4().hex[:12]}"
            now = utc_now_iso()
            conn.execute(
                "INSERT INTO policy_bindings(policy_id, principal_type, principal_id, scope_type, scope_id, capability, effect, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (policy_id, payload.principalType, payload.principalId, payload.scopeType, payload.scopeId, payload.capability, payload.effect, now, now),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM policy_bindings WHERE policy_id = ?", (policy_id,)).fetchone()
            assert row is not None
            policy = self._policy_from_row(row)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="policy.created", target_type="policy", target_id=policy.policyId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return policy

    def update_policy_for_actor(self, actor: AuthenticatedPrincipal, policy_id: str, payload: PolicyUpdateRequest, remote_addr: str | None = None, user_agent: str | None = None) -> PolicyBindingRecord:
        if actor.systemRole != "master":
            raise PermissionError("Only master can manage policies")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM policy_bindings WHERE policy_id = ?", (policy_id,)).fetchone()
            if row is None:
                raise KeyError(policy_id)
            updates: list[str] = []
            params: list[Any] = []
            if payload.capability is not None:
                updates.append("capability = ?")
                params.append(payload.capability)
            if payload.effect is not None:
                updates.append("effect = ?")
                params.append(payload.effect)
            if payload.scopeType is not None:
                updates.append("scope_type = ?")
                params.append(payload.scopeType)
            if payload.scopeId is not None:
                updates.append("scope_id = ?")
                params.append(payload.scopeId)
            updates.append("updated_at = ?")
            params.append(utc_now_iso())
            params.append(policy_id)
            conn.execute(f"UPDATE policy_bindings SET {', '.join(updates)} WHERE policy_id = ?", tuple(params))
            conn.commit()
            next_row = conn.execute("SELECT * FROM policy_bindings WHERE policy_id = ?", (policy_id,)).fetchone()
            assert next_row is not None
            policy = self._policy_from_row(next_row)
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="policy.updated", target_type="policy", target_id=policy.policyId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return policy

    def delete_policy_for_actor(self, actor: AuthenticatedPrincipal, policy_id: str, remote_addr: str | None = None, user_agent: str | None = None) -> None:
        if actor.systemRole != "master":
            raise PermissionError("Only master can manage policies")
        with self._connect() as conn:
            if conn.execute("SELECT 1 FROM policy_bindings WHERE policy_id = ?", (policy_id,)).fetchone() is None:
                raise KeyError(policy_id)
            conn.execute("DELETE FROM policy_bindings WHERE policy_id = ?", (policy_id,))
            conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="policy.deleted", target_type="policy", target_id=policy_id, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)

    def get_security_status(self, principal: AuthenticatedPrincipal) -> SecurityStatusResponse:
        with self._connect() as conn:
            mfa_enabled = self._mfa_enabled(conn, principal.accountId)
            remaining = conn.execute("SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE account_id = ? AND used_at IS NULL", (principal.accountId,)).fetchone()
            return SecurityStatusResponse(
                mfaEnabled=mfa_enabled,
                factorTypes=["totp"] if mfa_enabled else [],
                recoveryCodesRemaining=int(remaining["count"]) if remaining else 0,
                lastMfaVerifiedAt=self._session_mfa_verified_at(conn, principal.sessionId),
            )

    def start_mfa_enrollment(self, principal: AuthenticatedPrincipal) -> MfaEnrollmentStartResponse:
        if principal.systemRole != "master":
            raise PermissionError("Only master sessions can enroll MFA")
        secret = generate_totp_secret()
        label = principal.email
        uri = provisioning_uri(secret=secret, label=label, issuer=settings.auth_totp_issuer)
        challenge_id = f"mfaen-{uuid4().hex[:12]}"
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO login_challenges(challenge_id, account_id, purpose, factor_type, secret_ciphertext, expires_at, created_at, used_at, attempts) VALUES(?, ?, 'mfa_enroll', 'totp', ?, ?, ?, NULL, 0)",
                (challenge_id, principal.accountId, encrypt_sensitive_value(secret), utc_now_plus(settings.auth_mfa_challenge_ttl_seconds), utc_now_iso()),
            )
            conn.commit()
        return MfaEnrollmentStartResponse(secretProvisioningUri=uri, secretLabel=label, qrSvg=render_otpauth_svg(label=label, secret=secret, uri=uri), challengeId=challenge_id)

    def _replace_recovery_codes(self, conn: sqlite3.Connection, account_id: str) -> list[str]:
        conn.execute("DELETE FROM mfa_recovery_codes WHERE account_id = ?", (account_id,))
        codes = generate_recovery_codes()
        now = utc_now_iso()
        for code in codes:
            conn.execute(
                "INSERT INTO mfa_recovery_codes(code_id, account_id, code_hash, used_at, created_at) VALUES(?, ?, ?, NULL, ?)",
                (f"rc-{uuid4().hex[:12]}", account_id, hash_recovery_code(code), now),
            )
        return codes

    def complete_mfa_enrollment(self, principal: AuthenticatedPrincipal, payload: MfaEnrollmentCompleteRequest, remote_addr: str | None = None, user_agent: str | None = None) -> RecoveryCodesRotateResponse:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM login_challenges WHERE challenge_id = ?", (payload.challengeId,)).fetchone()
                if row is None or str(row["account_id"]) != principal.accountId or str(row["purpose"]) != "mfa_enroll":
                    raise ValueError("MFA enrollment challenge not found")
                if row["used_at"]:
                    raise ValueError("MFA enrollment challenge already used")
                if self._is_expired(str(row["expires_at"])):
                    raise ValueError("MFA enrollment challenge expired")
                secret = decrypt_sensitive_value(str(row["secret_ciphertext"] or ""))
                if not verify_totp(secret, payload.code):
                    raise ValueError("Invalid MFA enrollment code")
                now = utc_now_iso()
                factor_row = conn.execute("SELECT factor_id FROM mfa_factors WHERE account_id = ? AND type = 'totp' LIMIT 1", (principal.accountId,)).fetchone()
                if factor_row is None:
                    conn.execute(
                        "INSERT INTO mfa_factors(factor_id, account_id, type, secret_ciphertext, enabled, created_at, updated_at) VALUES(?, ?, 'totp', ?, 1, ?, ?)",
                        (f"factor-{uuid4().hex[:12]}", principal.accountId, encrypt_sensitive_value(secret), now, now),
                    )
                else:
                    conn.execute(
                        "UPDATE mfa_factors SET secret_ciphertext = ?, enabled = 1, updated_at = ? WHERE factor_id = ?",
                        (encrypt_sensitive_value(secret), now, str(factor_row["factor_id"])),
                    )
                conn.execute("UPDATE accounts SET mfa_required = 1, updated_at = ? WHERE account_id = ?", (now, principal.accountId))
                conn.execute("UPDATE login_challenges SET used_at = ? WHERE challenge_id = ?", (now, payload.challengeId))
                codes = self._replace_recovery_codes(conn, principal.accountId)
                conn.commit()
        self.audit_event(actor_account_id=principal.accountId, actor_role=principal.systemRole, event_type="auth.mfa.enroll.completed", target_type="account", target_id=principal.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return RecoveryCodesRotateResponse(recoveryCodes=codes, security=self.get_security_status(principal))

    def rotate_recovery_codes(self, principal: AuthenticatedPrincipal, remote_addr: str | None = None, user_agent: str | None = None) -> RecoveryCodesRotateResponse:
        with self._connect() as conn:
            codes = self._replace_recovery_codes(conn, principal.accountId)
            conn.commit()
        self.audit_event(actor_account_id=principal.accountId, actor_role=principal.systemRole, event_type="auth.mfa.recovery_codes.rotated", target_type="account", target_id=principal.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return RecoveryCodesRotateResponse(recoveryCodes=codes, security=self.get_security_status(principal))

    def _require_primary_master(self, actor: AuthenticatedPrincipal) -> None:
        if not actor.isPrimaryMaster:
            raise PermissionError("Primary master access required")
        if actor.mfaRequired and not actor.mfaSatisfied:
            raise PermissionError("MFA verification required")
    def transfer_master(self, actor: AuthenticatedPrincipal, payload: MasterTransferRequest, remote_addr: str | None, user_agent: str | None) -> MasterStateRecord:
        self._require_primary_master(actor)
        with self._lock:
            with self._connect() as conn:
                state_row = self._master_state_row(conn)
                if state_row is None or not state_row["primary_account_id"]:
                    raise ValueError("Primary master is not configured")
                if state_row["backup_account_id"] == payload.targetAccountId:
                    raise ValueError("Cannot transfer primary master to the backup identity")
                if conn.execute("SELECT 1 FROM accounts WHERE account_id = ?", (payload.targetAccountId,)).fetchone() is None:
                    raise KeyError(payload.targetAccountId)
                previous_primary = str(state_row["primary_account_id"])
                now = utc_now_iso()
                conn.execute("UPDATE accounts SET system_role = 'user', mfa_required = 0, updated_at = ? WHERE account_id = ?", (now, previous_primary))
                conn.execute("UPDATE accounts SET system_role = 'master', active = 1, recovery_only = 0, mfa_required = 1, updated_at = ? WHERE account_id = ?", (now, payload.targetAccountId))
                conn.execute("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?", (now, previous_primary))
                conn.execute("UPDATE master_state SET primary_account_id = ?, updated_at = ? WHERE singleton_key = 'master'", (payload.targetAccountId, now))
                conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="master.transfer", target_type="account", target_id=payload.targetAccountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return self.get_master_state()

    def activate_backup(self, actor: AuthenticatedPrincipal, remote_addr: str | None, user_agent: str | None) -> MasterStateRecord:
        self._require_primary_master(actor)
        state = self.get_master_state()
        if not state.backupAccountId:
            raise ValueError("Backup master identity is not configured")
        with self._connect() as conn:
            now = utc_now_iso()
            conn.execute("UPDATE accounts SET active = 1, updated_at = ? WHERE account_id = ?", (now, state.backupAccountId))
            conn.execute("UPDATE master_state SET backup_active = 1, updated_at = ? WHERE singleton_key = 'master'", (now,))
            conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="master.activate_backup", target_type="account", target_id=state.backupAccountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return self.get_master_state()

    def deactivate_backup(self, actor: AuthenticatedPrincipal, remote_addr: str | None, user_agent: str | None) -> MasterStateRecord:
        self._require_primary_master(actor)
        state = self.get_master_state()
        if not state.backupAccountId:
            raise ValueError("Backup master identity is not configured")
        with self._connect() as conn:
            now = utc_now_iso()
            conn.execute("UPDATE accounts SET active = 0, updated_at = ? WHERE account_id = ?", (now, state.backupAccountId))
            conn.execute("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?", (now, state.backupAccountId))
            conn.execute("UPDATE master_state SET backup_active = 0, updated_at = ? WHERE singleton_key = 'master'", (now,))
            conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="master.deactivate_backup", target_type="account", target_id=state.backupAccountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return self.get_master_state()

    def rotate_recovery_public_key(self, actor: AuthenticatedPrincipal, payload: RotateRecoveryKeyRequest, remote_addr: str | None, user_agent: str | None) -> RecoveryStatusResponse:
        self._require_primary_master(actor)
        key_path = Path(settings.fleet_recovery_public_key_path)
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_text(payload.publicKey.strip(), encoding="utf-8")
        fingerprint = recovery_public_key_fingerprint(str(key_path))
        with self._connect() as conn:
            now = utc_now_iso()
            conn.execute("UPDATE recovery_keys SET status = 'rotated', rotated_at = ? WHERE status = 'active'", (now,))
            conn.execute(
                "INSERT INTO recovery_keys(key_id, public_key, fingerprint, status, created_at, rotated_at) VALUES(?, ?, ?, 'active', ?, NULL)",
                (f"rec-{uuid4().hex[:12]}", payload.publicKey.strip(), fingerprint or "", now),
            )
            conn.commit()
        self.audit_event(actor_account_id=actor.accountId, actor_role=actor.systemRole, event_type="recovery.public_key.rotated", target_type="recovery_key", target_id=fingerprint, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return self.get_recovery_status()

    def issue_recovery_challenge(self, remote_addr: str | None, user_agent: str | None) -> RecoveryChallengeResponse:
        fingerprint = recovery_public_key_fingerprint()
        if not fingerprint:
            raise ValueError("Recovery public key is not installed")
        challenge_id = f"rch-{uuid4().hex[:12]}"
        challenge = uuid4().hex + uuid4().hex
        expires_at = utc_now_plus(settings.fleet_recovery_challenge_ttl_seconds)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO recovery_challenges(challenge_id, challenge, expires_at, created_at, used_at) VALUES(?, ?, ?, ?, NULL)",
                (challenge_id, challenge, expires_at, utc_now_iso()),
            )
            conn.commit()
        self.audit_event(event_type="recovery.challenge", outcome="succeeded", target_type="recovery_challenge", target_id=challenge_id, remote_addr=remote_addr, user_agent=user_agent)
        return RecoveryChallengeResponse(challengeId=challenge_id, challenge=challenge, expiresAt=expires_at, fingerprint=fingerprint)

    def complete_recovery(self, payload: RecoveryCompleteRequest, remote_addr: str | None, user_agent: str | None) -> LocalAuthResponse:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM recovery_challenges WHERE challenge_id = ?", (payload.challengeId,)).fetchone()
                if row is None:
                    raise ValueError("Recovery challenge not found")
                if row["used_at"]:
                    raise ValueError("Recovery challenge already used")
                if self._is_expired(str(row["expires_at"])):
                    raise ValueError("Recovery challenge expired")
                if not verify_recovery_signature(str(row["challenge"]).encode("utf-8"), payload.signature):
                    self.audit_event(event_type="recovery.complete", outcome="failed", remote_addr=remote_addr, user_agent=user_agent, metadata={"reason": "invalid signature"})
                    raise ValueError("Invalid recovery signature")
                state = self.get_master_state()
                if not state.backupAccountId:
                    raise ValueError("Backup master identity is not configured")
                now = utc_now_iso()
                if state.primaryAccountId:
                    conn.execute("UPDATE accounts SET active = 0, updated_at = ? WHERE account_id = ?", (now, state.primaryAccountId))
                    conn.execute("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?", (now, state.primaryAccountId))
                conn.execute("UPDATE accounts SET active = 1, mfa_required = 1, updated_at = ? WHERE account_id = ?", (now, state.backupAccountId))
                conn.execute("UPDATE master_state SET backup_active = 1, updated_at = ? WHERE singleton_key = 'master'", (now,))
                conn.execute("UPDATE recovery_challenges SET used_at = ? WHERE challenge_id = ?", (now, payload.challengeId))
                account = self.get_account(state.backupAccountId, conn=conn)
                session = self._create_session(conn, account, remote_addr=remote_addr, user_agent=user_agent, recovery_session=True, mfa_satisfied=False)
                conn.commit()
        self.audit_event(actor_account_id=account.accountId, actor_role="master", event_type="recovery.complete", target_type="account", target_id=account.accountId, outcome="succeeded", remote_addr=remote_addr, user_agent=user_agent)
        return LocalAuthResponse(access_token=session["token"], expires_in=session["expiresIn"], account=account, effectiveAccess=session["effective"])

    def get_recovery_status(self) -> RecoveryStatusResponse:
        state = self.get_master_state()
        fingerprint = recovery_public_key_fingerprint()
        return RecoveryStatusResponse(
            fingerprint=fingerprint,
            publicKeyInstalled=bool(fingerprint),
            backupActive=state.backupActive,
            backupAccountId=state.backupAccountId,
        )

    def list_audit(self, limit: int = 100) -> list[AuditEventRecord]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)).fetchall()
            return [self._audit_from_row(row) for row in rows]


iam_store = IamStore(settings.fleet_database_path)
