import { HubInfo } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

const statusColors = {
  enabled: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  disabled: "bg-rose-500/10 text-rose-300 border-rose-500/30",
};

type StatusCardProps = {
  info: HubInfo;
};

export function StatusCard({ info }: StatusCardProps) {
  const mqttState = info.mqtt_enabled ? "enabled" : "disabled";

  return (
    <CollapsibleTile
      id="plant-conditions-status"
      title="System Status"
      subtitle={`Hub ${info.name}`}
      className="border border-slate-800 bg-slate-900/60 p-6"
      bodyClassName="mt-4 grid gap-6 md:grid-cols-3"
      titleClassName="text-base font-semibold text-slate-200"
      subtitleClassName="text-xs text-slate-400"
    >
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="text-sm font-medium text-slate-400">Hub Release</h2>
        <p className="mt-2 text-2xl font-semibold text-slate-100">{info.version}</p>
        <p className="mt-1 text-sm text-slate-400">{info.name}</p>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="text-sm font-medium text-slate-400">Debug Mode</h2>
        <p className="mt-2 text-2xl font-semibold">{info.debug ? "Enabled" : "Disabled"}</p>
        <p className="mt-1 text-sm text-slate-400">
          {info.debug ? "Verbose logging and hot reload enabled." : "Running in production mode."}
        </p>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="text-sm font-medium text-slate-400">MQTT Connection</h2>
        <span
          className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${statusColors[mqttState]}`}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
          {info.mqtt_enabled ? "Connected" : "Disabled"}
        </span>
        <p className="mt-3 text-sm text-slate-400">
          {info.mqtt_enabled ? `Broker ${info.mqtt_host}:${info.mqtt_port}` : "Enable MQTT in the hub settings."}
        </p>
      </div>
    </CollapsibleTile>
  );
}
