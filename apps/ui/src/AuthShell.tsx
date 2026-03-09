import { useCallback, useEffect, useState } from "react";

import {
  fetchHubInfo,
  fetchManagedEffectiveAccess,
  type AppleSignInResponse,
  type GoogleSignInResponse,
  type LocalSignInResponse,
} from "./api/hubClient";
import App from "./App";
import { LoginPage } from "./components/LoginPage";
import { getAuthTokenSync, getSettings, setSettings, type UiSettings } from "./settings";

type AuthSession = LocalSignInResponse | GoogleSignInResponse | AppleSignInResponse;

const SETTINGS_CHANGED_EVENT = "projectplant:settings-changed";
const LOGIN_PROMPT_DISMISSED_KEY = "projectplant:login-prompt:dismissed";

function hasSession(): boolean {
  const token = getAuthTokenSync();
  const settings = getSettings();
  return Boolean(token && settings.activeUserId.trim());
}

function clearSessionSettings(current: UiSettings): UiSettings {
  return {
    ...current,
    authToken: "",
    authTokenExpiresAt: null,
    activeUserId: "",
    activeUserName: "",
    mfaSatisfied: false,
    effectiveAccess: null,
  };
}

function fleetConsoleUrlFromControlPlane(controlPlaneUrl: string): string {
  return controlPlaneUrl.trim().replace(/\/$/, "");
}

function getPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(LOGIN_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setPromptDismissed(value: boolean): void {
  try {
    if (value) {
      window.localStorage.setItem(LOGIN_PROMPT_DISMISSED_KEY, "1");
    } else {
      window.localStorage.removeItem(LOGIN_PROMPT_DISMISSED_KEY);
    }
  } catch {
    // ignore local storage write failures
  }
}

export function AuthShell() {
  const [authenticated, setAuthenticated] = useState(() => hasSession());
  const [showPrompt, setShowPrompt] = useState(() => !hasSession() && !getPromptDismissed());
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authMode, setAuthMode] = useState(() => getSettings().authMode || "local_compat");

  const syncHubAuthMode = useCallback(async () => {
    try {
      const info = await fetchHubInfo();
      const current = getSettings();
      const nextMode = info.authMode?.trim() || "local_compat";
      const nextControlPlaneUrl = info.controlPlaneUrl?.trim() ?? "";
      setSettings({
        ...current,
        authMode: nextMode,
        controlPlaneUrl: nextControlPlaneUrl,
        fleetConsoleUrl: nextControlPlaneUrl ? fleetConsoleUrlFromControlPlane(nextControlPlaneUrl) : current.fleetConsoleUrl,
      });
      setAuthMode(nextMode);
    } catch {
      setAuthMode(getSettings().authMode || "local_compat");
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    const current = getSettings();
    setAuthMode(current.authMode || "local_compat");
    if (!hasSession()) {
      setAuthenticated(false);
      return;
    }
    if (current.authMode !== "managed") {
      setAuthenticated(true);
      return;
    }
    try {
      const effectiveAccess = await fetchManagedEffectiveAccess();
      setSettings({
        ...current,
        effectiveAccess,
        mfaSatisfied: effectiveAccess.mfaSatisfied,
      });
      setAuthenticated(true);
    } catch {
      setSettings(clearSessionSettings(current));
      setAuthenticated(false);
    }
  }, []);

  const openLogin = useCallback(() => {
    setShowPrompt(false);
    setShowLoginModal(true);
    setPromptDismissed(false);
  }, []);

  const dismissPrompt = useCallback(() => {
    setShowPrompt(false);
    setShowLoginModal(false);
    setPromptDismissed(true);
  }, []);

  const handleAuthenticated = useCallback(
    (session: AuthSession) => {
      const current = getSettings();
      const next: UiSettings = {
        ...current,
        activeUserId: session.user.id,
        activeUserName: session.user.display_name?.trim() || session.user.email,
        authToken: session.access_token,
        authTokenExpiresAt: Date.now() + session.expires_in * 1000,
        effectiveAccess: "effective_access" in session ? (session.effective_access ?? null) : current.effectiveAccess,
        mfaSatisfied:
          "effective_access" in session && session.effective_access
            ? session.effective_access.mfaSatisfied
            : current.mfaSatisfied,
      };
      setSettings(next);
      setAuthMode(next.authMode || "local_compat");
      setPromptDismissed(false);
      setShowPrompt(false);
      setShowLoginModal(false);
      void refreshAuth();
    },
    [refreshAuth]
  );

  useEffect(() => {
    void syncHubAuthMode();
  }, [syncHubAuthMode]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "projectplant:ui:settings") {
        void refreshAuth();
      }
    };
    const handleSettingsChanged = () => void refreshAuth();
    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    };
  }, [refreshAuth]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (authenticated) {
      setShowPrompt(false);
      setShowLoginModal(false);
      return;
    }
    if (!showLoginModal && !getPromptDismissed()) {
      setShowPrompt(true);
    }
  }, [authenticated, showLoginModal]);

  return (
    <>
      <App />
      {!authenticated && showPrompt ? (
        <div className="fixed inset-0 z-[1150] flex items-start justify-center bg-slate-900/40 px-4 pt-20 backdrop-blur-[1px]">
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-950 p-6 text-slate-100 shadow-2xl">
            <h2 className="text-xl font-semibold text-white">Sign in to save your nodes and settings</h2>
            <p className="mt-2 text-sm text-slate-300">
              Continue with Google, Apple, or your ProjectPlant credentials to keep preferences synced across devices.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={openLogin}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
              >
                Log in or create account
              </button>
              <button
                type="button"
                onClick={dismissPrompt}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Continue without login
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!authenticated && showLoginModal ? (
        <LoginPage
          mode="modal"
          authMode={authMode}
          onCancel={() => {
            setShowLoginModal(false);
            setShowPrompt(true);
          }}
          onAuthenticated={handleAuthenticated}
        />
      ) : null}
      {!authenticated && !showPrompt && !showLoginModal ? (
        <button
          type="button"
          onClick={openLogin}
          className="fixed bottom-5 right-5 z-[1100] rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-100 shadow-lg transition hover:bg-slate-800"
        >
          Log in
        </button>
      ) : null}
    </>
  );
}
