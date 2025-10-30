import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createShare,
  createUserAccount,
  deleteShare,
  fetchCurrentUser,
  fetchMyShares,
  fetchUsers,
  ShareRecordSummary,
  ShareRole,
  ShareStatus,
  updateShare,
  type UserAccountSummary,
} from "../api/hubClient";
import { getSettings, setSettings, type UiSettings, discoverServer, testRestConnection } from "../settings";
import { CollapsibleTile } from "./CollapsibleTile";

const SHARE_ROLE_OPTIONS: ShareRole[] = ["contractor", "viewer"];
const SHARE_STATUS_OPTIONS: ShareStatus[] = ["pending", "active", "revoked"];

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setLocal] = useState<UiSettings>(() => getSettings());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);
  const [users, setUsers] = useState<UserAccountSummary[]>([]);
  const [currentUser, setCurrentUser] = useState<UserAccountSummary | null>(null);
  const [shares, setShares] = useState<ShareRecordSummary[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [userActionMessage, setUserActionMessage] = useState<string | null>(null);
  const [userActionError, setUserActionError] = useState<string | null>(null);
  const [shareActionMessage, setShareActionMessage] = useState<string | null>(null);
  const [shareActionError, setShareActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserPasswordConfirm, setNewUserPasswordConfirm] = useState("");
  const [shareContractorId, setShareContractorId] = useState("");
  const [shareRole, setShareRole] = useState<ShareRole>("contractor");
  const [shareStatusChoice, setShareStatusChoice] = useState<ShareStatus>("pending");

  const refreshUserData = useCallback(
    async (signal?: AbortSignal) => {
      setUserLoading(true);
      setShareLoading(true);
      setUserError(null);
      setShareError(null);
      try {
        const list = await fetchUsers(signal);
        if (!signal?.aborted) {
          setUsers(list);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setUsers([]);
          setUserError(err instanceof Error ? err.message : "Failed to load users.");
        }
      }
      try {
        const me = await fetchCurrentUser(signal);
        if (!signal?.aborted) {
          setCurrentUser(me);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setCurrentUser(null);
          setUserError((prev) => prev ?? (err instanceof Error ? err.message : "Unable to load current user"));
        }
      }
      try {
        const shareList = await fetchMyShares(signal);
        if (!signal?.aborted) {
          setShares(shareList);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setShares([]);
          setShareError(err instanceof Error ? err.message : "Failed to load shares.");
        }
      }
      if (!signal?.aborted) {
        setUserLoading(false);
        setShareLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    setLocal(getSettings());
    setTestResult(null);
    setDiscoverMsg(null);
    setUserActionMessage(null);
    setUserActionError(null);
    setShareActionMessage(null);
    setShareActionError(null);
    setNewUserEmail("");
    setNewUserName("");
    setNewUserPassword("");
    setNewUserPasswordConfirm("");
    setShareContractorId("");
    const controller = new AbortController();
    void refreshUserData(controller.signal);
    return () => controller.abort();
  }, [open, refreshUserData]);

  const userNameLookup = useMemo(() => {
    const entries = users.map((user) => [
      user.id,
      user.display_name?.trim() || user.email || user.id,
    ]);
    return new Map(entries);
  }, [users]);

  const resolveUserName = useCallback(
    (userId: string) => userNameLookup.get(userId) ?? userId,
    [userNameLookup]
  );

  const save = useCallback(() => {
    setSettings(settings);
    onClose();
  }, [settings, onClose]);

  const handleActiveUserSelect = useCallback(
    (userId: string) => {
      setLocal((prev) => {
        if (!userId) {
          return { ...prev, activeUserId: "", activeUserName: "" };
        }
        const selected = users.find((user) => user.id === userId);
        const fallbackName = selected?.display_name?.trim() || selected?.email || prev.activeUserName;
        return { ...prev, activeUserId: userId, activeUserName: fallbackName };
      });
    },
    [users]
  );

  const handleCreateUser = useCallback(async () => {
    const trimmedEmail = newUserEmail.trim();
    if (!trimmedEmail) {
      setUserActionError("Email is required to create a user.");
      return;
    }
    if (newUserPassword.length < 8) {
      setUserActionError("Password must be at least 8 characters.");
      return;
    }
    if (newUserPassword !== newUserPasswordConfirm) {
      setUserActionError("Passwords do not match.");
      return;
    }
    setBusyAction(true);
    setUserActionMessage(null);
    setUserActionError(null);
    setShareActionMessage(null);
    setShareActionError(null);
    try {
      await createUserAccount({
        email: trimmedEmail,
        display_name: newUserName.trim() || undefined,
        password: newUserPassword,
        confirm_password: newUserPasswordConfirm,
      });
      setUserActionMessage(`User created. Verification email sent to ${trimmedEmail}.`);
      setNewUserEmail("");
      setNewUserName("");
      setNewUserPassword("");
      setNewUserPasswordConfirm("");
      await refreshUserData();
    } catch (err) {
      setUserActionError(err instanceof Error ? err.message : "Failed to create user.");
    } finally {
      setBusyAction(false);
    }
  }, [newUserEmail, newUserName, newUserPassword, newUserPasswordConfirm, refreshUserData]);

  const handleCreateShare = useCallback(async () => {
    const trimmedId = shareContractorId.trim();
    if (!trimmedId) {
      setShareActionError("Contractor user id is required.");
      return;
    }
    setBusyAction(true);
    setShareActionMessage(null);
    setShareActionError(null);
    try {
      await createShare({
        contractor_id: trimmedId,
        role: shareRole,
        status: shareStatusChoice,
      });
      setShareActionMessage("Share invitation created.");
      setShareContractorId("");
      setShareRole("contractor");
      setShareStatusChoice("pending");
      await refreshUserData();
    } catch (err) {
      setShareActionError(err instanceof Error ? err.message : "Failed to create share.");
    } finally {
      setBusyAction(false);
    }
  }, [shareContractorId, shareRole, shareStatusChoice, refreshUserData]);

  const handleShareStatusChange = useCallback(
    async (shareId: string, status: ShareStatus) => {
      setBusyAction(true);
      setShareActionMessage(null);
      setShareActionError(null);
      try {
        await updateShare(shareId, { status });
        const label =
          status === "active" ? "Share activated." : status === "revoked" ? "Share revoked." : "Share updated.";
        setShareActionMessage(label);
        await refreshUserData();
      } catch (err) {
        setShareActionError(err instanceof Error ? err.message : "Failed to update share.");
      } finally {
        setBusyAction(false);
      }
    },
    [refreshUserData]
  );

  const handleDeleteShare = useCallback(
    async (shareId: string) => {
      setBusyAction(true);
      setShareActionMessage(null);
      setShareActionError(null);
      try {
        await deleteShare(shareId);
        setShareActionMessage("Share removed.");
        await refreshUserData();
      } catch (err) {
        setShareActionError(err instanceof Error ? err.message : "Failed to delete share.");
      } finally {
        setBusyAction(false);
      }
    },
    [refreshUserData]
  );

  const handleDiscover = useCallback(async () => {
    setDiscovering(true);
    setDiscoverMsg("Discovering...");
    try {
      const result = await discoverServer();
      if (result) {
        const url = `http://${result.host}:${result.port}`;
        setLocal((prev) => ({ ...prev, serverBaseUrl: url }));
        setDiscoverMsg(`Found at ${url} (${result.via})`);
      } else {
        setDiscoverMsg("No server found");
      }
    } catch (err) {
      setDiscoverMsg((err as Error).message);
    } finally {
      setDiscovering(false);
    }
  }, []);

  const doTest = useCallback(async () => {
    setTesting(true);
    setTestResult("Testing...");
    try {
      const result = await testRestConnection(settings.serverBaseUrl);
      setTestResult(result.ok ? "Success" : `Failed: ${result.message}`);
    } catch (err) {
      setTestResult((err as Error).message);
    } finally {
      setTesting(false);
    }
  }, [settings.serverBaseUrl]);

  const maskedPassword = useMemo(() => (settings.mqttPassword ? "•".repeat(Math.min(settings.mqttPassword.length, 8)) : ""), [settings.mqttPassword]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/50">
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-slate-900 p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        <CollapsibleTile
          id="settings-mode"
          title="Mode"
          subtitle="Choose between demo and live operation."
          className="border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-3"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setLocal((s) => ({ ...s, mode: "demo" }))}
              className={`rounded-lg px-3 py-1 text-sm ${
                settings.mode === "demo" ? "bg-slate-800 text-slate-100 border border-slate-700" : "text-slate-300 border border-transparent hover:border-slate-700"
              }`}
            >
              Demo
            </button>
            <button
              type="button"
              onClick={() => setLocal((s) => ({ ...s, mode: "live" }))}
              className={`rounded-lg px-3 py-1 text-sm ${
                settings.mode === "live" ? "bg-slate-800 text-slate-100 border border-slate-700" : "text-slate-300 border border-transparent hover:border-slate-700"
              }`}
            >
              Live
            </button>
          </div>
          <p className="text-xs text-slate-400">Demo mode uses mocked data; live mode connects to your hub.</p>
        </CollapsibleTile>

        <CollapsibleTile
          id="settings-server"
          title="Server"
          subtitle="Edit the REST base URL and discover nearby hubs."
          className="mt-6 border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-3"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.serverBaseUrl}
              onChange={(e) => setLocal((s) => ({ ...s, serverBaseUrl: e.target.value }))}
              placeholder="http://projectplant.local:80"
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDiscover()}
              disabled={discovering}
              className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {discovering ? "Discovering..." : "Discover"}
            </button>
            <button
              type="button"
              onClick={() => void doTest()}
              disabled={testing}
              className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {testing ? "Testing..." : "Test connection"}
            </button>
            {discoverMsg ? <span className="text-xs text-slate-400">{discoverMsg}</span> : null}
            {testResult ? <span className="text-xs text-slate-400">{testResult}</span> : null}
          </div>
          <p className="text-xs text-slate-400">Discovered host/IP can be edited. Testing checks /api/v1/info.</p>
        </CollapsibleTile>

        <CollapsibleTile
          id="settings-user"
          title="Active User"
          subtitle="Select the hub user id used for authenticated requests."
          className="mt-6 border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-4"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <select
                value={settings.activeUserId}
                onChange={(event) => handleActiveUserSelect(event.target.value)}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select hub user...</option>
                {users.map((user) => {
                  const baseLabel = user.display_name?.trim() || user.email || user.id;
                  const statusLabel = user.email_verified ? "verified" : "pending";
                  return (
                    <option key={user.id} value={user.id}>
                      {baseLabel} ({statusLabel})
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                onClick={() => void refreshUserData()}
                disabled={userLoading}
                className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {userLoading ? "Refreshing..." : "Reload"}
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Header <code className="rounded bg-slate-800 px-1 py-0.5 text-[10px]">X-User-Id</code> is forwarded with hub requests.
            </p>
            {userError ? <p className="text-xs text-red-400">{userError}</p> : null}
            {currentUser ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300">
                <p className="text-slate-100">
                  <span className="font-semibold">{resolveUserName(currentUser.id)}</span>
                </p>
                <p>{currentUser.email}</p>
                <p className="text-[11px] text-slate-400">{currentUser.email_verified ? "Verified" : "Pending verification"}</p>
                <p className="text-[11px] text-slate-500">User id: {currentUser.id}</p>
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                Active user details unavailable. Ensure the id below matches a hub account.
              </p>
            )}
            <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-400" htmlFor="settings-active-user-id">
                User ID (manual override)
              </label>
              <input
                id="settings-active-user-id"
                type="text"
                value={settings.activeUserId}
                onChange={(e) => handleActiveUserSelect(e.target.value)}
                placeholder="user-demo-owner"
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-400" htmlFor="settings-active-user-name">
                Display name
              </label>
              <input
                id="settings-active-user-name"
                type="text"
                value={settings.activeUserName}
                onChange={(e) => setLocal((s) => ({ ...s, activeUserName: e.target.value }))}
                placeholder="Demo Grower"
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="border-t border-slate-800 pt-3">
              <p className="text-xs font-semibold text-slate-200">Create or invite a user</p>
              <div className="mt-2 flex flex-col gap-2">
                <input
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="person@example.com"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <input
                  type="text"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Password (min 8 characters)"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <input
                  type="password"
                  value={newUserPasswordConfirm}
                  onChange={(e) => setNewUserPasswordConfirm(e.target.value)}
                  placeholder="Confirm password"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateUser()}
                  disabled={busyAction}
                  className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  {busyAction ? "Saving..." : "Create user"}
                </button>
            </div>
            <p className="text-[11px] text-slate-500">
              New accounts receive a verification email and must confirm before accessing shared hubs.
            </p>
          </div>
          {userActionMessage ? <p className="text-xs text-emerald-400">{userActionMessage}</p> : null}
          {userActionError ? <p className="text-xs text-red-400">{userActionError}</p> : null}
          </div>
        </CollapsibleTile>

        <CollapsibleTile
          id="settings-sharing"
          title="Sharing"
          subtitle="Invite collaborators and manage contractor access."
          className="mt-6 border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-3"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          {shareError ? <p className="text-xs text-red-400">{shareError}</p> : null}
          {shareLoading ? <p className="text-xs text-slate-400">Loading shares...</p> : null}
          <div className="flex flex-col gap-3">
            {shares.length === 0 ? (
              <p className="text-xs text-slate-400">No share relationships configured.</p>
            ) : (
              shares.map((share) => (
                <div
                  key={share.id}
                  className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-200"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-semibold text-slate-100">{resolveUserName(share.contractor_id)}</p>
                      <p className="text-[11px] text-slate-400">Contractor id: {share.contractor_id}</p>
                      <p className="text-[11px] text-slate-400">Owner: {resolveUserName(share.owner_id)}</p>
                      <p className="text-[11px] text-slate-400 capitalize">Role: {share.role}</p>
                      <p className="text-[11px] text-slate-400 capitalize">
                        Status: {share.status} - You are {share.participant_role}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => void handleShareStatusChange(share.id, "active")}
                        disabled={busyAction || share.status === "active"}
                        className="rounded border border-emerald-500 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                      >
                        Activate
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleShareStatusChange(share.id, "revoked")}
                        disabled={busyAction || share.status === "revoked"}
                        className="rounded border border-amber-500 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
                      >
                        Revoke
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteShare(share.id)}
                        disabled={busyAction}
                        className="rounded border border-red-500 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="border-t border-slate-800 pt-3">
            <p className="text-xs font-semibold text-slate-200">Invite collaborator</p>
            <div className="mt-2 flex flex-col gap-2">
              <input
                type="text"
                value={shareContractorId}
                onChange={(e) => setShareContractorId(e.target.value)}
                placeholder="Contractor user id"
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <div className="flex gap-2">
                <select
                  value={shareRole}
                  onChange={(e) => setShareRole(e.target.value as ShareRole)}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {SHARE_ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>
                      Role: {role}
                    </option>
                  ))}
                </select>
                <select
                  value={shareStatusChoice}
                  onChange={(e) => setShareStatusChoice(e.target.value as ShareStatus)}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {SHARE_STATUS_OPTIONS.map((statusOption) => (
                    <option key={statusOption} value={statusOption}>
                      Status: {statusOption}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => void handleCreateShare()}
                disabled={busyAction}
                className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {busyAction ? "Saving..." : "Send invite"}
              </button>
            </div>
          </div>
          {shareActionMessage ? <p className="text-xs text-emerald-400">{shareActionMessage}</p> : null}
          {shareActionError ? <p className="text-xs text-red-400">{shareActionError}</p> : null}
        </CollapsibleTile>

        <CollapsibleTile
          id="settings-mqtt"
          title="MQTT Credentials"
          subtitle="Stored locally; update when your broker credentials change."
          className="mt-6 border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-3"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          <div className="flex flex-col gap-2">
            <label className="text-xs text-slate-400">Username</label>
            <input
              type="text"
              value={settings.mqttUsername}
              onChange={(e) => setLocal((s) => ({ ...s, mqttUsername: e.target.value }))}
              placeholder="username"
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <label className="text-xs text-slate-400">Password</label>
            <input
              type="password"
              value={settings.mqttPassword}
              onChange={(e) => setLocal((s) => ({ ...s, mqttPassword: e.target.value }))}
              placeholder={maskedPassword || "password"}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <p className="text-xs text-slate-400">Values are stored locally and masked.</p>
        </CollapsibleTile>

        <CollapsibleTile
          id="settings-setup"
          title="Setup"
          subtitle="Relaunch the provisioning wizard."
          className="mt-6 border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300"
          bodyClassName="mt-3 space-y-3"
          titleClassName="text-sm font-semibold text-slate-200"
          subtitleClassName="text-xs text-slate-400"
        >
          <button
            type="button"
            onClick={() => {
              try {
                window.location.assign("/setup");
              } catch {
                // ignore
              }
            }}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Re-run setup wizard
          </button>
          <p className="text-xs text-slate-400">Opens the provisioning wizard (if available).</p>
        </CollapsibleTile>

        <div className="mt-8 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save()}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

