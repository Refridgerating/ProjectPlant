import { HubInfo } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

export function MqttDiagnostics({ info }: { info: HubInfo | null }) {
  if (!info?.mqtt_enabled) {
    return (
      <CollapsibleTile
        id="plant-conditions-mqtt"
        title="MQTT Diagnostics"
        subtitle="MQTT is disabled for this hub."
        className="border border-dashed border-emerald-600/40 bg-[rgba(7,29,19,0.7)] p-6 text-sm text-emerald-200/70"
        bodyClassName="mt-4"
      >
        <p>Enable MQTT in the backend configuration to stream live metrics into the dashboard.</p>
      </CollapsibleTile>
    );
  }

  const brokerLabel = `${info.mqtt_host}:${info.mqtt_port}`;

  return (
    <CollapsibleTile
      id="plant-conditions-mqtt"
      title="MQTT Diagnostics"
      subtitle="Live topic monitor and broker telemetry will appear here."
      className="p-6 text-sm text-emerald-100/85"
      bodyClassName="mt-4 space-y-4"
      actions={
        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
          {brokerLabel}
        </span>
      }
    >
      <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,26,18,0.78)] p-6 text-sm text-emerald-200/70 shadow-inner shadow-emerald-950/40">
        <p>Topic explorer coming soon. We will replay mocked payloads for development until devices stream live data.</p>
      </div>
    </CollapsibleTile>
  );
}
