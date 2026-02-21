import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AppleSignInResponse,
  type GoogleSignInResponse,
  type LocalSignInResponse,
  signInWithAppleIdToken,
  signInWithGoogleIdToken,
  signInWithLocalCredentials,
} from "../api/hubClient";

const GOOGLE_SCRIPT_ID = "projectplant-google-gsi-script-login";
const APPLE_SCRIPT_ID = "projectplant-apple-auth-script-login";

type AuthSession = LocalSignInResponse | GoogleSignInResponse | AppleSignInResponse;

type GoogleCredentialResponse = {
  credential: string;
};

type GoogleAccountsId = {
  initialize: (options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (
    parent: HTMLElement,
    options: {
      type?: string;
      theme?: string;
      size?: string;
      text?: string;
      shape?: string;
      width?: number;
      logo_alignment?: string;
    }
  ) => void;
};

type WindowWithGoogle = Window & {
  google?: {
    accounts: {
      id: GoogleAccountsId;
    };
  };
};

type AppleSignInPayload = {
  authorization?: {
    id_token?: string;
  };
};

type AppleAuthApi = {
  init: (options: {
    clientId: string;
    scope?: string;
    redirectURI: string;
    state?: string;
    nonce?: string;
    usePopup?: boolean;
    responseType?: string;
    responseMode?: string;
  }) => void;
  signIn: () => Promise<AppleSignInPayload>;
};

type WindowWithApple = Window & {
  AppleID?: {
    auth: AppleAuthApi;
  };
};

function randomToken(): string {
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return Math.random().toString(16).slice(2);
  }
}

function providerLabel(session: AuthSession): string {
  if (session.user.auth_provider === "local") {
    return "email/password";
  }
  if (session.user.auth_provider === "google") {
    return "Google";
  }
  if (session.user.auth_provider === "apple") {
    return "Apple";
  }
  return "account";
}

type LoginPageMode = "page" | "modal";

type LoginPageProps = {
  onAuthenticated: (session: AuthSession) => void;
  mode?: LoginPageMode;
  onCancel?: () => void;
};

export function LoginPage({ onAuthenticated, mode = "page", onCancel }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const googleClientId = useMemo(() => {
    const raw = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "") as string;
    return raw.trim();
  }, []);
  const appleClientId = useMemo(() => {
    const raw = (import.meta.env.VITE_APPLE_CLIENT_ID ?? "") as string;
    return raw.trim();
  }, []);
  const appleRedirectUri = useMemo(() => {
    const raw = (import.meta.env.VITE_APPLE_REDIRECT_URI ?? "") as string;
    return raw.trim();
  }, []);

  const completeSignIn = useCallback(
    (session: AuthSession) => {
      setError(null);
      setMessage(`Signed in with ${providerLabel(session)} as ${session.user.display_name || session.user.email}.`);
      onAuthenticated(session);
    },
    [onAuthenticated]
  );

  const handleGoogleCredential = useCallback(
    async (idToken: string) => {
      const token = idToken.trim();
      if (!token) {
        setError("Google token missing from sign-in response.");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const session = await signInWithGoogleIdToken(token);
        completeSignIn(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Google sign-in failed.");
      } finally {
        setBusy(false);
      }
    },
    [completeSignIn]
  );

  const handleAppleSignIn = useCallback(async () => {
    if (!appleClientId) {
      setError("Apple sign-in is not configured in this UI (missing VITE_APPLE_CLIENT_ID).");
      return;
    }
    const apple = (window as WindowWithApple).AppleID;
    if (!apple?.auth) {
      setError("Apple sign-in script is not available.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const redirectUri = appleRedirectUri || `${window.location.origin}/auth/apple/callback`;
      apple.auth.init({
        clientId: appleClientId,
        scope: "name email",
        redirectURI: redirectUri,
        state: randomToken(),
        nonce: randomToken(),
        usePopup: true,
        responseType: "code id_token",
        responseMode: "fragment",
      });
      const response = await apple.auth.signIn();
      const idToken = response.authorization?.id_token?.trim() ?? "";
      if (!idToken) {
        throw new Error("Apple sign-in did not return an ID token.");
      }
      const session = await signInWithAppleIdToken(idToken);
      completeSignIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apple sign-in failed.");
    } finally {
      setBusy(false);
    }
  }, [appleClientId, appleRedirectUri, completeSignIn]);

  const handleEmailContinue = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!email.trim()) {
        setError("Email address is required.");
        return;
      }
      if (!password.trim()) {
        setError("Password is required.");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const session = await signInWithLocalCredentials(email, password);
        completeSignIn(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Email sign-in failed.");
      } finally {
        setBusy(false);
      }
    },
    [completeSignIn, email, password]
  );

  useEffect(() => {
    if (!googleClientId) {
      setGoogleReady(false);
      return;
    }
    if ((window as WindowWithGoogle).google?.accounts?.id) {
      setGoogleReady(true);
      return;
    }
    setGoogleReady(false);

    const handleLoad = () => setGoogleReady(true);
    const handleError = () => {
      setGoogleReady(false);
      setError("Failed to load Google sign-in script.");
    };
    const existing = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", handleLoad);
      existing.addEventListener("error", handleError);
      return () => {
        existing.removeEventListener("load", handleLoad);
        existing.removeEventListener("error", handleError);
      };
    }

    const script = document.createElement("script");
    script.id = GOOGLE_SCRIPT_ID;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    document.head.appendChild(script);
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, [googleClientId]);

  useEffect(() => {
    if (!googleClientId || !googleReady || !googleButtonRef.current) {
      return;
    }
    const google = (window as WindowWithGoogle).google;
    if (!google?.accounts?.id) {
      return;
    }
    const host = googleButtonRef.current;
    host.innerHTML = "";
    google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response: GoogleCredentialResponse) => {
        void handleGoogleCredential(response.credential);
      },
      cancel_on_tap_outside: true,
    });
    google.accounts.id.renderButton(host, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      width: 360,
      logo_alignment: "left",
    });
  }, [googleClientId, googleReady, handleGoogleCredential]);

  useEffect(() => {
    if (!appleClientId) {
      setAppleReady(false);
      return;
    }
    if ((window as WindowWithApple).AppleID?.auth) {
      setAppleReady(true);
      return;
    }
    setAppleReady(false);

    const handleLoad = () => setAppleReady(true);
    const handleError = () => {
      setAppleReady(false);
      setError("Failed to load Apple sign-in script.");
    };
    const existing = document.getElementById(APPLE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", handleLoad);
      existing.addEventListener("error", handleError);
      return () => {
        existing.removeEventListener("load", handleLoad);
        existing.removeEventListener("error", handleError);
      };
    }

    const script = document.createElement("script");
    script.id = APPLE_SCRIPT_ID;
    script.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    document.head.appendChild(script);
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, [appleClientId]);

  const card = (
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-neutral-300 bg-white p-8 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold tracking-[0.2em] text-slate-500">PROJECTPLANT</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900">Log in or create an account</h1>
        </div>
        {mode === "modal" && onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-100"
          >
            Not now
          </button>
        ) : null}
      </div>

      <form className="mt-8 space-y-4" onSubmit={(event) => void handleEmailContinue(event)}>
        <label className="block text-base font-semibold text-slate-900" htmlFor="auth-email">
          Email address
        </label>
        <input
          id="auth-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="w-full rounded-lg border border-slate-400 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
        <label className="block text-base font-semibold text-slate-900" htmlFor="auth-password">
          Password
        </label>
        <input
          id="auth-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter your password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-slate-400 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-slate-950 px-4 py-3 text-lg font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Continue with Email
        </button>
        <p className="text-xs text-slate-500">
          Debug master account: <code>grower@example.com</code> / <code>demo-owner-password</code>
        </p>
      </form>

      <div className="my-8 flex items-center gap-3 text-sm text-slate-500">
        <div className="h-px flex-1 bg-slate-300" />
        <span>or</span>
        <div className="h-px flex-1 bg-slate-300" />
      </div>

      <div className="space-y-3">
        <div className="min-h-[44px]">
          {googleClientId ? (
            <div ref={googleButtonRef} />
          ) : (
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed rounded-lg border border-slate-300 px-4 py-3 text-base font-semibold text-slate-400"
            >
              Continue with Google (not configured)
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleAppleSignIn()}
          disabled={busy || !appleClientId || !appleReady}
          className="w-full rounded-lg border border-slate-400 bg-white px-4 py-3 text-base font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Continue with Apple
        </button>
      </div>

      {busy ? <p className="mt-4 text-sm text-slate-500">Signing in...</p> : null}
      {message ? <p className="mt-4 text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}

      <p className="mt-8 text-center text-xs text-slate-500">
        By continuing, you agree to the Terms of Service and Privacy Policy.
      </p>
    </div>
  );

  if (mode === "modal") {
    return (
      <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-900/55 px-4 py-6 backdrop-blur-[1px]">
        {card}
      </div>
    );
  }
  return <div className="min-h-screen bg-neutral-100 px-4 py-10 text-slate-900">{card}</div>;
}
