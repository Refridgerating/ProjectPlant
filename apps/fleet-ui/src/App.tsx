import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Channel = "dev" | "beta" | "stable";
type SystemRole = "master" | "administrator" | "user";
type ScopeType = "organization" | "site" | "hub";
type PolicyEffect = "allow" | "deny";
type Hub = { hubId: string; hostname: string; advertisedName?: string | null; site?: string | null; channel: Channel; lastCheckInAt?: string | null; currentReleaseId?: string | null; lastKnownGoodReleaseId?: string | null; localIpAddresses: string[]; hubVersion?: string | null; uiVersion?: string | null; agentVersion: string; maintenanceMode?: boolean; };
type Release = { releaseId: string; channel: Channel; hubVersion: string; uiVersion: string; createdAt: string; status: string; };
type RolloutTarget = { hubId: string; batchNumber: number; status: string; operationId?: string | null; };
type Rollout = { rolloutId: string; releaseId: string; status: string; createdAt: string; updatedAt: string; selector: Record<string, unknown>; targets: RolloutTarget[]; };
type MembershipRecord = { membershipId: string; accountId: string; scopeType: ScopeType; scopeId: string; role: SystemRole; active: boolean; createdAt: string; updatedAt: string; };
type AccountSummary = { accountId: string; email: string; displayName: string; systemRole: SystemRole; active: boolean; mustChangePassword: boolean; mfaEnabled: boolean; lastLoginAt?: string | null; memberships: MembershipRecord[]; };
type PolicyBinding = { policyId: string; principalType: "account" | "role"; principalId: string; scopeType: ScopeType; scopeId: string; capability: string; effect: PolicyEffect; createdAt: string; updatedAt: string; };
type OrganizationRecord = { orgId: string; name: string; slug: string; active: boolean; createdAt: string; updatedAt: string; };
type SiteRecord = { siteId: string; orgId: string; name: string; slug: string; networkLabel?: string | null; active: boolean; createdAt: string; updatedAt: string; };
type EffectiveAccess = { accountId: string; email: string; systemRole: SystemRole; isPrimaryMaster: boolean; isBackupMaster: boolean; masterControlsEnabled: boolean; capabilities: string[]; scopes: string[]; organizations: string[]; sites: string[]; hubs: string[]; mfaRequired: boolean; mfaSatisfied: boolean; };
type BootstrapStatus = { bootstrapEnabled: boolean; primaryMasterExists: boolean; bootstrapExpiresAt?: string | null; };
type MasterState = { primaryAccountId?: string | null; backupAccountId?: string | null; backupActive: boolean; updatedAt?: string | null; };
type RecoveryStatus = { fingerprint?: string | null; publicKeyInstalled: boolean; backupActive: boolean; backupAccountId?: string | null; };
type AuditEvent = { eventId: string; eventType: string; outcome: string; actorAccountId?: string | null; targetId?: string | null; createdAt: string; metadata: Record<string, unknown>; };
type SecurityStatus = { mfaEnabled: boolean; factorTypes: string[]; recoveryCodesRemaining: number; lastMfaVerifiedAt?: string | null; };
type AuthResponse = { access_token?: string; expires_in?: number; mfaRequired?: boolean; challengeId?: string | null; factorType?: string | null; expiresAt?: string | null; account?: AccountSummary | null; effectiveAccess?: EffectiveAccess | null; };
type BootstrapStartResponse = { bootstrapNonce: string };
type MfaEnrollmentStartResponse = { secretProvisioningUri: string; secretLabel: string; qrSvg: string; challengeId: string };
type RecoveryCodesRotateResponse = { recoveryCodes: string[]; security: SecurityStatus };

type HubListResponse = { hubs: Hub[] };
type ReleaseListResponse = { releases: Release[] };
type RolloutListResponse = { rollouts: Rollout[] };
type AuditListResponse = { events: AuditEvent[] };
type AccountListResponse = { accounts: AccountSummary[] };
type OrganizationListResponse = { organizations: OrganizationRecord[] };
type SiteListResponse = { sites: SiteRecord[] };
type PolicyListResponse = { policies: PolicyBinding[] };

type LoginMode = "login" | "bootstrap";

const baseUrl = ((import.meta.env.VITE_FLEET_URL as string | undefined)?.replace(/\/$/, "")) || "http://127.0.0.1:8100";
const tokenStorageKey = "projectplant-fleet-token";
const capabilityOptions = [
  "hub.view",
  "hub.control",
  "hub.update",
  "hub.rollback",
  "fleet.view",
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
] as const;

async function requestJson<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { detail?: string };
      detail = typeof payload.detail === "string" ? payload.detail : "";
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function countAudit(events: AuditEvent[], eventType: string, outcome?: string): number {
  return events.filter((event) => event.eventType === eventType && (!outcome || event.outcome === outcome)).length;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => window.localStorage.getItem(tokenStorageKey));
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveAccess | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus | null>(null);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus | null>(null);
  const [loginMode, setLoginMode] = useState<LoginMode>("login");
  const [email, setEmail] = useState("owner@example.com");
  const [password, setPassword] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [bootstrapDisplayName, setBootstrapDisplayName] = useState("Owner");
  const [status, setStatus] = useState("Ready.");
  const [loading, setLoading] = useState(false);

  const [hubs, setHubs] = useState<Hub[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationRecord[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [policies, setPolicies] = useState<PolicyBinding[]>([]);
  const [masterState, setMasterState] = useState<MasterState | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [mfaEnrollment, setMfaEnrollment] = useState<MfaEnrollmentStartResponse | null>(null);
  const [mfaEnrollmentCode, setMfaEnrollmentCode] = useState("");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [selectedHubId, setSelectedHubId] = useState("");
  const [rolloutScope, setRolloutScope] = useState<"all" | "channel" | "site">("all");
  const [rolloutChannel, setRolloutChannel] = useState<Channel>("dev");
  const [rolloutSite, setRolloutSite] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [selectedTransferAccountId, setSelectedTransferAccountId] = useState("");
  const [recoveryPublicKey, setRecoveryPublicKey] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountDisplayName, setAccountDisplayName] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountRole, setAccountRole] = useState<SystemRole>("user");
  const [accountScopeType, setAccountScopeType] = useState<ScopeType>("site");
  const [accountScopeId, setAccountScopeId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [siteOrgId, setSiteOrgId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteSlug, setSiteSlug] = useState("");
  const [siteNetworkLabel, setSiteNetworkLabel] = useState("");
  const [policyPrincipalType, setPolicyPrincipalType] = useState<"account" | "role">("account");
  const [policyPrincipalId, setPolicyPrincipalId] = useState("");
  const [policyScopeType, setPolicyScopeType] = useState<ScopeType>("site");
  const [policyScopeId, setPolicyScopeId] = useState("");
  const [policyCapability, setPolicyCapability] = useState<(typeof capabilityOptions)[number]>("hub.update");
  const [policyEffect, setPolicyEffect] = useState<PolicyEffect>("allow");

  const loadBootstrapStatus = useCallback(async () => {
    try {
      const next = await requestJson<BootstrapStatus>("/api/v1/bootstrap/status", null);
      setBootstrapStatus(next);
      if (next.bootstrapEnabled) setLoginMode("bootstrap");
    } catch {
      setBootstrapStatus(null);
    }
  }, []);

  const loadAccounts = useCallback(async (authToken: string, query: string) => {
    const params = new URLSearchParams();
    if (query.trim()) {
      params.set("q", query.trim());
    }
    const payload = await requestJson<AccountListResponse>(`/api/v1/accounts${params.size ? `?${params.toString()}` : ""}`, authToken);
    setAccounts(payload.accounts);
  }, []);

  const loadAuthenticated = useCallback(async (authToken: string) => {
    const access = await requestJson<EffectiveAccess>("/api/v1/me/effective-access", authToken);
    setEffectiveAccess(access);
    const [hubPayload, releasePayload, rolloutPayload, nextSecurity] = await Promise.all([
      requestJson<HubListResponse>("/api/v1/hubs", authToken),
      requestJson<ReleaseListResponse>("/api/v1/releases", authToken),
      requestJson<RolloutListResponse>("/api/v1/rollouts", authToken),
      requestJson<SecurityStatus>("/api/v1/me/security", authToken),
    ]);
    setHubs(hubPayload.hubs);
    setReleases(releasePayload.releases);
    setRollouts(rolloutPayload.rollouts);
    setSecurityStatus(nextSecurity);
    setSelectedHubId((current) => current || hubPayload.hubs[0]?.hubId || "");
    setSelectedReleaseId((current) => current || releasePayload.releases[0]?.releaseId || "");
    setRolloutSite((current) => current || hubPayload.hubs[0]?.site || "");

    if (access.capabilities.includes("account.view")) {
      await loadAccounts(authToken, accountQuery);
    } else {
      setAccounts([]);
    }

    if (access.masterControlsEnabled) {
      const [auditPayload, nextMasterState, nextRecoveryStatus, orgPayload, sitePayload, policyPayload] = await Promise.all([
        requestJson<AuditListResponse>("/api/v1/audit?limit=200", authToken),
        requestJson<MasterState>("/api/v1/system/master-state", authToken),
        requestJson<RecoveryStatus>("/api/v1/system/recovery-status", authToken),
        requestJson<OrganizationListResponse>("/api/v1/organizations", authToken),
        requestJson<SiteListResponse>("/api/v1/sites", authToken),
        requestJson<PolicyListResponse>("/api/v1/policies", authToken),
      ]);
      setAuditEvents(auditPayload.events);
      setMasterState(nextMasterState);
      setRecoveryStatus(nextRecoveryStatus);
      setOrganizations(orgPayload.organizations);
      setSites(sitePayload.sites);
      setPolicies(policyPayload.policies);
      setSiteOrgId((current) => current || orgPayload.organizations[0]?.orgId || "");
    } else {
      setAuditEvents([]);
      setMasterState(null);
      setRecoveryStatus(null);
      setOrganizations([]);
      setSites([]);
      setPolicies([]);
    }
  }, [accountQuery, loadAccounts]);

  useEffect(() => {
    void loadBootstrapStatus();
  }, [loadBootstrapStatus]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    void loadAuthenticated(token)
      .then(() => setStatus("Loaded fleet state."))
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error));
        setToken(null);
        setEffectiveAccess(null);
        window.localStorage.removeItem(tokenStorageKey);
      })
      .finally(() => setLoading(false));
  }, [loadAuthenticated, token]);

  const availableSites = useMemo(() => Array.from(new Set(hubs.map((hub) => hub.site).filter((site): site is string => Boolean(site)))).sort(), [hubs]);
  const selectedHub = useMemo(() => hubs.find((hub) => hub.hubId === selectedHubId) ?? null, [hubs, selectedHubId]);
  const filteredTransferAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return accounts.filter((account) => {
      if (account.systemRole === "master") {
        return false;
      }
      if (!query) {
        return true;
      }
      return account.email.toLowerCase().includes(query) || account.displayName.toLowerCase().includes(query);
    });
  }, [accountQuery, accounts]);
  const failedMfa24h = useMemo(() => countAudit(auditEvents, "auth.mfa.verify", "failed"), [auditEvents]);
  const deniedActions24h = useMemo(() => countAudit(auditEvents, "authz.denied"), [auditEvents]);
  const masterLogins24h = useMemo(() => countAudit(auditEvents, "auth.local", "succeeded"), [auditEvents]);
  const accountsWithMfa = useMemo(() => accounts.filter((account) => account.mfaEnabled).length, [accounts]);

  const persistToken = useCallback((nextToken: string | null) => {
    setToken(nextToken);
    if (nextToken) window.localStorage.setItem(tokenStorageKey, nextToken);
    else window.localStorage.removeItem(tokenStorageKey);
  }, []);

  const handleLogin = useCallback(async () => {
    setLoading(true);
    try {
      const response = await requestJson<AuthResponse>("/api/v1/auth/local", null, { method: "POST", body: JSON.stringify({ email, password }) });
      if (response.mfaRequired && response.challengeId) {
        setMfaChallengeId(response.challengeId);
        setPassword("");
        setStatus(`Enter the authenticator code for ${email}.`);
        return;
      }
      if (!response.access_token) {
        throw new Error("Access token missing from login response.");
      }
      persistToken(response.access_token);
      setMfaChallengeId(null);
      setMfaCode("");
      setPassword("");
      setStatus(`Signed in as ${email}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [email, password, persistToken]);

  const handleMfaVerify = useCallback(async () => {
    if (!mfaChallengeId) return;
    setLoading(true);
    try {
      const response = await requestJson<AuthResponse>("/api/v1/auth/mfa/verify", null, {
        method: "POST",
        body: JSON.stringify({ challengeId: mfaChallengeId, code: mfaCode }),
      });
      if (!response.access_token) {
        throw new Error("Access token missing from MFA response.");
      }
      persistToken(response.access_token);
      setMfaChallengeId(null);
      setMfaCode("");
      setStatus("MFA verification succeeded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [mfaChallengeId, mfaCode, persistToken]);

  const handleBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const start = await requestJson<BootstrapStartResponse>("/api/v1/bootstrap/master/start", null, { method: "POST", body: JSON.stringify({ bootstrapToken }) });
      const complete = await requestJson<AuthResponse>("/api/v1/bootstrap/master/complete", null, {
        method: "POST",
        body: JSON.stringify({ bootstrapToken, bootstrapNonce: start.bootstrapNonce, password: bootstrapPassword, confirmPassword: bootstrapPassword, displayName: bootstrapDisplayName }),
      });
      if (!complete.access_token) {
        throw new Error("Bootstrap did not return an access token.");
      }
      persistToken(complete.access_token);
      setStatus("Primary master created.");
      await loadBootstrapStatus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [bootstrapDisplayName, bootstrapPassword, bootstrapToken, loadBootstrapStatus, persistToken]);

  const logout = useCallback(async () => {
    if (token) {
      try { await requestJson("/api/v1/auth/logout", token, { method: "POST" }); } catch {}
    }
    persistToken(null);
    setEffectiveAccess(null);
    setMfaChallengeId(null);
    setMfaCode("");
    setStatus("Signed out.");
  }, [persistToken, token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      await loadAuthenticated(token);
      setStatus("Fleet state refreshed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [loadAuthenticated, token]);

  const rollbackHub = useCallback(async (hubId: string) => {
    if (!token) return;
    await requestJson(`/api/v1/hubs/${hubId}/rollback`, token, { method: "POST" });
    await refresh();
  }, [refresh, token]);

  const createRollout = useCallback(async () => {
    if (!token || !selectedReleaseId) return;
    const selector = rolloutScope === "channel" ? { channel: rolloutChannel } : rolloutScope === "site" ? { site: rolloutSite } : { hubIds: hubs.map((hub) => hub.hubId) };
    await requestJson("/api/v1/rollouts", token, { method: "POST", body: JSON.stringify({ releaseId: selectedReleaseId, selector }) });
    await refresh();
  }, [hubs, refresh, rolloutChannel, rolloutScope, rolloutSite, selectedReleaseId, token]);

  const patchRollout = useCallback(async (rolloutId: string, action: "pause" | "resume") => {
    if (!token) return;
    await requestJson(`/api/v1/rollouts/${rolloutId}/${action}`, token, { method: "POST" });
    await refresh();
  }, [refresh, token]);

  const callMasterAction = useCallback(async (path: string, body?: Record<string, unknown>) => {
    if (!token) return;
    await requestJson(path, token, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    await refresh();
  }, [refresh, token]);

  const handleCreateAccount = useCallback(async () => {
    if (!token) return;
    await requestJson("/api/v1/accounts", token, {
      method: "POST",
      body: JSON.stringify({
        email: accountEmail,
        displayName: accountDisplayName || undefined,
        systemRole: accountRole,
        temporaryPassword: accountPassword,
        mustChangePassword: true,
        memberships: accountScopeId.trim()
          ? [{ accountId: "", scopeType: accountScopeType, scopeId: accountScopeId.trim(), role: accountRole }]
          : [],
      }),
    });
    setAccountEmail("");
    setAccountDisplayName("");
    setAccountPassword("");
    setAccountScopeId("");
    setStatus("Account created.");
    await refresh();
  }, [accountDisplayName, accountEmail, accountPassword, accountRole, accountScopeId, accountScopeType, refresh, token]);

  const handleCreateOrganization = useCallback(async () => {
    if (!token) return;
    await requestJson("/api/v1/organizations", token, {
      method: "POST",
      body: JSON.stringify({ name: organizationName, slug: organizationSlug }),
    });
    setOrganizationName("");
    setOrganizationSlug("");
    setStatus("Organization created.");
    await refresh();
  }, [organizationName, organizationSlug, refresh, token]);

  const handleCreateSite = useCallback(async () => {
    if (!token) return;
    await requestJson("/api/v1/sites", token, {
      method: "POST",
      body: JSON.stringify({ orgId: siteOrgId, name: siteName, slug: siteSlug, networkLabel: siteNetworkLabel || undefined }),
    });
    setSiteName("");
    setSiteSlug("");
    setSiteNetworkLabel("");
    setStatus("Site created.");
    await refresh();
  }, [refresh, siteName, siteNetworkLabel, siteOrgId, siteSlug, token]);

  const handleCreatePolicy = useCallback(async () => {
    if (!token) return;
    await requestJson("/api/v1/policies", token, {
      method: "POST",
      body: JSON.stringify({
        principalType: policyPrincipalType,
        principalId: policyPrincipalId,
        scopeType: policyScopeType,
        scopeId: policyScopeId,
        capability: policyCapability,
        effect: policyEffect,
      }),
    });
    setStatus("Policy binding created.");
    await refresh();
  }, [policyCapability, policyEffect, policyPrincipalId, policyPrincipalType, policyScopeId, policyScopeType, refresh, token]);

  const handleDeletePolicy = useCallback(async (policyId: string) => {
    if (!token) return;
    await requestJson(`/api/v1/policies/${policyId}`, token, { method: "DELETE" });
    setStatus("Policy removed.");
    await refresh();
  }, [refresh, token]);

  const handleStartMfaEnrollment = useCallback(async () => {
    if (!token) return;
    const response = await requestJson<MfaEnrollmentStartResponse>("/api/v1/auth/mfa/enroll/start", token, { method: "POST" });
    setMfaEnrollment(response);
    setMfaEnrollmentCode("");
    setRecoveryCodes([]);
    setStatus("Scan the secret and confirm the authenticator code.");
  }, [token]);

  const handleCompleteMfaEnrollment = useCallback(async () => {
    if (!token || !mfaEnrollment) return;
    const response = await requestJson<RecoveryCodesRotateResponse>("/api/v1/auth/mfa/enroll/complete", token, {
      method: "POST",
      body: JSON.stringify({ challengeId: mfaEnrollment.challengeId, code: mfaEnrollmentCode }),
    });
    setSecurityStatus(response.security);
    setRecoveryCodes(response.recoveryCodes);
    setMfaEnrollment(null);
    setMfaEnrollmentCode("");
    setStatus("MFA enrollment completed.");
    await refresh();
  }, [mfaEnrollment, mfaEnrollmentCode, refresh, token]);

  const handleRotateRecoveryCodes = useCallback(async () => {
    if (!token) return;
    const response = await requestJson<RecoveryCodesRotateResponse>("/api/v1/auth/mfa/recovery-codes/rotate", token, { method: "POST" });
    setSecurityStatus(response.security);
    setRecoveryCodes(response.recoveryCodes);
    setStatus("Recovery codes rotated.");
  }, [token]);

  if (!token || !effectiveAccess) {
    return (
      <main style={styles.page}>
        <section style={styles.card}>
          <h1 style={styles.title}>ProjectPlant Fleet</h1>
          <p style={styles.status}>{status}</p>
          {bootstrapStatus?.bootstrapEnabled ? (
            <div style={styles.stack}>
              <div style={styles.modeRow}>
                <button style={loginMode === "bootstrap" ? styles.primaryButton : styles.secondaryButton} onClick={() => setLoginMode("bootstrap")}>Bootstrap</button>
                <button style={loginMode === "login" ? styles.primaryButton : styles.secondaryButton} onClick={() => setLoginMode("login")}>Login</button>
              </div>
              {loginMode === "bootstrap" ? (
                <>
                  <input style={styles.input} placeholder="Bootstrap token" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} />
                  <input style={styles.input} placeholder="Display name" value={bootstrapDisplayName} onChange={(event) => setBootstrapDisplayName(event.target.value)} />
                  <input style={styles.input} placeholder="Master password" type="password" value={bootstrapPassword} onChange={(event) => setBootstrapPassword(event.target.value)} />
                  <button style={styles.primaryButton} onClick={() => void handleBootstrap()} disabled={loading}>Create primary master</button>
                </>
              ) : null}
            </div>
          ) : null}
          {loginMode === "login" ? (
            <div style={styles.stack}>
              <input style={styles.input} placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
              <input style={styles.input} placeholder="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              {!mfaChallengeId ? (
                <button style={styles.primaryButton} onClick={() => void handleLogin()} disabled={loading}>Sign in</button>
              ) : (
                <>
                  <input style={styles.input} placeholder="Authenticator code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} />
                  <button style={styles.primaryButton} onClick={() => void handleMfaVerify()} disabled={loading}>Verify MFA</button>
                  <button style={styles.secondaryButton} onClick={() => { setMfaChallengeId(null); setMfaCode(""); }}>Cancel MFA</button>
                </>
              )}
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <section style={styles.header}>
        <div>
          <h1 style={styles.title}>ProjectPlant Fleet</h1>
          <p style={styles.status}>{effectiveAccess.email} · {effectiveAccess.systemRole} · {status}</p>
        </div>
        <div style={styles.row}>
          <button style={styles.secondaryButton} onClick={() => void refresh()} disabled={loading}>Refresh</button>
          <button style={styles.secondaryButton} onClick={() => void logout()}>Sign out</button>
        </div>
      </section>

      <section style={styles.grid4}>
        <article style={styles.metricCard}><span style={styles.metricLabel}>Hubs</span><strong style={styles.metricValue}>{hubs.length}</strong><span style={styles.metricHint}>{hubs.filter((hub) => hub.lastCheckInAt).length} reporting</span></article>
        <article style={styles.metricCard}><span style={styles.metricLabel}>Failed MFA</span><strong style={styles.metricValue}>{failedMfa24h}</strong><span style={styles.metricHint}>audit window</span></article>
        <article style={styles.metricCard}><span style={styles.metricLabel}>Denied Actions</span><strong style={styles.metricValue}>{deniedActions24h}</strong><span style={styles.metricHint}>authz.denied</span></article>
        <article style={styles.metricCard}><span style={styles.metricLabel}>Master Logins</span><strong style={styles.metricValue}>{masterLogins24h}</strong><span style={styles.metricHint}>successful auth.local</span></article>
        <article style={styles.metricCard}><span style={styles.metricLabel}>Accounts With MFA</span><strong style={styles.metricValue}>{accountsWithMfa}</strong><span style={styles.metricHint}>enrolled accounts</span></article>
      </section>

      <section style={styles.grid2}>
        <article style={styles.card}>
          <h2>Security</h2>
          <div style={styles.stack}>
            <div>MFA enabled: {securityStatus?.mfaEnabled ? "yes" : "no"}</div>
            <div>Factors: {securityStatus?.factorTypes?.length ? securityStatus.factorTypes.join(", ") : "-"}</div>
            <div>Recovery codes remaining: {securityStatus?.recoveryCodesRemaining ?? 0}</div>
            <div>Last MFA verification: {formatDate(securityStatus?.lastMfaVerifiedAt)}</div>
            {effectiveAccess.masterControlsEnabled ? (
              <div style={styles.row}>
                {!securityStatus?.mfaEnabled ? (
                  <button style={styles.secondaryButton} onClick={() => void handleStartMfaEnrollment()}>Enroll TOTP MFA</button>
                ) : (
                  <button style={styles.secondaryButton} onClick={() => void handleRotateRecoveryCodes()}>Rotate recovery codes</button>
                )}
              </div>
            ) : null}
            {mfaEnrollment ? (
              <div style={styles.stack}>
                <div style={styles.note}>Scan the authenticator secret, then verify the current code.</div>
                <div style={styles.svgPanel} dangerouslySetInnerHTML={{ __html: mfaEnrollment.qrSvg }} />
                <div style={styles.note}>{mfaEnrollment.secretProvisioningUri}</div>
                <input style={styles.input} placeholder="Authenticator code" value={mfaEnrollmentCode} onChange={(event) => setMfaEnrollmentCode(event.target.value)} />
                <button style={styles.primaryButton} onClick={() => void handleCompleteMfaEnrollment()} disabled={!mfaEnrollmentCode}>Complete MFA enrollment</button>
              </div>
            ) : null}
            {recoveryCodes.length ? (
              <div style={styles.codePanel}>
                <strong>Recovery codes</strong>
                <div style={styles.codeGrid}>
                  {recoveryCodes.map((code) => <code key={code} style={styles.codeCell}>{code}</code>)}
                </div>
              </div>
            ) : null}
          </div>
        </article>

        <article style={styles.card}>
          <h2>Hubs</h2>
          <div style={styles.stack}>
            {hubs.map((hub) => (
              <button key={hub.hubId} style={selectedHubId === hub.hubId ? styles.selectedRow : styles.listRow} onClick={() => setSelectedHubId(hub.hubId)}>
                <span>{hub.advertisedName || hub.hostname}</span>
                <span>{hub.channel}</span>
              </button>
            ))}
          </div>
          {selectedHub ? (
            <div style={styles.stack}>
              <div>Hub ID: {selectedHub.hubId}</div>
              <div>Site: {selectedHub.site || "-"}</div>
              <div>Versions: hub {selectedHub.hubVersion || "-"} · ui {selectedHub.uiVersion || "-"} · agent {selectedHub.agentVersion}</div>
              <div>Last check-in: {formatDate(selectedHub.lastCheckInAt)}</div>
              {effectiveAccess.capabilities.includes("hub.rollback") ? (
                <button style={styles.secondaryButton} onClick={() => void rollbackHub(selectedHub.hubId)}>Queue rollback</button>
              ) : null}
            </div>
          ) : null}
        </article>
      </section>

      <section style={styles.grid2}>
        <article style={styles.card}>
          <h2>Rollout Builder</h2>
          <div style={styles.stack}>
            <select style={styles.input} value={selectedReleaseId} onChange={(event) => setSelectedReleaseId(event.target.value)}>
              <option value="">Select release</option>
              {releases.map((release) => <option key={release.releaseId} value={release.releaseId}>{release.releaseId} · {release.channel}</option>)}
            </select>
            <select style={styles.input} value={rolloutScope} onChange={(event) => setRolloutScope(event.target.value as "all" | "channel" | "site")}>
              <option value="all">All hubs</option>
              <option value="channel">Channel</option>
              <option value="site">Site</option>
            </select>
            {rolloutScope === "channel" ? <select style={styles.input} value={rolloutChannel} onChange={(event) => setRolloutChannel(event.target.value as Channel)}><option value="dev">dev</option><option value="beta">beta</option><option value="stable">stable</option></select> : null}
            {rolloutScope === "site" ? <select style={styles.input} value={rolloutSite} onChange={(event) => setRolloutSite(event.target.value)}><option value="">Select site</option>{availableSites.map((site) => <option key={site} value={site}>{site}</option>)}</select> : null}
            <button style={styles.primaryButton} onClick={() => void createRollout()} disabled={!selectedReleaseId}>Create rollout</button>
          </div>
        </article>

        <article style={styles.card}>
          <h2>Rollouts</h2>
          <div style={styles.stack}>
            {rollouts.map((rollout) => (
              <div key={rollout.rolloutId} style={styles.panelRow}>
                <div>
                  <strong>{rollout.rolloutId}</strong>
                  <div>{rollout.releaseId} · {formatDate(rollout.createdAt)}</div>
                </div>
                <div style={styles.row}>
                  <span>{rollout.status}</span>
                  {rollout.status === "active" ? <button style={styles.secondaryButton} onClick={() => void patchRollout(rollout.rolloutId, "pause")}>Pause</button> : null}
                  {rollout.status === "paused" ? <button style={styles.secondaryButton} onClick={() => void patchRollout(rollout.rolloutId, "resume")}>Resume</button> : null}
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      {effectiveAccess.capabilities.includes("account.view") ? (
        <section style={styles.grid2}>
          <article style={styles.card}>
            <h2>Accounts</h2>
            <div style={styles.row}>
              <input style={styles.input} placeholder="Search by email or display name" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} />
              <button style={styles.secondaryButton} onClick={() => void (token ? loadAccounts(token, accountQuery) : Promise.resolve())}>Search</button>
            </div>
            <div style={styles.stack}>
              {accounts.map((account) => (
                <div key={account.accountId} style={styles.panelRow}>
                  <div>
                    <strong>{account.displayName || account.email}</strong>
                    <div>{account.email}</div>
                    <div>{account.systemRole} · {account.active ? "active" : "inactive"} · MFA {account.mfaEnabled ? "enabled" : "off"}</div>
                    <div>Last login: {formatDate(account.lastLoginAt)}</div>
                  </div>
                  <div style={styles.note}>
                    {account.memberships.length
                      ? account.memberships.map((membership) => `${membership.scopeType}:${membership.scopeId}`).join(", ")
                      : "No memberships"}
                  </div>
                </div>
              ))}
            </div>
          </article>

          {effectiveAccess.capabilities.includes("account.manage") ? (
            <article style={styles.card}>
              <h2>Create Account</h2>
              <div style={styles.stack}>
                <input style={styles.input} placeholder="Email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} />
                <input style={styles.input} placeholder="Display name" value={accountDisplayName} onChange={(event) => setAccountDisplayName(event.target.value)} />
                <input style={styles.input} placeholder="Temporary password" type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
                <select style={styles.input} value={accountRole} onChange={(event) => setAccountRole(event.target.value as SystemRole)}>
                  <option value="user">user</option>
                  {effectiveAccess.masterControlsEnabled ? <option value="administrator">administrator</option> : null}
                </select>
                <select style={styles.input} value={accountScopeType} onChange={(event) => setAccountScopeType(event.target.value as ScopeType)}>
                  <option value="organization">organization</option>
                  <option value="site">site</option>
                  <option value="hub">hub</option>
                </select>
                <input style={styles.input} placeholder="Scope id (optional)" value={accountScopeId} onChange={(event) => setAccountScopeId(event.target.value)} />
                <button style={styles.primaryButton} onClick={() => void handleCreateAccount()} disabled={!accountEmail || !accountPassword}>Create account</button>
              </div>
            </article>
          ) : null}
        </section>
      ) : null}

      {effectiveAccess.masterControlsEnabled ? (
        <>
          <section style={styles.grid2}>
            <article style={styles.card}>
              <h2>Organizations & Sites</h2>
              <div style={styles.stack}>
                <strong>Organizations</strong>
                {organizations.map((organization) => (
                  <div key={organization.orgId} style={styles.panelRow}>
                    <div>
                      <strong>{organization.name}</strong>
                      <div>{organization.orgId}</div>
                    </div>
                    <span>{organization.active ? "active" : "inactive"}</span>
                  </div>
                ))}
                <input style={styles.input} placeholder="Organization name" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
                <input style={styles.input} placeholder="Organization slug" value={organizationSlug} onChange={(event) => setOrganizationSlug(event.target.value)} />
                <button style={styles.secondaryButton} onClick={() => void handleCreateOrganization()} disabled={!organizationName || !organizationSlug}>Create organization</button>
                <strong>Sites</strong>
                {sites.map((site) => (
                  <div key={site.siteId} style={styles.panelRow}>
                    <div>
                      <strong>{site.name}</strong>
                      <div>{site.siteId} · org {site.orgId}</div>
                    </div>
                    <span>{site.active ? "active" : "inactive"}</span>
                  </div>
                ))}
                <select style={styles.input} value={siteOrgId} onChange={(event) => setSiteOrgId(event.target.value)}>
                  <option value="">Select organization</option>
                  {organizations.map((organization) => <option key={organization.orgId} value={organization.orgId}>{organization.name}</option>)}
                </select>
                <input style={styles.input} placeholder="Site name" value={siteName} onChange={(event) => setSiteName(event.target.value)} />
                <input style={styles.input} placeholder="Site slug" value={siteSlug} onChange={(event) => setSiteSlug(event.target.value)} />
                <input style={styles.input} placeholder="Network label" value={siteNetworkLabel} onChange={(event) => setSiteNetworkLabel(event.target.value)} />
                <button style={styles.secondaryButton} onClick={() => void handleCreateSite()} disabled={!siteOrgId || !siteName || !siteSlug}>Create site</button>
              </div>
            </article>

            <article style={styles.card}>
              <h2>Policies</h2>
              <div style={styles.stack}>
                {policies.map((policy) => (
                  <div key={policy.policyId} style={styles.panelRow}>
                    <div>
                      <strong>{policy.capability}</strong>
                      <div>{policy.principalType}:{policy.principalId}</div>
                      <div>{policy.scopeType}:{policy.scopeId} · {policy.effect}</div>
                    </div>
                    <button style={styles.secondaryButton} onClick={() => void handleDeletePolicy(policy.policyId)}>Delete</button>
                  </div>
                ))}
                <select style={styles.input} value={policyPrincipalType} onChange={(event) => setPolicyPrincipalType(event.target.value as "account" | "role")}>
                  <option value="account">Account</option>
                  <option value="role">Role</option>
                </select>
                {policyPrincipalType === "account" ? (
                  <select style={styles.input} value={policyPrincipalId} onChange={(event) => setPolicyPrincipalId(event.target.value)}>
                    <option value="">Select account</option>
                    {accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.displayName || account.email}</option>)}
                  </select>
                ) : (
                  <select style={styles.input} value={policyPrincipalId} onChange={(event) => setPolicyPrincipalId(event.target.value)}>
                    <option value="">Select role</option>
                    <option value="administrator">administrator</option>
                    <option value="user">user</option>
                  </select>
                )}
                <select style={styles.input} value={policyScopeType} onChange={(event) => setPolicyScopeType(event.target.value as ScopeType)}>
                  <option value="organization">organization</option>
                  <option value="site">site</option>
                  <option value="hub">hub</option>
                </select>
                <input style={styles.input} placeholder="Scope id" value={policyScopeId} onChange={(event) => setPolicyScopeId(event.target.value)} />
                <select style={styles.input} value={policyCapability} onChange={(event) => setPolicyCapability(event.target.value as (typeof capabilityOptions)[number])}>
                  {capabilityOptions.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
                </select>
                <select style={styles.input} value={policyEffect} onChange={(event) => setPolicyEffect(event.target.value as PolicyEffect)}>
                  <option value="allow">allow</option>
                  <option value="deny">deny</option>
                </select>
                <button style={styles.primaryButton} onClick={() => void handleCreatePolicy()} disabled={!policyPrincipalId || !policyScopeId}>Create policy</button>
              </div>
            </article>
          </section>

          <section style={styles.grid2}>
            <article style={styles.card}>
              <h2>Master Controls</h2>
              <div style={styles.stack}>
                <div>Primary: {masterState?.primaryAccountId || "-"}</div>
                <div>Backup: {masterState?.backupAccountId || "-"}</div>
                <div>Backup active: {masterState?.backupActive ? "yes" : "no"}</div>
                <div style={styles.row}>
                  <input style={styles.input} placeholder="Search transfer target" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} />
                  <button style={styles.secondaryButton} onClick={() => void (token ? loadAccounts(token, accountQuery) : Promise.resolve())}>Refresh accounts</button>
                </div>
                <select style={styles.input} value={selectedTransferAccountId} onChange={(event) => setSelectedTransferAccountId(event.target.value)}>
                  <option value="">Select transfer target</option>
                  {filteredTransferAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.displayName || account.email} · {account.accountId}</option>)}
                </select>
                <button style={styles.secondaryButton} onClick={() => void callMasterAction("/api/v1/masters/transfer", { targetAccountId: selectedTransferAccountId })} disabled={!effectiveAccess.isPrimaryMaster || !selectedTransferAccountId}>Transfer primary master</button>
                <button style={styles.secondaryButton} onClick={() => void callMasterAction("/api/v1/masters/activate-backup")} disabled={!effectiveAccess.isPrimaryMaster}>Activate backup</button>
                <button style={styles.secondaryButton} onClick={() => void callMasterAction("/api/v1/masters/deactivate-backup")} disabled={!effectiveAccess.isPrimaryMaster}>Deactivate backup</button>
                <textarea style={styles.textarea} placeholder="New recovery public key hex" value={recoveryPublicKey} onChange={(event) => setRecoveryPublicKey(event.target.value)} />
                <button style={styles.secondaryButton} onClick={() => void callMasterAction("/api/v1/masters/recovery-public-key/rotate", { publicKey: recoveryPublicKey })} disabled={!effectiveAccess.isPrimaryMaster || !recoveryPublicKey}>Rotate recovery key</button>
              </div>
            </article>

            <article style={styles.card}>
              <h2>Recovery Status</h2>
              <div style={styles.stack}>
                <div>Public key installed: {recoveryStatus?.publicKeyInstalled ? "yes" : "no"}</div>
                <div>Fingerprint: {recoveryStatus?.fingerprint || "-"}</div>
                <div>Backup account: {recoveryStatus?.backupAccountId || "-"}</div>
                <div>Backup active: {recoveryStatus?.backupActive ? "yes" : "no"}</div>
                <div style={styles.note}>Master transfer now uses account selection instead of raw account ids.</div>
              </div>
            </article>
          </section>
        </>
      ) : null}

      {effectiveAccess.capabilities.includes("audit.view") ? (
        <section style={styles.card}>
          <h2>Audit</h2>
          <div style={styles.stack}>
            {auditEvents.map((event) => (
              <div key={event.eventId} style={styles.panelRow}>
                <div>
                  <strong>{event.eventType}</strong>
                  <div>{formatDate(event.createdAt)}</div>
                </div>
                <div>{event.outcome}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { minHeight: "100vh", padding: 24, background: "#0d1813", color: "#eef6ee", fontFamily: '"Segoe UI", sans-serif' },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 32 },
  status: { margin: "8px 0 0", color: "#a9c3af" },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 16 },
  grid4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 16 },
  card: { background: "#15231c", border: "1px solid #254033", borderRadius: 16, padding: 16, display: "grid", gap: 12 },
  metricCard: { background: "#15231c", border: "1px solid #254033", borderRadius: 16, padding: 16, display: "grid", gap: 8 },
  metricLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.16em", color: "#a9c3af" },
  metricValue: { fontSize: 30, lineHeight: 1 },
  metricHint: { fontSize: 12, color: "#a9c3af" },
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  modeRow: { display: "flex", gap: 8 },
  stack: { display: "grid", gap: 10 },
  listRow: { display: "flex", justifyContent: "space-between", padding: 10, borderRadius: 12, background: "#0f1a14", border: "1px solid #22382d", color: "#eef6ee" },
  selectedRow: { display: "flex", justifyContent: "space-between", padding: 10, borderRadius: 12, background: "#203726", border: "1px solid #90c29b", color: "#eef6ee" },
  panelRow: { display: "flex", justifyContent: "space-between", gap: 12, padding: 10, borderRadius: 12, background: "#0f1a14", border: "1px solid #22382d", flexWrap: "wrap" },
  input: { borderRadius: 10, border: "1px solid #345342", background: "#0c1510", color: "#eef6ee", padding: "10px 12px" },
  textarea: { minHeight: 100, borderRadius: 10, border: "1px solid #345342", background: "#0c1510", color: "#eef6ee", padding: "10px 12px" },
  primaryButton: { borderRadius: 999, border: 0, background: "#a9e267", color: "#102012", padding: "10px 16px", fontWeight: 700, cursor: "pointer" },
  secondaryButton: { borderRadius: 999, border: "1px solid #345342", background: "#0c1510", color: "#eef6ee", padding: "10px 16px", cursor: "pointer" },
  note: { color: "#a9c3af", lineHeight: 1.4 },
  svgPanel: { borderRadius: 12, background: "#f4faf5", padding: 12, color: "#0d1813" },
  codePanel: { borderRadius: 12, border: "1px solid #345342", background: "#0c1510", padding: 12, display: "grid", gap: 10 },
  codeGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 },
  codeCell: { display: "block", padding: "8px 10px", borderRadius: 10, background: "#15231c", border: "1px solid #254033", color: "#eef6ee" },
};
