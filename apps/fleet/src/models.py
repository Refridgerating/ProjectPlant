from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


Channel = Literal["dev", "beta", "stable"]
DesiredOperationType = Literal["install_release", "rollback_release", "refresh_inventory"]
OperationStatus = Literal["pending", "in_progress", "succeeded", "failed", "rolled_back", "paused", "waiting"]
RolloutStatus = Literal["active", "paused", "completed", "failed"]
SystemRole = Literal["master", "administrator", "user"]
AuditOutcome = Literal["succeeded", "failed", "denied"]
ScopeType = Literal["organization", "site", "hub"]
PolicyEffect = Literal["allow", "deny"]
ChallengePurpose = Literal["login", "mfa_enroll"]


class ArtifactEntry(BaseModel):
    name: str
    sha256: str
    url: str | None = None


class ReleaseManifest(BaseModel):
    releaseId: str
    channel: Channel
    hubVersion: str
    uiVersion: str
    agentMinVersion: str
    artifacts: list[ArtifactEntry]
    managedServices: list[str]
    healthChecks: list[str]
    rollbackWindowSeconds: int = Field(default=180, ge=30)


class DesiredOperation(BaseModel):
    operationId: str
    type: DesiredOperationType
    releaseId: str | None = None
    rolloutId: str | None = None
    manifest: ReleaseManifest | None = None
    manifestUrl: str | None = None
    signatureUrl: str | None = None
    artifacts: list[ArtifactEntry] = Field(default_factory=list)
    createdAt: str


class HubOperationResult(BaseModel):
    operationId: str
    status: Literal["succeeded", "failed", "rolled_back"]
    releaseId: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class HubInventory(BaseModel):
    hostname: str
    advertisedName: str | None = None
    site: str | None = None
    channel: Channel = "dev"
    localIpAddresses: list[str] = Field(default_factory=list)
    agentVersion: str
    hubVersion: str | None = None
    uiVersion: str | None = None
    managedServices: list[str] = Field(default_factory=list)
    diskFreeBytes: int | None = None
    uptimeSeconds: int | None = None
    lastBootAt: str | None = None
    mosquittoEnabled: bool = False
    mqttBrokerMode: Literal["local", "external"] = "external"


class HubCheckInRequest(BaseModel):
    hubId: str
    inventory: HubInventory
    operationResult: HubOperationResult | None = None


class HubCheckInResponse(BaseModel):
    pollIntervalSeconds: int
    serverTime: str
    desiredOperation: DesiredOperation | None = None


class HubRecord(BaseModel):
    hubId: str
    hostname: str
    advertisedName: str | None = None
    site: str | None = None
    channel: Channel = "dev"
    localIpAddresses: list[str] = Field(default_factory=list)
    agentVersion: str
    hubVersion: str | None = None
    uiVersion: str | None = None
    managedServices: list[str] = Field(default_factory=list)
    diskFreeBytes: int | None = None
    uptimeSeconds: int | None = None
    lastBootAt: str | None = None
    mosquittoEnabled: bool = False
    mqttBrokerMode: Literal["local", "external"] = "external"
    tags: list[str] = Field(default_factory=list)
    maintenanceMode: bool = False
    enrolledAt: str
    lastCheckInAt: str | None = None
    currentReleaseId: str | None = None
    lastKnownGoodReleaseId: str | None = None
    publicKey: str | None = None
    organizationId: str | None = None
    siteId: str | None = None


class EnrollRequest(BaseModel):
    bootstrapToken: str
    hubId: str
    publicKey: str
    inventory: HubInventory


class EnrollResponse(BaseModel):
    hub: HubRecord
    pollIntervalSeconds: int
    serverTime: str


class HubUpdateRequest(BaseModel):
    advertisedName: str | None = None
    site: str | None = None
    channel: Channel | None = None
    tags: list[str] | None = None
    maintenanceMode: bool | None = None


class HubListResponse(BaseModel):
    hubs: list[HubRecord]


class HubOperationRecord(BaseModel):
    operationId: str
    hubId: str
    type: DesiredOperationType
    status: OperationStatus
    releaseId: str | None = None
    rolloutId: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
    createdAt: str
    updatedAt: str


class ReleaseRecord(BaseModel):
    releaseId: str
    channel: Channel
    hubVersion: str
    uiVersion: str
    agentMinVersion: str
    manifest: ReleaseManifest
    createdAt: str
    status: str


class ReleaseListResponse(BaseModel):
    releases: list[ReleaseRecord]


class ReleaseRegistrationResponse(BaseModel):
    release: ReleaseRecord
    created: bool


class RolloutTargetSelector(BaseModel):
    hubIds: list[str] | None = None
    site: str | None = None
    channel: Channel | None = None


class RolloutRequest(BaseModel):
    releaseId: str
    selector: RolloutTargetSelector


class RolloutHubStatus(BaseModel):
    hubId: str
    batchNumber: int
    status: str
    operationId: str | None = None


class RolloutRecord(BaseModel):
    rolloutId: str
    releaseId: str
    status: RolloutStatus
    createdAt: str
    updatedAt: str
    selector: dict[str, Any]
    targets: list[RolloutHubStatus]


class RolloutListResponse(BaseModel):
    rollouts: list[RolloutRecord]


class PauseResponse(BaseModel):
    rollout: RolloutRecord


class RollbackResponse(BaseModel):
    operation: HubOperationRecord


class ReleaseUploadMetadata(BaseModel):
    manifest: ReleaseManifest

    model_config = ConfigDict(extra="forbid")


class MembershipRecord(BaseModel):
    membershipId: str
    accountId: str
    scopeType: ScopeType
    scopeId: str
    role: SystemRole
    active: bool
    createdAt: str
    updatedAt: str


class HubAssignmentRecord(BaseModel):
    hubId: str
    orgId: str
    siteId: str
    assignedAt: str


class PolicyBindingRecord(BaseModel):
    policyId: str
    principalType: Literal["account", "role"]
    principalId: str
    scopeType: ScopeType
    scopeId: str
    capability: str
    effect: PolicyEffect
    createdAt: str
    updatedAt: str


class AccountRecord(BaseModel):
    accountId: str
    email: str
    displayName: str
    systemRole: SystemRole
    active: bool
    recoveryOnly: bool
    mustChangePassword: bool = False
    mfaEnabled: bool = False
    mfaRequired: bool = False
    lastLoginAt: str | None = None
    memberships: list[MembershipRecord] = Field(default_factory=list)
    createdAt: str
    updatedAt: str


class AccountSummary(BaseModel):
    accountId: str
    email: str
    displayName: str
    systemRole: SystemRole
    active: bool
    mustChangePassword: bool = False
    mfaEnabled: bool = False
    lastLoginAt: str | None = None
    memberships: list[MembershipRecord] = Field(default_factory=list)


class AccountListResponse(BaseModel):
    accounts: list[AccountSummary]


class AccountCreateRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    displayName: str | None = Field(default=None, max_length=120)
    systemRole: SystemRole = "user"
    temporaryPassword: str = Field(..., min_length=12, max_length=256)
    mustChangePassword: bool = True
    memberships: list["MembershipCreateRequest"] = Field(default_factory=list)


class AccountUpdateRequest(BaseModel):
    displayName: str | None = Field(default=None, max_length=120)
    active: bool | None = None
    mustChangePassword: bool | None = None
    systemRole: SystemRole | None = None


class OrganizationRecord(BaseModel):
    orgId: str
    name: str
    slug: str
    active: bool
    createdAt: str
    updatedAt: str


class OrganizationListResponse(BaseModel):
    organizations: list[OrganizationRecord]


class OrganizationCreateRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    slug: str = Field(..., min_length=2, max_length=80)


class OrganizationUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    slug: str | None = Field(default=None, min_length=2, max_length=80)
    active: bool | None = None


class SiteRecord(BaseModel):
    siteId: str
    orgId: str
    name: str
    slug: str
    networkLabel: str | None = None
    active: bool
    createdAt: str
    updatedAt: str


class SiteListResponse(BaseModel):
    sites: list[SiteRecord]


class SiteCreateRequest(BaseModel):
    orgId: str
    name: str = Field(..., min_length=2, max_length=120)
    slug: str = Field(..., min_length=2, max_length=80)
    networkLabel: str | None = Field(default=None, max_length=120)


class SiteUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    slug: str | None = Field(default=None, min_length=2, max_length=80)
    networkLabel: str | None = Field(default=None, max_length=120)
    active: bool | None = None


class MembershipCreateRequest(BaseModel):
    accountId: str
    scopeType: ScopeType
    scopeId: str
    role: SystemRole


class MembershipUpdateRequest(BaseModel):
    active: bool | None = None
    role: SystemRole | None = None


class MembershipResponse(BaseModel):
    membership: MembershipRecord


class HubAssignmentCreateRequest(BaseModel):
    hubId: str
    orgId: str
    siteId: str


class HubAssignmentUpdateRequest(BaseModel):
    orgId: str | None = None
    siteId: str | None = None


class HubAssignmentResponse(BaseModel):
    assignment: HubAssignmentRecord


class PolicyCreateRequest(BaseModel):
    principalType: Literal["account", "role"]
    principalId: str
    scopeType: ScopeType
    scopeId: str
    capability: str = Field(..., min_length=3, max_length=120)
    effect: PolicyEffect


class PolicyUpdateRequest(BaseModel):
    capability: str | None = Field(default=None, min_length=3, max_length=120)
    effect: PolicyEffect | None = None
    scopeType: ScopeType | None = None
    scopeId: str | None = None


class PolicyListResponse(BaseModel):
    policies: list[PolicyBindingRecord]


class SessionRecord(BaseModel):
    sessionId: str
    accountId: str
    systemRole: SystemRole
    recoverySession: bool = False
    accessExpiresAt: str
    createdAt: str
    revokedAt: str | None = None
    mfaVerifiedAt: str | None = None


class EffectiveAccessResponse(BaseModel):
    accountId: str
    email: str
    systemRole: SystemRole
    isPrimaryMaster: bool
    isBackupMaster: bool
    masterControlsEnabled: bool
    capabilities: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    organizations: list[str] = Field(default_factory=list)
    sites: list[str] = Field(default_factory=list)
    hubs: list[str] = Field(default_factory=list)
    mfaRequired: bool = False
    mfaSatisfied: bool = False


class AccessTokenResponse(BaseModel):
    access_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    account: AccountRecord | None = None
    effectiveAccess: EffectiveAccessResponse | None = None
    mfaRequired: bool = False
    challengeId: str | None = None
    factorType: Literal["totp"] | None = None
    expiresAt: str | None = None


class LocalAuthRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    password: str = Field(..., min_length=1, max_length=256)


class MfaVerifyRequest(BaseModel):
    challengeId: str = Field(..., min_length=8, max_length=128)
    code: str = Field(..., min_length=6, max_length=64)


class LocalAuthResponse(AccessTokenResponse):
    pass


class SecurityStatusResponse(BaseModel):
    mfaEnabled: bool
    factorTypes: list[str] = Field(default_factory=list)
    recoveryCodesRemaining: int
    lastMfaVerifiedAt: str | None = None


class MfaEnrollmentStartResponse(BaseModel):
    secretProvisioningUri: str
    secretLabel: str
    qrSvg: str
    challengeId: str


class MfaEnrollmentCompleteRequest(BaseModel):
    challengeId: str = Field(..., min_length=8, max_length=128)
    code: str = Field(..., min_length=6, max_length=64)


class RecoveryCodesRotateResponse(BaseModel):
    recoveryCodes: list[str]
    security: SecurityStatusResponse


class MasterStateRecord(BaseModel):
    primaryAccountId: str | None = None
    backupAccountId: str | None = None
    backupActive: bool = False
    updatedAt: str | None = None


class BootstrapStartRequest(BaseModel):
    bootstrapToken: str = Field(..., min_length=8, max_length=512)


class BootstrapStartResponse(BaseModel):
    bootstrapNonce: str
    primaryEmail: str
    backupEmail: str | None = None
    bootstrapExpiresAt: str


class BootstrapCompleteRequest(BaseModel):
    bootstrapToken: str = Field(..., min_length=8, max_length=512)
    bootstrapNonce: str = Field(..., min_length=8, max_length=128)
    password: str = Field(..., min_length=12, max_length=256)
    confirmPassword: str = Field(..., min_length=12, max_length=256)
    displayName: str | None = Field(default=None, max_length=120)


class BootstrapStatusResponse(BaseModel):
    bootstrapEnabled: bool
    primaryMasterExists: bool
    bootstrapExpiresAt: str | None = None


class BootstrapCompleteResponse(AccessTokenResponse):
    bootstrapCompleted: bool = True
    masterState: MasterStateRecord


class RecoveryChallengeResponse(BaseModel):
    challengeId: str
    challenge: str
    expiresAt: str
    fingerprint: str | None = None


class RecoveryCompleteRequest(BaseModel):
    challengeId: str = Field(..., min_length=8, max_length=128)
    signature: str = Field(..., min_length=8, max_length=2048)


class RecoveryStatusResponse(BaseModel):
    fingerprint: str | None = None
    publicKeyInstalled: bool
    backupActive: bool
    backupAccountId: str | None = None


class MasterTransferRequest(BaseModel):
    targetAccountId: str = Field(..., min_length=3, max_length=64)


class RotateRecoveryKeyRequest(BaseModel):
    publicKey: str = Field(..., min_length=32, max_length=256)


class AuditEventRecord(BaseModel):
    eventId: str
    actorAccountId: str | None = None
    actorRole: SystemRole | None = None
    eventType: str
    targetType: str | None = None
    targetId: str | None = None
    outcome: AuditOutcome
    remoteAddr: str | None = None
    userAgent: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    createdAt: str


class AuditListResponse(BaseModel):
    events: list[AuditEventRecord]


class AuthenticatedPrincipal(BaseModel):
    accountId: str
    email: str
    sessionId: str
    systemRole: SystemRole
    isPrimaryMaster: bool
    isBackupMaster: bool
    masterControlsEnabled: bool
    recoverySession: bool = False
    mfaRequired: bool = False
    mfaSatisfied: bool = False
    capabilities: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    organizations: list[str] = Field(default_factory=list)
    sites: list[str] = Field(default_factory=list)
    hubs: list[str] = Field(default_factory=list)


class BootstrapArtifactBackup(BaseModel):
    email: str
    displayName: str | None = None


class BootstrapArtifact(BaseModel):
    bootstrapTokenHash: str
    bootstrapExpiresAt: str
    primaryMasterEmail: str
    primaryMasterDisplayName: str | None = None
    allowedProviders: list[str] = Field(default_factory=list)
    backupMaster: BootstrapArtifactBackup | None = None
    recoveryPublicKeyFingerprint: str | None = None


class JwkRecord(BaseModel):
    kid: str
    kty: Literal["OKP"] = "OKP"
    crv: Literal["Ed25519"] = "Ed25519"
    alg: Literal["EdDSA"] = "EdDSA"
    use: Literal["sig"] = "sig"
    x: str


class JwksResponse(BaseModel):
    keys: list[JwkRecord]


LocalAuthResponse.model_rebuild()
BootstrapCompleteResponse.model_rebuild()
AccountCreateRequest.model_rebuild()
