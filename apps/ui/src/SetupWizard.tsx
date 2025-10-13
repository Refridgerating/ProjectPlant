import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  WifiIcon,
} from "@heroicons/react/24/outline";
import { PageShell } from "./components/PageShell";
import {
  normalizeDeviceId,
  waitForProvision,
  type ProvisionedDevice,
  type ProvisionWaitResponse,
  type ProvisioningMethod,
} from "./api/provisioning";

type WizardStep = "method" | "provision" | "waiting" | "success" | "timeout" | "error";

const METHOD_OPTIONS: Array<{
  id: ProvisioningMethod;
  title: string;
  subtitle: string;
  bullets: string[];
}> = [
  {
    id: "ble",
    title: "Bluetooth (mobile provisioning)",
    subtitle: "Use the ProjectPlant Provisioner mobile app to send Wi-Fi credentials via BLE.",
    bullets: [
      "Power on the ESP32 sensor; wait for the status LED to pulse blue.",
      "Open the ProjectPlant Provisioner app on iOS or Android.",
      "Select the device advertised as PROV_xxxx and follow the prompts to enter Wi-Fi details.",
    ],
  },
  {
    id: "softap",
    title: "SoftAP fallback",
    subtitle: "Use the device's temporary Wi-Fi access point when BLE is unavailable.",
    bullets: [
      "Hold the sensor button for ~3 seconds until the LED flashes rapidly.",
      "Connect a laptop/phone to the ProjectPlant-Setup Wi-Fi network.",
      "Browse to http://192.168.4.1 and enter the target Wi-Fi credentials.",
    ],
  },
];

const WAIT_OPTIONS = [
  { label: "60 seconds", value: 60 },
  { label: "90 seconds", value: 90 },
  { label: "120 seconds", value: 120 },
  { label: "180 seconds", value: 180 },
];

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("method");
  const [method, setMethod] = useState<ProvisioningMethod>("ble");
  const [deviceCode, setDeviceCode] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(120);
  const [result, setResult] = useState<ProvisionWaitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const stageIndex = useMemo(() => {
    switch (step) {
      case "method":
        return 0;
      case "provision":
        return 1;
      case "waiting":
        return 2;
      default:
        return 3;
    }
  }, [step]);

  const isDeviceIdValid = useMemo(() => {
    if (!deviceCode) return true;
    return Boolean(normalizeDeviceId(deviceCode));
  }, [deviceCode]);

  useEffect(() => {
    if (step !== "waiting") {
      return;
    }
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [step]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  const currentMethod = useMemo(
    () => METHOD_OPTIONS.find((option) => option.id === method) ?? METHOD_OPTIONS[0],
    [method],
  );

  const beginMonitoring = async () => {
    setStep("waiting");
    setError(null);
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await waitForProvision({
        method,
        deviceId: deviceCode,
        timeoutSeconds,
        requireFresh: true,
        signal: controller.signal,
      });
      setResult(response);
      if (response.status === "online") {
        setStep("success");
      } else if (response.status === "timeout") {
        setStep("timeout");
      } else {
        setError(`Unsupported status: ${response.status}`);
        setStep("error");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
      setError(message);
      setStep("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancelMonitoring = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setError(null);
    setStep("provision");
  };

  const resetWizard = () => {
    setStep("method");
    setDeviceCode("");
    setResult(null);
    setError(null);
    setElapsed(0);
  };

  const renderStep = () => {
    switch (step) {
      case "method":
        return renderMethodSelection();
      case "provision":
        return renderProvisionInstructions();
      case "waiting":
        return renderWaiting();
      case "success":
        return renderSuccess();
      case "timeout":
        return renderTimeout();
      case "error":
        return renderError();
      default:
        return null;
    }
  };

  const renderMethodSelection = () => (
    <div className="space-y-6">
      <p className="text-sm text-slate-300">
        Choose how you will send Wi-Fi credentials to the ESP32 plant sensor. You can switch to the fallback access point
        if Bluetooth provisioning is not available.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {METHOD_OPTIONS.map((option) => {
          const selected = option.id === method;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setMethod(option.id)}
              className={`flex h-full flex-col rounded-2xl border p-6 text-left transition ${
                selected
                  ? "border-brand-400 bg-brand-500/10 shadow-lg shadow-brand-900/30"
                  : "border-slate-800 bg-slate-900/40 hover:border-brand-500/60 hover:bg-slate-900/70"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-100">{option.title}</h3>
                  <p className="mt-1 text-sm text-slate-300">{option.subtitle}</p>
                </div>
                {selected ? <CheckCircleIcon className="h-6 w-6 text-brand-300" aria-hidden="true" /> : null}
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-300">
                {option.bullets.map((item, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <WifiIcon className="mt-0.5 h-4 w-4 flex-none text-brand-300" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Exit
        </button>
        <button
          type="button"
          onClick={() => setStep("provision")}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-brand-900/30 hover:bg-brand-500"
        >
          Continue
        </button>
      </div>
    </div>
  );

  const renderProvisionInstructions = () => (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-semibold text-slate-100">Provisioning checklist</h2>
        <p className="mt-2 text-sm text-slate-300">
          Follow these steps, then start monitoring so the hub can confirm when the sensor comes online.
        </p>
        <ol className="mt-4 space-y-4 text-sm text-slate-200">
          {currentMethod.bullets.map((item, index) => (
            <li key={index} className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border border-brand-500/60 bg-brand-500/10 text-xs font-semibold text-brand-200">
                {index + 1}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-slate-400">
          Tip: The sensor publishes its status to MQTT as soon as Wi-Fi credentials succeed. The hub listens for that
          state automatically.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <label className="text-sm font-medium text-slate-200">
            Device ID (optional)
            <input
              type="text"
              value={deviceCode}
              onChange={(event) => setDeviceCode(event.target.value)}
              placeholder="e.g. 24AF3C9B1D4E"
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm uppercase tracking-wide text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <p className="mt-2 text-xs text-slate-400">
            The provisioning app shows a 12 digit hex ID after successful pairing. Providing it lets the hub match the
            exact device.
          </p>
          {deviceCode && !isDeviceIdValid ? (
            <p className="mt-2 text-xs text-rose-400">Enter the full 12 digit device ID (hex only) or leave blank.</p>
          ) : null}
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <label className="text-sm font-medium text-slate-200">
            Monitoring timeout
            <select
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {WAIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-400">
            Provisioning typically completes within 60–90 seconds. Extend the window if Wi-Fi takes longer to associate.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setStep("method")}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          disabled={!isDeviceIdValid}
          onClick={() => void beginMonitoring()}
          className={`rounded-lg px-4 py-2 text-sm font-medium shadow-md shadow-brand-900/20 ${
            isDeviceIdValid
              ? "bg-brand-600 text-white hover:bg-brand-500"
              : "bg-slate-800 text-slate-500"
          }`}
        >
          Start monitoring
        </button>
      </div>
    </div>
  );

  const renderWaiting = () => (
    <div className="space-y-6">
      <div className="rounded-2xl border border-brand-500/40 bg-brand-500/10 p-6 text-brand-100">
        <div className="flex items-center gap-3">
          <ArrowPathIcon className="h-6 w-6 animate-spin" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Listening for the sensor...</h2>
            <p className="text-sm text-brand-50/80">
              Watching MQTT state updates for any ESP32 coming online. This page updates automatically.
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-brand-50/80">
          Elapsed {elapsed}s of {timeoutSeconds}s timeout.
        </p>
        {deviceCode ? (
          <p className="mt-2 text-xs font-mono uppercase tracking-wide text-brand-50/70">
            Target device: {normalizeDeviceId(deviceCode) ?? deviceCode}
          </p>
        ) : null}
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-200">
        <p className="flex items-start gap-2">
          <InformationCircleIcon className="mt-1 h-5 w-5 flex-none text-brand-300" aria-hidden="true" />
          Keep the provisioning app open until it reports success. The hub will mark the sensor online right after the
          ESP32 publishes its `plant/&lt;id&gt;/state` message.
        </p>
      </div>
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => cancelMonitoring()}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  const renderSuccess = () => {
    const device: ProvisionedDevice | null = result?.device ?? null;
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 p-6 text-emerald-100">
          <div className="flex items-center gap-3">
            <CheckCircleIcon className="h-6 w-6" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-semibold">Sensor is online</h2>
              <p className="text-sm text-emerald-50/80">
                MQTT reported the device as online after {Math.round(result?.elapsed ?? elapsed)} seconds.
              </p>
            </div>
          </div>
        </div>
        {device ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Device ID</dt>
                <dd className="mt-1 font-mono text-sm text-slate-100">{device.id}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Last seen</dt>
                <dd className="mt-1 text-sm text-slate-200">
                  {formatRelative(device.last_seen)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Topic</dt>
                <dd className="mt-1 font-mono text-xs text-slate-300 break-all">{device.topic}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Message source</dt>
                <dd className="mt-1 text-sm text-slate-200">
                  {device.fresh ? "Live message" : device.retained ? "Retained state" : "Unknown"}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => resetWizard()}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Provision another device
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-brand-900/30 hover:bg-brand-500"
          >
            Return to dashboard
          </button>
        </div>
      </div>
    );
  };

  const renderTimeout = () => (
    <div className="space-y-6">
      <div className="rounded-2xl border border-amber-500/50 bg-amber-500/10 p-6 text-amber-100">
        <div className="flex items-center gap-3">
          <ClockIcon className="h-6 w-6" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">No device detected within {timeoutSeconds}s</h2>
            <p className="text-sm text-amber-50/80">
              The hub did not see a new MQTT state message. Double-check that provisioning completed successfully.
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-200">
        <ul className="space-y-2 list-disc pl-5">
          <li>Verify the Wi-Fi credentials in the provisioning app.</li>
          <li>Ensure the ESP32 LED slows to a breathing pattern after credentials apply.</li>
          <li>If re-running, long-press the button to re-enter provisioning and try again.</li>
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setStep("provision")}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Return to dashboard
        </button>
      </div>
    </div>
  );

  const renderError = () => (
    <div className="space-y-6">
      <div className="rounded-2xl border border-rose-500/60 bg-rose-500/10 p-6 text-rose-100">
        <div className="flex items-center gap-3">
          <ExclamationTriangleIcon className="h-6 w-6" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Something went wrong</h2>
            <p className="text-sm text-rose-50/80">{error ?? "Unexpected error while waiting for the device."}</p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setStep("provision")}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Back to provisioning
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Exit
        </button>
      </div>
    </div>
  );

  return (
    <PageShell
      title="Setup Wizard"
      subtitle="Guide a new ProjectPlant sensor onto Wi-Fi and confirm it appears on the hub."
      actions={
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      }
    >
      <nav aria-label="wizard progress" className="mb-8 grid gap-2 sm:grid-cols-4">
        {[
          { label: "Choose method", index: 0 },
          { label: "Provision", index: 1 },
          { label: "Monitor", index: 2 },
          { label: "Complete", index: 3 },
        ].map((item) => {
          const state =
            item.index < stageIndex ? "done" : item.index === stageIndex ? "active" : "upcoming";
          return (
            <div
              key={item.index}
              className={`rounded-xl border px-4 py-3 text-sm ${
                state === "done"
                  ? "border-brand-500/50 bg-brand-500/10 text-brand-200"
                  : state === "active"
                    ? "border-brand-400 bg-brand-500/5 text-brand-100"
                    : "border-slate-800 bg-slate-900/40 text-slate-400"
              }`}
            >
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Step {item.index + 1}
              </span>
              <span className="mt-1 block font-medium">{item.label}</span>
            </div>
          );
        })}
      </nav>
      {renderStep()}
    </PageShell>
  );
}

function formatRelative(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "-";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) {
    return "just now";
  }
  if (diff < 3600) {
    const mins = Math.round(diff / 60);
    return `${mins} min${mins === 1 ? "" : "s"} ago`;
  }
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString();
}
