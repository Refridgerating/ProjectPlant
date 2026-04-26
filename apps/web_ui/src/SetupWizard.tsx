import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { BleBridge, type BleDevice } from "@projectplant/native-bridge";
import { discoverPi, type PiDiscoveryResult } from "@projectplant/sdk";
import {
  EspBleProvisioner,
  type HubConfigResponse,
  type ProtocolInfo,
  type WiFiScanEntry,
  type WiFiStatus,
} from "@projectplant/sdk/provisioning";
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
  type ProvisionWaitResponse,
  type ProvisionedDevice,
} from "./api/provisioning";
import { getSettings, setSettings } from "./settings";

type WizardStep = "method" | "provision" | "waiting" | "success" | "timeout" | "error";
type NativeWizardStage = "discover" | "secure" | "network" | "provisioning" | "done";
type ManualWizardMethod = "fallback_wifi" | "existing_node";

const MANUAL_METHOD_OPTIONS: Array<{
  id: ManualWizardMethod;
  title: string;
  subtitle: string;
  bullets: string[];
}> = [
  {
    id: "fallback_wifi",
    title: "Fallback Wi-Fi (dev/local)",
    subtitle:
      "A factory-default node first tries credentials compiled into hardware_config.local.c or hardware_config.c before provisioning starts.",
    bullets: [
      "Add local Wi-Fi and MQTT settings to firmware/esp32_pot/main/hardware_config.local.c for local dev, or use hardware_config.c for committed defaults.",
      "Boot or flash a factory-default node. If no saved credentials exist, it will try the fallback network first.",
      "Once the node joins Wi-Fi and reaches MQTT, this wizard can confirm that the hub observed it.",
    ],
  },
  {
    id: "existing_node",
    title: "Existing provisioned node",
    subtitle: "Use this when the node already has Wi-Fi credentials stored and should reconnect after a power cycle.",
    bullets: [
      "Power on the node and leave it on the target Wi-Fi network.",
      "Wait for the node to reconnect to MQTT using its saved credentials.",
      "Start monitoring below and the hub will mark the node online when it sees a fresh state message.",
    ],
  },
];

const WAIT_OPTIONS = [
  { label: "60 seconds", value: 60 },
  { label: "90 seconds", value: 90 },
  { label: "120 seconds", value: 120 },
  { label: "180 seconds", value: 180 },
];

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function normalizeHubUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/$/, "");
  }
  if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(trimmed)) {
    return trimmed.includes(":") ? `http://${trimmed}` : `http://${trimmed}:80`;
  }
  return `http://${trimmed}`;
}

function derivePopCandidate(device: BleDevice): string {
  const name = (device.name ?? "").trim();
  const suffixMatch = name.match(/([0-9a-fA-F]{4})$/);
  if (suffixMatch) {
    return `pp-${suffixMatch[1].toLowerCase()}`;
  }
  return "pp-";
}

function isWifiStatusFailure(status: WiFiStatus | null): boolean {
  return status?.staState === 3;
}

function formatWifiState(status: WiFiStatus | null): string {
  if (!status) {
    return "Waiting for status...";
  }
  if (status.staState === 0) {
    return "Connected";
  }
  if (status.staState === 1) {
    return typeof status.attemptsRemaining === "number" && status.attemptsRemaining >= 0
      ? `Connecting (${status.attemptsRemaining} retries left)`
      : "Connecting";
  }
  if (status.staState === 2) {
    return "Disconnected";
  }
  if (status.staState === 3) {
    if (status.failReason === 0) {
      return "Connection failed: incorrect password";
    }
    if (status.failReason === 1) {
      return "Connection failed: network not found";
    }
    return "Connection failed";
  }
  return "Unknown";
}

function renderProgress(
  labels: string[],
  activeIndex: number,
  className = "mb-8 grid gap-2 sm:grid-cols-4"
) {
  return (
    <nav aria-label="wizard progress" className={className}>
      {labels.map((label, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "upcoming";
        return (
          <div
            key={label}
            className={`rounded-xl border px-4 py-3 text-sm ${
              state === "done"
                ? "border-brand-500/50 bg-brand-500/10 text-brand-200"
                : state === "active"
                  ? "border-brand-400 bg-brand-500/5 text-brand-100"
                  : "border-slate-800 bg-slate-900/40 text-slate-400"
            }`}
          >
            <span className="block text-xs uppercase tracking-wide text-slate-400">Step {index + 1}</span>
            <span className="mt-1 block font-medium">{label}</span>
          </div>
        );
      })}
    </nav>
  );
}

export default function SetupWizard() {
  if (isNativePlatform()) {
    return <NativeSetupWizard />;
  }
  return <ManualProvisioningWizard />;
}

function NativeSetupWizard() {
  const [mode, setMode] = useState<"ble" | "softap">("ble");
  return mode === "softap" ? (
    <SoftApFallbackWizard onReturnToBle={() => setMode("ble")} />
  ) : (
    <NativeBleSetupWizard onShowSoftAp={() => setMode("softap")} />
  );
}

function ManualProvisioningWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("method");
  const [method, setMethod] = useState<ManualWizardMethod>("fallback_wifi");
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

  const isDeviceIdValid = useMemo(() => !deviceCode || Boolean(normalizeDeviceId(deviceCode)), [deviceCode]);

  useEffect(() => {
    if (step !== "waiting") {
      return;
    }
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const currentMethod = useMemo(
    () => MANUAL_METHOD_OPTIONS.find((option) => option.id === method) ?? MANUAL_METHOD_OPTIONS[0],
    [method]
  );

  const beginMonitoring = async () => {
    setStep("waiting");
    setError(null);
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await waitForProvision({
        deviceId: deviceCode,
        timeoutSeconds,
        requireFresh: true,
        signal: controller.signal,
      });
      setResult(response);
      setStep(response.status === "online" ? "success" : response.status === "timeout" ? "timeout" : "error");
      if (response.status !== "online" && response.status !== "timeout") {
        setError(`Unsupported status: ${response.status}`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : String(err ?? "Unknown error"));
      setStep("error");
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <PageShell
      title="Setup Wizard"
      subtitle="Bring a ProjectPlant node onto your network, then let the hub confirm when it appears."
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
      {renderProgress(["Choose path", "Bring online", "Monitor", "Complete"], stageIndex)}
      {step === "method" ? (
        <div className="space-y-6">
          <p className="text-sm text-slate-300">
            Choose how you plan to bring the node online. This browser flow does not send credentials to the ESP32; it
            only monitors the hub and confirms when a node appears on MQTT.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {MANUAL_METHOD_OPTIONS.map((option) => {
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
          <div className="space-y-3">
            <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-100">
              <div className="flex items-start gap-3">
                <InformationCircleIcon className="mt-0.5 h-5 w-5 flex-none text-sky-200" aria-hidden="true" />
                <div>
                  <p className="font-semibold text-sky-50">BLE provisioning exists in firmware, but no companion app ships in this repo.</p>
                  <p className="mt-1 text-sky-100/80">
                    Current ESP32 builds support BLE onboarding when Bluetooth is enabled, but this repository does not
                    include a packaged iOS or Android provisioning app for the browser workflow.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-none text-amber-200" aria-hidden="true" />
                <div>
                  <p className="font-semibold text-amber-50">SoftAP browser fallback is not implemented here.</p>
                  <p className="mt-1 text-amber-100/80">
                    SoftAP is only used when Bluetooth is disabled at build time, and the current firmware does not
                    expose a browser-based provisioning portal. There is also no provisioning button re-entry flow on the
                    current hardware.
                  </p>
                </div>
              </div>
            </div>
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
      ) : null}
      {step === "provision" ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100">Bring the node online</h2>
            <p className="mt-2 text-sm text-slate-300">
              Follow these steps, then start monitoring. The hub will confirm once it sees a fresh MQTT state message
              from a node.
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
              For re-provisioning in the current recovery flow, erase the saved credentials and reboot or reflash the
              node. There is no button-triggered re-entry flow in the current hardware/firmware.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm font-medium text-slate-200">
              Device ID (optional)
              <input
                type="text"
                value={deviceCode}
                onChange={(event) => setDeviceCode(event.target.value)}
                placeholder="e.g. 24AF3C9B1D4E"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm uppercase tracking-wide text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <span className="mt-2 block text-xs font-normal text-slate-400">
                If you know the 12 digit device ID from serial logs or the hub diagnostics, enter it to narrow the
                match. Otherwise leave blank and the hub will accept the first fresh node it sees.
              </span>
              {deviceCode && !isDeviceIdValid ? (
                <span className="mt-2 block text-xs font-normal text-rose-400">
                  Enter the full 12 digit device ID (hex only) or leave blank.
                </span>
              ) : null}
            </label>
            <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm font-medium text-slate-200">
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
              <span className="mt-2 block text-xs font-normal text-slate-400">
                Most reconnects show up within 60-90 seconds. Extend the window if Wi-Fi association, MQTT auth, or a
                reboot cycle takes longer on your local network.
              </span>
            </label>
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
                isDeviceIdValid ? "bg-brand-600 text-white hover:bg-brand-500" : "bg-slate-800 text-slate-500"
              }`}
            >
              Start monitoring
            </button>
          </div>
        </div>
      ) : null}
      {step === "waiting" ? (
        <WaitingView
          description="Waiting for the hub to observe a fresh MQTT state message from a node on your network."
          elapsed={elapsed}
          timeoutSeconds={timeoutSeconds}
          deviceCode={deviceCode}
          onCancel={() => setStep("provision")}
        />
      ) : null}
      {step === "success" ? (
        <SuccessView result={result} elapsed={elapsed} onRestart={() => setStep("method")} onExit={() => navigate("/")} />
      ) : null}
      {step === "timeout" ? (
        <TimeoutView timeoutSeconds={timeoutSeconds} onRetry={() => setStep("provision")} onExit={() => navigate("/")} />
      ) : null}
      {step === "error" ? (
        <ErrorView error={error} onBack={() => setStep("provision")} onExit={() => navigate("/")} exitLabel="Exit" />
      ) : null}
    </PageShell>
  );
}

function WaitingView({
  description,
  elapsed,
  timeoutSeconds,
  deviceCode,
  onCancel,
}: {
  description: string;
  elapsed: number;
  timeoutSeconds: number;
  deviceCode: string;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-brand-500/40 bg-brand-500/10 p-6 text-brand-100">
        <div className="flex items-center gap-3">
          <ArrowPathIcon className="h-6 w-6 animate-spin" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Watching for a node to appear...</h2>
            <p className="text-sm text-brand-50/80">{description}</p>
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
          This step is a monitor only. Keep the node booting or reconnecting until it publishes its
          <span className="font-mono"> plant/&lt;id&gt;/state </span>
          message and the hub records it.
        </p>
      </div>
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SuccessView({
  result,
  elapsed,
  onRestart,
  onExit,
}: {
  result: ProvisionWaitResponse | null;
  elapsed: number;
  onRestart: () => void;
  onExit: () => void;
}) {
  const device: ProvisionedDevice | null = result?.device ?? null;
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 p-6 text-emerald-100">
        <div className="flex items-center gap-3">
          <CheckCircleIcon className="h-6 w-6" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Node is online</h2>
            <p className="text-sm text-emerald-50/80">
              The hub observed a node after {Math.round(result?.elapsed ?? elapsed)} seconds.
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
              <dd className="mt-1 text-sm text-slate-200">{formatRelative(device.last_seen)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Topic</dt>
              <dd className="mt-1 break-all font-mono text-xs text-slate-300">{device.topic}</dd>
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
          onClick={onRestart}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Monitor another node
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-brand-900/30 hover:bg-brand-500"
        >
          Return to dashboard
        </button>
      </div>
    </div>
  );
}

function TimeoutView({
  timeoutSeconds,
  onRetry,
  onExit,
}: {
  timeoutSeconds: number;
  onRetry: () => void;
  onExit: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-amber-500/50 bg-amber-500/10 p-6 text-amber-100">
        <div className="flex items-center gap-3">
          <ClockIcon className="h-6 w-6" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">No node detected within {timeoutSeconds}s</h2>
            <p className="text-sm text-amber-50/80">
              The hub did not see a fresh MQTT state message in time. The node may still be offline or pointed at the
              wrong Wi-Fi or broker.
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-200">
        <ul className="list-disc space-y-2 pl-5">
          <li>For factory-default nodes, confirm the fallback credentials in hardware_config.local.c or hardware_config.c.</li>
          <li>For already provisioned nodes, confirm they can still join the same Wi-Fi network and MQTT broker.</li>
          <li>For re-provisioning, wipe the saved credentials, reboot, and if needed reflash the node before trying again.</li>
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Return
        </button>
      </div>
    </div>
  );
}

function ErrorView({
  error,
  onBack,
  onExit,
  exitLabel,
}: {
  error: string | null;
  onBack: () => void;
  onExit: () => void;
  exitLabel: string;
}) {
  return (
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
          onClick={onBack}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          {exitLabel}
        </button>
      </div>
    </div>
  );
}

function NativeBleSetupWizard({ onShowSoftAp }: { onShowSoftAp: () => void }) {
  const navigate = useNavigate();
  const provisionerRef = useRef<EspBleProvisioner | null>(null);
  const settings = getSettings();

  const [stage, setStage] = useState<NativeWizardStage>("discover");
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<BleDevice | null>(null);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [securing, setSecuring] = useState(false);
  const [applying, setApplying] = useState(false);
  const [protocolInfo, setProtocolInfo] = useState<ProtocolInfo | null>(null);
  const [permissionHint, setPermissionHint] = useState<"location" | "bluetooth" | null>(null);
  const [pop, setPop] = useState("");
  const [networks, setNetworks] = useState<WiFiScanEntry[]>([]);
  const [loadingNetworks, setLoadingNetworks] = useState(false);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [hubUrlInput, setHubUrlInput] = useState(settings.serverBaseUrl);
  const [mqttUriInput, setMqttUriInput] = useState("");
  const [hubResponse, setHubResponse] = useState<HubConfigResponse | null>(null);
  const [wifiStatus, setWifiStatus] = useState<WiFiStatus | null>(null);
  const [connectedHubUrl, setConnectedHubUrl] = useState<string | null>(null);
  const [hubDiscovery, setHubDiscovery] = useState<PiDiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      const current = provisionerRef.current;
      if (current) {
        void current.disconnect();
      }
    };
  }, []);

  const reconnectClean = useCallback(async () => {
    const current = provisionerRef.current;
    if (current) {
      try {
        await current.disconnect();
      } catch {
        // ignore disconnect failures during device switches
      }
    }
    provisionerRef.current = null;
  }, []);

  const handleScan = useCallback(async () => {
    setError(null);
    setPermissionHint(null);
    setScanning(true);
    setStage("discover");
    setDevices([]);
    try {
      const found = await EspBleProvisioner.scanProvisioningDevices(5000);
      const sorted = [...found].sort((left, right) => (right.rssi ?? -200) - (left.rssi ?? -200));
      setDevices(sorted);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : String(scanError);
      setError(message);
      if (message.toLowerCase().includes("location")) {
        setPermissionHint("location");
      } else if (message.toLowerCase().includes("bluetooth")) {
        setPermissionHint("bluetooth");
      }
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void handleScan();
  }, [handleScan]);

  const refreshNetworks = useCallback(async () => {
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      throw new Error("Device is not connected");
    }
    setLoadingNetworks(true);
    try {
      const scanned = await provisioner.scanWifiNetworks();
      setNetworks(scanned);
      setSsid((current) => current || scanned[0]?.ssid || "");
    } finally {
      setLoadingNetworks(false);
    }
  }, []);

  const handleSelectDevice = useCallback(
    async (device: BleDevice) => {
      setError(null);
      setPermissionHint(null);
      setConnecting(true);
      try {
        await reconnectClean();
        const provisioner = new EspBleProvisioner();
        await provisioner.connect(device.id);
        provisionerRef.current = provisioner;
        setSelectedDevice(device);
        setPop((current) => current || derivePopCandidate(device));
        setProtocolInfo(await provisioner.getProtocolInfo());
        setHubResponse(null);
        setWifiStatus(null);
        setConnectedHubUrl(null);
        setHubDiscovery(null);
        setStage("secure");
      } catch (connectError) {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      } finally {
        setConnecting(false);
      }
    },
    [reconnectClean]
  );

  const handleStartSession = useCallback(async () => {
    if (!pop.trim()) {
      setError("Proof-of-possession is required");
      return;
    }
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      setError("No provisioning device connected");
      return;
    }
    setError(null);
    setSecuring(true);
    try {
      await provisioner.establishSecurity1Session(pop.trim());
      await refreshNetworks();
      setStage("network");
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setSecuring(false);
    }
  }, [pop, refreshNetworks]);

  const handleApplyConfig = useCallback(async () => {
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      setError("No provisioning device connected");
      return;
    }
    const selectedSsid = ssid.trim();
    if (!selectedSsid) {
      setError("Select or enter a Wi-Fi SSID");
      return;
    }

    setError(null);
    setApplying(true);
    setStage("provisioning");
    setHubResponse(null);
    setWifiStatus(null);
    setConnectedHubUrl(null);
    setHubDiscovery(null);

    try {
      const normalizedHubUrl = normalizeHubUrl(hubUrlInput);
      const response = await provisioner.sendHubConfig({
        hubUrl: normalizedHubUrl,
        mqttUri: mqttUriInput.trim() || undefined,
      });
      setHubResponse(response);
      await provisioner.sendWiFiConfig(selectedSsid, password);
      setPassword("");
      await provisioner.applyWiFiConfig();

      const waitResult = await provisioner.waitForWifiConnection({
        timeoutMs: 120_000,
        intervalMs: 2_500,
        onStatus: setWifiStatus,
      });

      if (!waitResult.connected) {
        const suffix = isWifiStatusFailure(waitResult.status) ? ` (${formatWifiState(waitResult.status)})` : "";
        throw new Error(`Provisioning did not complete${suffix}`);
      }

      let baseUrl = normalizedHubUrl ?? null;
      let discovery: PiDiscoveryResult | null = null;
      if (!baseUrl) {
        discovery = await discoverPi().catch(() => null);
        if (discovery) {
          baseUrl = `http://${discovery.host}:${discovery.port}`;
        }
      }

      if (baseUrl) {
        setSettings({
          ...getSettings(),
          mode: "live",
          serverBaseUrl: baseUrl,
        });
      }

      setConnectedHubUrl(baseUrl);
      setHubDiscovery(discovery);
      setStage("done");
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
      setStage("network");
    } finally {
      setApplying(false);
    }
  }, [hubUrlInput, mqttUriInput, password, ssid]);

  const progress = useMemo(() => {
    if (stage === "discover") return 0;
    if (stage === "secure") return 1;
    if (stage === "network") return 2;
    if (stage === "provisioning") return 3;
    return 4;
  }, [stage]);

  return (
    <PageShell
      title="Setup Wizard"
      subtitle="Provision an ESP32 over BLE, push Wi-Fi credentials, and switch the shared UI into live hub mode."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onShowSoftAp}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Use SoftAP instead
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      }
    >
      {renderProgress(["Find", "Secure", "Network", "Apply", "Done"], progress, "mb-8 grid gap-2 sm:grid-cols-5")}
      <div className="space-y-6">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">1. Discover provisioning device</h2>
              <p className="mt-1 text-sm text-slate-400">
                Scan for nearby `PROV_xxxx` devices and select the pot you want to onboard.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleScan()}
              disabled={scanning || connecting}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            >
              {scanning ? "Scanning..." : "Scan Again"}
            </button>
          </div>
          {devices.length === 0 && !scanning ? (
            <p className="mt-4 text-sm text-slate-400">
              No nearby provisioning devices found. Power on the pot and look for the name `PROV_xxxxxx`.
            </p>
          ) : null}
          <div className="mt-4 grid gap-3">
            {devices.map((device) => (
              <button
                key={device.id}
                type="button"
                onClick={() => void handleSelectDevice(device)}
                disabled={connecting || applying || securing}
                className={`rounded-2xl border p-4 text-left transition ${
                  selectedDevice?.id === device.id
                    ? "border-emerald-400/70 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-950/40 hover:border-emerald-500/45 hover:bg-slate-900/70"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-100">{device.name ?? "(Unnamed device)"}</div>
                    <div className="mt-1 font-mono text-xs text-slate-400">{device.id}</div>
                  </div>
                  <span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">
                    RSSI {typeof device.rssi === "number" ? device.rssi : "--"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {stage !== "discover" && selectedDevice ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">2. Secure session</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Establish the ESP Security1 session before reading or writing provisioning characteristics.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStage("discover");
                  setSelectedDevice(null);
                  setNetworks([]);
                  setSsid("");
                  setProtocolInfo(null);
                  void reconnectClean();
                }}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Disconnect
              </button>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <label className="flex flex-col gap-2 text-sm text-slate-200">
                Proof of possession
                <input
                  value={pop}
                  onChange={(event) => setPop(event.target.value)}
                  placeholder="pp-xxxx"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleStartSession()}
                disabled={securing || applying}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {securing ? "Establishing..." : "Establish Session"}
              </button>
            </div>
            <div className="mt-3 space-y-1 text-xs text-slate-400">
              <p>Use the PoP shown on your packaging or provisioning label.</p>
              {protocolInfo ? (
                <p>
                  Protocol <span className="font-semibold text-slate-200">{protocolInfo.version}</span>
                  {protocolInfo.capabilities.length ? ` · ${protocolInfo.capabilities.join(", ")}` : ""}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {(stage === "network" || stage === "provisioning" || stage === "done") && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">3. Network and hub</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Pick the target Wi-Fi, optionally attach hub settings, then send everything in one BLE session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refreshNetworks()}
                disabled={loadingNetworks || applying || stage === "done"}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
              >
                {loadingNetworks ? "Refreshing..." : "Refresh Networks"}
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm text-slate-200">
                Wi-Fi SSID
                <input
                  list="wifi-list"
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                  placeholder="Enter SSID"
                  disabled={stage === "done"}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <datalist id="wifi-list">
                  {networks.map((entry) => (
                    <option key={`${entry.ssid}-${entry.bssidHex}`} value={entry.ssid} />
                  ))}
                </datalist>
              </label>
              <label className="flex flex-col gap-2 text-sm text-slate-200">
                Wi-Fi password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Required for secured networks"
                  disabled={applying || stage === "done"}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-slate-200">
                Hub URL (optional)
                <input
                  value={hubUrlInput}
                  onChange={(event) => setHubUrlInput(event.target.value)}
                  placeholder="e.g. projectplant.local:80"
                  disabled={applying || stage === "done"}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm text-slate-200">
                MQTT URI (optional)
                <input
                  value={mqttUriInput}
                  onChange={(event) => setMqttUriInput(event.target.value)}
                  placeholder="mqtt://192.168.1.10:1883"
                  disabled={applying || stage === "done"}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </label>
            </div>
            {stage !== "done" ? (
              <button
                type="button"
                onClick={() => void handleApplyConfig()}
                disabled={applying || !ssid.trim()}
                className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {applying ? "Provisioning..." : "Apply Wi-Fi and Join Hub"}
              </button>
            ) : null}
            {(stage === "provisioning" || stage === "done") && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                <strong>Device status:</strong> {formatWifiState(wifiStatus)}
              </div>
            )}
            {hubResponse ? (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-200">
                Hub endpoint response: <strong>{hubResponse.status}</strong>
              </div>
            ) : null}
          </section>
        )}

        {stage === "done" ? (
          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-emerald-100">
            <div className="flex items-start gap-3">
              <CheckCircleIcon className="mt-1 h-6 w-6 flex-none" aria-hidden="true" />
              <div>
                <h2 className="text-lg font-semibold">Provisioning complete</h2>
                <p className="mt-2 text-sm text-emerald-50/85">
                  The pot joined Wi-Fi successfully.
                  {connectedHubUrl
                    ? ` The shared UI was pointed at ${connectedHubUrl}.`
                    : " Hub discovery did not resolve automatically; you can still enter the hub address later in Settings."}
                  {hubDiscovery ? ` Discovered via ${hubDiscovery.via}.` : ""}
                </p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => navigate("/")}
                className="rounded-lg bg-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-200"
              >
                Open Dashboard
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage("discover");
                  setDevices([]);
                  setSelectedDevice(null);
                  setNetworks([]);
                  setSsid("");
                  setProtocolInfo(null);
                  setHubResponse(null);
                  setWifiStatus(null);
                  setConnectedHubUrl(null);
                  setHubDiscovery(null);
                  setError(null);
                  setPop("");
                  void reconnectClean();
                  void handleScan();
                }}
                className="rounded-lg border border-emerald-400/30 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-500/10"
              >
                Provision Another Device
              </button>
            </div>
          </section>
        ) : null}

        {error ? (
          <section className="rounded-2xl border border-rose-500/50 bg-rose-500/10 p-4 text-sm text-rose-100">
            <strong>Error:</strong> {error}
            {permissionHint === "location" ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void BleBridge.openLocationSettings()}
                  className="rounded-lg border border-rose-300/40 px-4 py-2 text-sm text-rose-50 hover:bg-rose-500/10"
                >
                  Open Location Settings
                </button>
              </div>
            ) : null}
            {permissionHint === "bluetooth" ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void BleBridge.openBluetoothSettings()}
                  className="rounded-lg border border-rose-300/40 px-4 py-2 text-sm text-rose-50 hover:bg-rose-500/10"
                >
                  Open Bluetooth Settings
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </PageShell>
  );
}

function SoftApFallbackWizard({ onReturnToBle }: { onReturnToBle: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<"instructions" | "waiting" | "success" | "timeout" | "error">("instructions");
  const [deviceCode, setDeviceCode] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [result, setResult] = useState<ProvisionWaitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const isDeviceIdValid = useMemo(() => !deviceCode || Boolean(normalizeDeviceId(deviceCode)), [deviceCode]);

  useEffect(() => {
    if (step !== "waiting") {
      return;
    }
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const beginMonitoring = async () => {
    setStep("waiting");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await waitForProvision({
        method: "softap",
        deviceId: deviceCode,
        timeoutSeconds,
        requireFresh: true,
        signal: controller.signal,
      });
      setResult(response);
      setStep(response.status === "online" ? "success" : "timeout");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : String(err ?? "Unknown error"));
      setStep("error");
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <PageShell
      title="SoftAP Fallback"
      subtitle="Use the device access point manually, then let the shared UI confirm when the sensor appears on the hub."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReturnToBle}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Return to BLE
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      }
    >
      {step === "instructions" ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-lg font-semibold text-slate-100">SoftAP status</h2>
            <ol className="mt-4 space-y-4 text-sm text-slate-200">
              {[
                "SoftAP is only relevant on builds where Bluetooth provisioning is disabled.",
                "The current recovery flow does not ship a browser-based SoftAP portal in this repo.",
                "Use fallback Wi-Fi credentials or reflash back to a BLE-enabled build, then return here to monitor the node.",
              ].map((item, index) => (
                <li key={index} className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border border-brand-500/60 bg-brand-500/10 text-xs font-semibold text-brand-200">
                    {index + 1}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm font-medium text-slate-200">
              Device ID (optional)
              <input
                type="text"
                value={deviceCode}
                onChange={(event) => setDeviceCode(event.target.value)}
                placeholder="e.g. 24AF3C9B1D4E"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm uppercase tracking-wide text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </label>
            <label className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm font-medium text-slate-200">
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
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={onReturnToBle}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
              Back to BLE
            </button>
            <button
              type="button"
              disabled={!isDeviceIdValid}
              onClick={() => void beginMonitoring()}
              className={`rounded-lg px-4 py-2 text-sm font-medium shadow-md shadow-brand-900/20 ${
                isDeviceIdValid ? "bg-brand-600 text-white hover:bg-brand-500" : "bg-slate-800 text-slate-500"
              }`}
            >
              Start monitoring
            </button>
          </div>
        </div>
      ) : null}
      {step === "waiting" ? (
        <WaitingView
          description="Waiting for the hub to observe a freshly provisioned sensor after the SoftAP flow completes."
          elapsed={elapsed}
          timeoutSeconds={timeoutSeconds}
          deviceCode={deviceCode}
          onCancel={() => setStep("instructions")}
        />
      ) : null}
      {step === "success" ? (
        <SuccessView result={result} elapsed={elapsed} onRestart={() => setStep("instructions")} onExit={() => navigate("/")} />
      ) : null}
      {step === "timeout" ? (
        <TimeoutView timeoutSeconds={timeoutSeconds} onRetry={() => setStep("instructions")} onExit={() => navigate("/")} />
      ) : null}
      {step === "error" ? (
        <ErrorView error={error} onBack={() => setStep("instructions")} onExit={onReturnToBle} exitLabel="Return to BLE" />
      ) : null}
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
