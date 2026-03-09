from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse

from api.v1.dependencies import (
    get_current_principal,
    request_remote_addr,
    request_user_agent,
    require_localhost,
    require_master,
    require_primary_master,
)
from auth.jwt import get_jwks
from config import settings
from models import (
    AccountCreateRequest,
    AccountListResponse,
    AccountUpdateRequest,
    AuditListResponse,
    AuthenticatedPrincipal,
    BootstrapCompleteRequest,
    BootstrapCompleteResponse,
    BootstrapStartRequest,
    BootstrapStartResponse,
    BootstrapStatusResponse,
    EnrollRequest,
    EnrollResponse,
    HubAssignmentCreateRequest,
    HubAssignmentResponse,
    HubAssignmentUpdateRequest,
    HubCheckInRequest,
    HubCheckInResponse,
    HubListResponse,
    HubUpdateRequest,
    JwksResponse,
    LocalAuthRequest,
    LocalAuthResponse,
    MasterStateRecord,
    MasterTransferRequest,
    MembershipCreateRequest,
    MembershipResponse,
    MembershipUpdateRequest,
    MfaEnrollmentCompleteRequest,
    MfaEnrollmentStartResponse,
    MfaVerifyRequest,
    OrganizationCreateRequest,
    OrganizationListResponse,
    OrganizationUpdateRequest,
    PauseResponse,
    PolicyCreateRequest,
    PolicyListResponse,
    PolicyUpdateRequest,
    RecoveryChallengeResponse,
    RecoveryCodesRotateResponse,
    RecoveryCompleteRequest,
    RecoveryStatusResponse,
    ReleaseListResponse,
    ReleaseRecord,
    ReleaseRegistrationResponse,
    ReleaseUploadMetadata,
    RollbackResponse,
    RolloutListResponse,
    RolloutRecord,
    RolloutRequest,
    RotateRecoveryKeyRequest,
    SecurityStatusResponse,
    SiteCreateRequest,
    SiteListResponse,
    SiteUpdateRequest,
)
from security import sha256_hexdigest, utc_now_iso, verify_agent_signature, verify_release_signature
from services.fleet_store import fleet_store
from services.iam_store import iam_store

router = APIRouter(prefix="/api/v1", tags=["fleet"])


def _artifact_root(release_id: str) -> Path:
    root = Path(settings.fleet_artifact_dir) / release_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def _timestamp_fresh(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age = abs((datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds())
    return age <= settings.fleet_signature_ttl_seconds


def _master_only(principal: AuthenticatedPrincipal, request: Request) -> None:
    if principal.systemRole != "master":
        iam_store.audit_event(
            actor_account_id=principal.accountId,
            actor_role=principal.systemRole,
            event_type="authz.master_required",
            outcome="denied",
            remote_addr=request_remote_addr(request),
            user_agent=request_user_agent(request),
        )
        raise HTTPException(status_code=403, detail="Master access required")
    if principal.mfaRequired and not principal.mfaSatisfied:
        raise HTTPException(status_code=403, detail="MFA verification required")


@router.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "version": settings.app_version}


@router.get("/info")
async def info() -> dict[str, object]:
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "pollIntervalSeconds": settings.fleet_poll_interval_seconds,
    }


@router.get("/.well-known/jwks.json", response_model=JwksResponse, include_in_schema=False)
async def jwks() -> JwksResponse:
    return get_jwks()


@router.get("/bootstrap/status", response_model=BootstrapStatusResponse, dependencies=[Depends(require_localhost)])
async def bootstrap_status() -> BootstrapStatusResponse:
    return iam_store.get_bootstrap_status()


@router.post("/bootstrap/master/start", response_model=BootstrapStartResponse, dependencies=[Depends(require_localhost)])
async def bootstrap_start(request: Request, payload: BootstrapStartRequest) -> BootstrapStartResponse:
    try:
        return iam_store.start_bootstrap(payload.bootstrapToken, request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/bootstrap/master/complete", response_model=BootstrapCompleteResponse, dependencies=[Depends(require_localhost)])
async def bootstrap_complete(request: Request, payload: BootstrapCompleteRequest) -> BootstrapCompleteResponse:
    try:
        return iam_store.complete_bootstrap(payload, request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/auth/local", response_model=LocalAuthResponse)
async def auth_local(request: Request, payload: LocalAuthRequest) -> LocalAuthResponse:
    try:
        return iam_store.authenticate_local(payload, request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@router.post("/auth/mfa/verify", response_model=LocalAuthResponse)
async def auth_mfa_verify(request: Request, payload: MfaVerifyRequest) -> LocalAuthResponse:
    try:
        return iam_store.verify_mfa(payload, request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@router.post("/auth/logout")
async def auth_logout(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)]) -> dict[str, bool]:
    iam_store.revoke_session(principal)
    return {"revoked": True}


@router.get("/me/effective-access")
async def me_effective_access(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)]):
    return iam_store.get_effective_access(principal.accountId, session_id=principal.sessionId)


@router.get("/me/security", response_model=SecurityStatusResponse)
async def me_security(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)]) -> SecurityStatusResponse:
    return iam_store.get_security_status(principal)


@router.post("/auth/mfa/enroll/start", response_model=MfaEnrollmentStartResponse)
async def mfa_enroll_start(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)]) -> MfaEnrollmentStartResponse:
    try:
        return iam_store.start_mfa_enrollment(principal)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.post("/auth/mfa/enroll/complete", response_model=RecoveryCodesRotateResponse)
async def mfa_enroll_complete(
    request: Request,
    principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)],
    payload: MfaEnrollmentCompleteRequest,
) -> RecoveryCodesRotateResponse:
    try:
        return iam_store.complete_mfa_enrollment(principal, payload, request_remote_addr(request), request_user_agent(request))
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.post("/auth/mfa/recovery-codes/rotate", response_model=RecoveryCodesRotateResponse)
async def mfa_rotate_codes(
    request: Request,
    principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)],
) -> RecoveryCodesRotateResponse:
    try:
        return iam_store.rotate_recovery_codes(principal, request_remote_addr(request), request_user_agent(request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("/system/master-state", response_model=MasterStateRecord)
async def system_master_state(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request) -> MasterStateRecord:
    _master_only(principal, request)
    return iam_store.get_master_state()


@router.get("/system/recovery-status", response_model=RecoveryStatusResponse)
async def system_recovery_status(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request) -> RecoveryStatusResponse:
    _master_only(principal, request)
    return iam_store.get_recovery_status()


@router.post("/masters/transfer", response_model=MasterStateRecord)
async def masters_transfer(request: Request, payload: MasterTransferRequest, principal: Annotated[AuthenticatedPrincipal, Depends(require_primary_master)]) -> MasterStateRecord:
    try:
        return iam_store.transfer_master(principal, payload, request_remote_addr(request), request_user_agent(request))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=422 if isinstance(exc, ValueError) else 403, detail=str(exc)) from exc


@router.post("/masters/activate-backup", response_model=MasterStateRecord)
async def masters_activate_backup(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_primary_master)]) -> MasterStateRecord:
    try:
        return iam_store.activate_backup(principal, request_remote_addr(request), request_user_agent(request))
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=422 if isinstance(exc, ValueError) else 403, detail=str(exc)) from exc


@router.post("/masters/deactivate-backup", response_model=MasterStateRecord)
async def masters_deactivate_backup(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_primary_master)]) -> MasterStateRecord:
    try:
        return iam_store.deactivate_backup(principal, request_remote_addr(request), request_user_agent(request))
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=422 if isinstance(exc, ValueError) else 403, detail=str(exc)) from exc


@router.post("/masters/recovery-public-key/rotate", response_model=RecoveryStatusResponse)
async def masters_rotate_recovery_key(request: Request, payload: RotateRecoveryKeyRequest, principal: Annotated[AuthenticatedPrincipal, Depends(require_primary_master)]) -> RecoveryStatusResponse:
    try:
        return iam_store.rotate_recovery_public_key(principal, payload, request_remote_addr(request), request_user_agent(request))
    except (ValueError, PermissionError) as exc:
        raise HTTPException(status_code=422 if isinstance(exc, ValueError) else 403, detail=str(exc)) from exc


@router.post("/recovery/challenge", response_model=RecoveryChallengeResponse, dependencies=[Depends(require_localhost)])
async def recovery_challenge(request: Request) -> RecoveryChallengeResponse:
    try:
        return iam_store.issue_recovery_challenge(request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/recovery/complete", response_model=LocalAuthResponse, dependencies=[Depends(require_localhost)])
async def recovery_complete(request: Request, payload: RecoveryCompleteRequest) -> LocalAuthResponse:
    try:
        return iam_store.complete_recovery(payload, request_remote_addr(request), request_user_agent(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/audit", response_model=AuditListResponse)
async def audit_list(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request, limit: int = Query(default=100, ge=1, le=500)) -> AuditListResponse:
    _master_only(principal, request)
    return AuditListResponse(events=iam_store.list_audit(limit))


@router.get("/accounts", response_model=AccountListResponse)
async def list_accounts(
    principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)],
    request: Request,
    q: str | None = Query(default=None),
    role: str | None = Query(default=None),
    orgId: str | None = Query(default=None),
    siteId: str | None = Query(default=None),
    active: bool | None = Query(default=None),
) -> AccountListResponse:
    iam_store.require_capability(principal, "account.view", remote_addr=request_remote_addr(request), user_agent=request_user_agent(request))
    return iam_store.list_accounts(principal, q=q, role=role, org_id=orgId, site_id=siteId, active=active)  # type: ignore[arg-type]


@router.get("/accounts/{account_id}")
async def get_account(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request, account_id: str):
    iam_store.require_capability(principal, "account.view", remote_addr=request_remote_addr(request), user_agent=request_user_agent(request))
    try:
        return iam_store.get_account(account_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc


@router.post("/accounts")
async def create_account(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], payload: AccountCreateRequest):
    iam_store.require_capability(principal, "account.manage", remote_addr=request_remote_addr(request), user_agent=request_user_agent(request))
    try:
        return iam_store.create_account_for_actor(principal, payload, request_remote_addr(request), request_user_agent(request))
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.patch("/accounts/{account_id}")
async def patch_account(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], account_id: str, payload: AccountUpdateRequest):
    iam_store.require_capability(principal, "account.manage", remote_addr=request_remote_addr(request), user_agent=request_user_agent(request))
    try:
        return iam_store.update_account_for_actor(principal, account_id, payload, request_remote_addr(request), request_user_agent(request))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.get("/organizations", response_model=OrganizationListResponse)
async def list_organizations(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request) -> OrganizationListResponse:
    _master_only(principal, request)
    return OrganizationListResponse(organizations=iam_store.list_organizations())


@router.post("/organizations")
async def create_organization(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], payload: OrganizationCreateRequest) -> dict[str, object]:
    return iam_store.create_organization(payload).model_dump(mode="json")


@router.patch("/organizations/{org_id}")
async def patch_organization(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], org_id: str, payload: OrganizationUpdateRequest) -> dict[str, object]:
    try:
        return iam_store.update_organization(org_id, payload).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Organization not found") from exc


@router.get("/sites", response_model=SiteListResponse)
async def list_sites(principal: Annotated[AuthenticatedPrincipal, Depends(get_current_principal)], request: Request, orgId: str | None = Query(default=None)) -> SiteListResponse:
    _master_only(principal, request)
    return SiteListResponse(sites=iam_store.list_sites(org_id=orgId))


@router.post("/sites")
async def create_site(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], payload: SiteCreateRequest) -> dict[str, object]:
    try:
        return iam_store.create_site(payload).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Organization not found") from exc


@router.patch("/sites/{site_id}")
async def patch_site(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], site_id: str, payload: SiteUpdateRequest) -> dict[str, object]:
    try:
        return iam_store.update_site(site_id, payload).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Site not found") from exc

@router.post("/memberships", response_model=MembershipResponse)
async def create_membership(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], payload: MembershipCreateRequest) -> MembershipResponse:
    try:
        membership = iam_store.create_membership_for_actor(principal, payload, request_remote_addr(request), request_user_agent(request))
        return MembershipResponse(membership=membership)
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.patch("/memberships/{membership_id}", response_model=MembershipResponse)
async def patch_membership(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], membership_id: str, payload: MembershipUpdateRequest) -> MembershipResponse:
    try:
        membership = iam_store.update_membership_for_actor(principal, membership_id, payload, request_remote_addr(request), request_user_agent(request))
        return MembershipResponse(membership=membership)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Membership not found") from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.post("/hub-assignments", response_model=HubAssignmentResponse)
async def create_hub_assignment(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], payload: HubAssignmentCreateRequest) -> HubAssignmentResponse:
    try:
        assignment = iam_store.create_hub_assignment_for_actor(principal, payload, request_remote_addr(request), request_user_agent(request))
        return HubAssignmentResponse(assignment=assignment)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub or scope not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.patch("/hub-assignments/{hub_id}", response_model=HubAssignmentResponse)
async def patch_hub_assignment(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], hub_id: str, payload: HubAssignmentUpdateRequest) -> HubAssignmentResponse:
    try:
        assignment = iam_store.update_hub_assignment_for_actor(principal, hub_id, payload, request_remote_addr(request), request_user_agent(request))
        return HubAssignmentResponse(assignment=assignment)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub assignment not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("/policies", response_model=PolicyListResponse)
async def list_policies(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], principalId: str | None = Query(default=None), scopeType: str | None = Query(default=None), scopeId: str | None = Query(default=None), capability: str | None = Query(default=None)) -> PolicyListResponse:
    return PolicyListResponse(policies=iam_store.list_policies(principal_id=principalId, scope_type=scopeType, scope_id=scopeId, capability=capability))


@router.post("/policies")
async def create_policy(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], payload: PolicyCreateRequest) -> dict[str, object]:
    try:
        return iam_store.create_policy_for_actor(principal, payload, request_remote_addr(request), request_user_agent(request)).model_dump(mode="json")
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.patch("/policies/{policy_id}")
async def patch_policy(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], policy_id: str, payload: PolicyUpdateRequest) -> dict[str, object]:
    try:
        return iam_store.update_policy_for_actor(principal, policy_id, payload, request_remote_addr(request), request_user_agent(request)).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Policy not found") from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=403 if isinstance(exc, PermissionError) else 422, detail=str(exc)) from exc


@router.delete("/policies/{policy_id}")
async def delete_policy(request: Request, principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], policy_id: str) -> dict[str, bool]:
    try:
        iam_store.delete_policy_for_actor(principal, policy_id, request_remote_addr(request), request_user_agent(request))
        return {"deleted": True}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Policy not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.post("/hubs/enroll", response_model=EnrollResponse)
async def enroll_hub(request: EnrollRequest) -> EnrollResponse:
    try:
        hub = fleet_store.enroll_hub(request)
        iam_store._sync_scope_catalog()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return EnrollResponse(hub=hub, pollIntervalSeconds=settings.fleet_poll_interval_seconds, serverTime=utc_now_iso())


@router.post("/hubs/check-in", response_model=HubCheckInResponse)
async def check_in_hub(
    request: Request,
    payload: HubCheckInRequest,
    x_projectplant_hub_id: Annotated[str | None, Header()] = None,
    x_projectplant_timestamp: Annotated[str | None, Header()] = None,
    x_projectplant_signature: Annotated[str | None, Header()] = None,
) -> HubCheckInResponse:
    if payload.hubId != (x_projectplant_hub_id or ""):
        raise HTTPException(status_code=401, detail="Hub identity header mismatch")
    public_key = fleet_store.get_hub_public_key(payload.hubId)
    if not public_key:
        raise HTTPException(status_code=404, detail="Hub not enrolled")
    if not x_projectplant_timestamp or not x_projectplant_signature:
        raise HTTPException(status_code=401, detail="Missing hub signature headers")
    if not _timestamp_fresh(x_projectplant_timestamp):
        raise HTTPException(status_code=401, detail="Expired hub signature timestamp")
    if not verify_agent_signature(public_key, x_projectplant_timestamp, await request.body(), x_projectplant_signature):
        raise HTTPException(status_code=401, detail="Invalid hub signature")
    try:
        desired = fleet_store.record_check_in(payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub not enrolled") from exc
    return HubCheckInResponse(pollIntervalSeconds=settings.fleet_poll_interval_seconds, serverTime=utc_now_iso(), desiredOperation=desired)


@router.get("/hubs", response_model=HubListResponse)
async def list_hubs(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], site: str | None = Query(default=None), channel: str | None = Query(default=None), q: str | None = Query(default=None)) -> HubListResponse:
    return HubListResponse(hubs=fleet_store.list_hubs(site=site, channel=channel, query=q))


@router.get("/hubs/{hub_id}")
async def get_hub(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], hub_id: str):
    try:
        return fleet_store.get_hub(hub_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub not found") from exc


@router.patch("/hubs/{hub_id}")
async def patch_hub(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], hub_id: str, update: HubUpdateRequest):
    try:
        return fleet_store.update_hub(hub_id, update)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub not found") from exc


@router.post("/hubs/{hub_id}/rollback", response_model=RollbackResponse)
async def rollback_hub(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], hub_id: str) -> RollbackResponse:
    try:
        operation = fleet_store.queue_manual_rollback(hub_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Hub not found") from exc
    return RollbackResponse(operation=operation)


@router.post("/releases", response_model=ReleaseRegistrationResponse)
async def register_release(
    principal: Annotated[AuthenticatedPrincipal, Depends(require_master)],
    metadata: Annotated[str, File(alias="metadata")],
    signature: Annotated[UploadFile, File(alias="signature")],
    artifacts: Annotated[list[UploadFile] | None, File(alias="artifacts")] = None,
) -> ReleaseRegistrationResponse:
    try:
        parsed = ReleaseUploadMetadata.model_validate(json.loads(metadata))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid metadata payload: {exc}") from exc
    manifest = parsed.manifest
    artifact_root = _artifact_root(manifest.releaseId)
    manifest_bytes = json.dumps(manifest.model_dump(mode="json"), indent=2, sort_keys=True).encode("utf-8")
    signature_bytes = await signature.read()
    if not verify_release_signature(manifest_bytes, signature_bytes):
        raise HTTPException(status_code=422, detail="Manifest signature verification failed")
    (artifact_root / "manifest.json").write_bytes(manifest_bytes)
    signature_path = artifact_root / "manifest.sig"
    signature_path.write_bytes(signature_bytes)

    uploaded: dict[str, str] = {}
    for upload in artifacts or []:
        if not upload.filename:
            continue
        data = await upload.read()
        target = artifact_root / upload.filename
        target.write_bytes(data)
        uploaded[upload.filename] = sha256_hexdigest(data)

    missing: list[str] = []
    mismatched: list[str] = []
    for entry in manifest.artifacts:
        target = artifact_root / entry.name
        if entry.name not in uploaded and not target.exists():
            missing.append(entry.name)
            continue
        digest = uploaded.get(entry.name)
        if digest is None:
            digest = sha256_hexdigest(target.read_bytes())
        if digest != entry.sha256:
            mismatched.append(entry.name)
    if missing or mismatched:
        raise HTTPException(status_code=422, detail={"missing": missing, "mismatched": mismatched})

    release, created = fleet_store.register_release(manifest, str(signature_path))
    return ReleaseRegistrationResponse(release=release, created=created)


@router.get("/releases", response_model=ReleaseListResponse)
async def list_releases(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], channel: str | None = Query(default=None)) -> ReleaseListResponse:
    return ReleaseListResponse(releases=fleet_store.list_releases(channel=channel))


@router.get("/releases/{release_id}")
async def get_release(release_id: str, request: Request) -> ReleaseRecord:
    try:
        release = fleet_store.get_release(release_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Release not found") from exc
    base_url = str(request.base_url).rstrip("/")
    manifest = release.manifest.model_copy(update={"artifacts": [entry.model_copy(update={"url": f"{base_url}/api/v1/releases/{release.releaseId}/artifacts/{entry.name}"}) for entry in release.manifest.artifacts]})
    return release.model_copy(update={"manifest": manifest})


@router.get("/releases/{release_id}/manifest")
async def get_release_manifest(release_id: str) -> Response:
    manifest_path = _artifact_root(release_id) / "manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return Response(content=manifest_path.read_bytes(), media_type="application/json")


@router.get("/releases/{release_id}/manifest.sig")
async def get_release_signature(release_id: str) -> Response:
    signature_path = _artifact_root(release_id) / "manifest.sig"
    if not signature_path.exists():
        raise HTTPException(status_code=404, detail="Manifest signature not found")
    return Response(content=signature_path.read_bytes(), media_type="application/octet-stream")


@router.get("/releases/{release_id}/artifacts/{artifact_name}")
async def get_release_artifact(release_id: str, artifact_name: str) -> FileResponse:
    artifact = _artifact_root(release_id) / artifact_name
    if not artifact.exists():
        raise HTTPException(status_code=404, detail="Artifact not found")
    return FileResponse(path=artifact)


@router.post("/rollouts")
async def create_rollout(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], request: RolloutRequest) -> RolloutRecord:
    try:
        return fleet_store.create_rollout(request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Release not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/rollouts", response_model=RolloutListResponse)
async def list_rollouts(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)]) -> RolloutListResponse:
    return RolloutListResponse(rollouts=fleet_store.list_rollouts())


@router.get("/rollouts/{rollout_id}")
async def get_rollout(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], rollout_id: str) -> RolloutRecord:
    try:
        return fleet_store.get_rollout(rollout_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Rollout not found") from exc


@router.post("/rollouts/{rollout_id}/pause", response_model=PauseResponse)
async def pause_rollout(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], rollout_id: str) -> PauseResponse:
    try:
        rollout = fleet_store.pause_rollout(rollout_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Rollout not found") from exc
    return PauseResponse(rollout=rollout)


@router.post("/rollouts/{rollout_id}/resume", response_model=PauseResponse)
async def resume_rollout(principal: Annotated[AuthenticatedPrincipal, Depends(require_master)], rollout_id: str) -> PauseResponse:
    try:
        rollout = fleet_store.resume_rollout(rollout_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Rollout not found") from exc
    return PauseResponse(rollout=rollout)
