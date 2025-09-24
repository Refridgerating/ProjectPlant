import { HubInfo } from "../api/hubClient";

export function MqttDiagnostics({ info }: { info: HubInfo | null }) {
  if (!info?.mqtt_enabled) {
    return (
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-400">
        <h2 className="text-base font-semibold text-slate-200">MQTT Diagnostics</h2>
        <p className="mt-2">
          MQTT is disabled for this hub. Enable it in the backend configuration to stream live metrics.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-200">MQTT Diagnostics</h2>
          <p className="text-sm text-slate-400">Live topic monitor and broker telemetry will appear here.</p>
        </div>
        <div className="flex gap-2 text-sm text-slate-300">
          <div className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-300">
            {info.mqtt_host}:{info.mqtt_port}
          </div>
        </div>
      </div>
      <div className="mt-6 rounded-lg border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400">
        <p>Topic explorer coming soon. We will replay mocked payloads for development until devices stream live data.</p>
      </div>
    </section>
  );
}
