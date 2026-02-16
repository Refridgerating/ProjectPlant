import { FormEvent, useEffect, useState } from "react";

import type { DeviceIdentity } from "../state/eventStore";

type DeviceNamingPromptProps = {
  device: DeviceIdentity;
  onSubmit: (name: string) => Promise<void>;
  onDismiss: () => void;
};

export function DeviceNamingPrompt({ device, onSubmit, onDismiss }: DeviceNamingPromptProps) {
  const [name, setName] = useState(device.deviceName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(device.deviceName ?? "");
    setError(null);
  }, [device.potId, device.deviceName]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a display name to continue.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update device name.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onDismiss} aria-hidden="true" />
      <div className="relative z-50 w-full max-w-md rounded-2xl border border-emerald-700/50 bg-[rgba(7,31,21,0.95)] p-6 shadow-2xl shadow-emerald-900/60">
        <div className="mb-4">
          <p className="text-xs uppercase tracking-wide text-emerald-300/70">New Device</p>
          <h3 className="text-lg font-semibold text-emerald-50">Name your smart pot</h3>
          <p className="mt-2 text-sm text-emerald-200/70">
            Give {device.potId} a friendly name so it shows up clearly across the dashboard.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="flex flex-col gap-2 text-sm text-emerald-200/80">
            Display name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Kitchen Basil"
              className="rounded-lg border border-emerald-700/50 bg-[rgba(6,24,16,0.85)] px-3 py-2 text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
              maxLength={32}
              disabled={saving}
            />
          </label>
          {error ? <p className="text-xs text-rose-200">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs font-semibold text-emerald-200/80 transition hover:text-emerald-100"
              disabled={saving}
            >
              Not now
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/60 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:border-emerald-400 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save name"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
