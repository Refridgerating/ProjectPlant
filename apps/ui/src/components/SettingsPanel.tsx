import { useCallback, useEffect, useMemo, useState } from "react";
import { getSettings, setSettings, type UiSettings, discoverServer, testRestConnection } from "../settings";
import { CollapsibleTile } from "./CollapsibleTile";

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setLocal] = useState<UiSettings>(() => getSettings());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocal(getSettings());
    setTestResult(null);
    setDiscoverMsg(null);
  }, [open]);

  const save = useCallback(() => {
    setSettings(settings);
    onClose();
  }, [settings, onClose]);

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

