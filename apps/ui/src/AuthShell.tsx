import { useCallback, useEffect, useState } from "react";

import type { AppleSignInResponse, GoogleSignInResponse, LocalSignInResponse } from "./api/hubClient";
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

  const refreshAuth = useCallback(() => {
    setAuthenticated(hasSession());
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
      };
      setSettings(next);
      setPromptDismissed(false);
      setShowPrompt(false);
      setShowLoginModal(false);
      refreshAuth();
    },
    [refreshAuth]
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "projectplant:ui:settings") {
        refreshAuth();
      }
    };
    const handleSettingsChanged = () => refreshAuth();
    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    };
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
