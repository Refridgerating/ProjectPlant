import type { HubInfo } from "../api/hubClient";

type Props = {
  rest: { loading: boolean; error: string | null; data: HubInfo | null };
};

export function ConnectionBadges({ rest }: Props) {
  const restStatus = rest.loading ? "connecting" : rest.error ? "offline" : rest.data ? "ok" : "unknown";
  const mqttStatus = rest.data?.mqtt_enabled ? "enabled" : "off";
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge
        label="REST"
        status={restStatus}
        title={
          rest.loading
            ? "Connecting"
            : rest.error
            ? rest.error
            : rest.data
            ? `Connected${rest.data?.name ? ` • ${rest.data.name}` : ""}`
            : "Unknown"
        }
      />
      <Badge
        label="MQTT"
        status={mqttStatus}
        title={
          rest.data?.mqtt_enabled
            ? `Enabled • ${rest.data.mqtt_host}:${rest.data.mqtt_port}`
            : "Disabled in hub"
        }
      />
    </div>
  );
}

function Badge({ label, status, title }: { label: string; status: string; title?: string }) {
  const color =
    status === "ok"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-600/50"
      : status === "connecting"
      ? "bg-amber-500/10 text-amber-300 border-amber-600/50"
      : status === "enabled"
      ? "bg-sky-500/10 text-sky-300 border-sky-600/50"
      : status === "offline" || status === "off"
      ? "bg-rose-500/10 text-rose-300 border-rose-600/50"
      : "bg-slate-800 text-slate-300 border-slate-700";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${color}`}
      title={title || undefined}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

