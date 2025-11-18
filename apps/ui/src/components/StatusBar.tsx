import { HealthStatus, HealthSummary, MqttHealth, WeatherCacheHealth } from "../api/hubClient";

type StatusBarProps = {
  summary: HealthSummary | null;
  mqtt: MqttHealth | null;
  weather: WeatherCacheHealth | null;
  loading: boolean;
  error: string | null;
  onHandleCache?: () => void;
};

type VisualStatus = HealthStatus | "loading";

const STATUS_LABELS: Record<VisualStatus, string> = {
  ok: "Healthy",
  warning: "Warning",
  critical: "Critical",
  disabled: "Disabled",
  unknown: "Unknown",
  loading: "Refreshing..."
};

const STATUS_THEME: Record<VisualStatus, { dot: string; badge: string; text: string; container: string }> = {
  ok: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-400/20 text-emerald-100 border border-emerald-500/40",
    text: "text-emerald-100",
    container: "border-emerald-500/40 bg-emerald-500/10"
  },
  warning: {
    dot: "bg-amber-400",
    badge: "bg-amber-400/20 text-amber-100 border border-amber-500/40",
    text: "text-amber-100",
    container: "border-amber-400/40 bg-amber-500/10"
  },
  critical: {
    dot: "bg-rose-400",
    badge: "bg-rose-400/20 text-rose-100 border border-rose-500/50",
    text: "text-rose-100",
    container: "border-rose-500/40 bg-rose-500/10"
  },
  disabled: {
    dot: "bg-slate-500",
    badge: "bg-slate-500/20 text-slate-100 border border-slate-500/40",
    text: "text-slate-100",
    container: "border-slate-600/40 bg-slate-600/20"
  },
  unknown: {
    dot: "bg-slate-400",
    badge: "bg-slate-500/20 text-slate-100 border border-slate-500/40",
    text: "text-slate-100",
    container: "border-slate-600/40 bg-slate-600/20"
  },
  loading: {
    dot: "bg-emerald-200 animate-pulse",
    badge: "bg-emerald-400/10 text-emerald-100 border border-emerald-500/30",
    text: "text-emerald-100",
    container: "border-emerald-500/30 bg-emerald-500/5"
  }
};

type IndicatorConfig = {
  key: string;
  label: string;
  status: VisualStatus;
  tooltip: string;
};

export function StatusBar({ summary, mqtt, weather, loading, error, onHandleCache }: StatusBarProps) {
  const indicators: IndicatorConfig[] = [
    {
      key: "hub",
      label: "Hub",
      status: loading && !summary ? "loading" : summary?.status ?? "unknown",
      tooltip: buildHubTooltip(summary)
    },
    {
      key: "mqtt",
      label: "Mosquitto",
      status: buildMqttStatus(loading, mqtt),
      tooltip: buildMqttTooltip(mqtt)
    },
    {
      key: "hrrr",
      label: "HRRR Cache",
      status: loading && !weather ? "loading" : weather?.status ?? "unknown",
      tooltip: buildWeatherTooltip(weather)
    }
  ];

  return (
    <div className="rounded-2xl border border-emerald-700/50 bg-[rgba(6,27,18,0.65)] px-4 py-3 shadow-inner shadow-emerald-950/50">
      <div className="flex flex-wrap items-center gap-3">
        {indicators.map((indicator) => {
          const theme = STATUS_THEME[indicator.status];
          if (indicator.key === "hrrr" && onHandleCache) {
            return (
              <div key={indicator.key} className="inline-flex items-center gap-2">
                <div
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${theme.container}`}
                  title={indicator.tooltip}
                >
                  <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden="true" />
                  <span className={theme.text}>{indicator.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide ${theme.badge}`}>
                    {STATUS_LABELS[indicator.status]}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onHandleCache}
                  className="rounded-lg border border-emerald-500/40 px-2 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400/70 hover:bg-emerald-500/10"
                >
                  Handle cache
                </button>
              </div>
            );
          }
          return (
            <div
              key={indicator.key}
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${theme.container}`}
              title={indicator.tooltip}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden="true" />
              <span className={theme.text}>{indicator.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide ${theme.badge}`}>
                {STATUS_LABELS[indicator.status]}
              </span>
            </div>
          );
        })}
        <div className="ml-auto text-xs text-emerald-200/70">
          {loading ? "Refreshing health data..." : error ? <span className="text-amber-200/80">{error}</span> : "Health data up to date."}
        </div>
      </div>
    </div>
  );
}

function buildHubTooltip(summary: HealthSummary | null): string {
  if (!summary) {
    return "Hub health is not available yet.";
  }
  const uptime = formatDuration(summary.uptime.seconds);
  const dbStatus = summary.database.status.toUpperCase();
  const latency = summary.database.latency_ms != null ? `${summary.database.latency_ms.toFixed(1)} ms` : "n/a";
  return `Uptime: ${uptime} - Database: ${dbStatus} (${latency})`;
}

function buildMqttStatus(loading: boolean, mqtt: MqttHealth | null): VisualStatus {
  if (loading && !mqtt) {
    return "loading";
  }
  if (!mqtt) {
    return "unknown";
  }
  if (!mqtt.enabled) {
    return "disabled";
  }
  return mqtt.status ?? "unknown";
}

function buildMqttTooltip(mqtt: MqttHealth | null): string {
  if (!mqtt) {
    return "MQTT metrics are not available.";
  }
  if (!mqtt.enabled) {
    return "MQTT broker is disabled in configuration.";
  }
  const conn = mqtt.connection;
  const status = conn?.connected ? "Connected" : "Disconnected";
  const heartbeat = mqtt.heartbeat;
  const latest = heartbeat?.latest_received_at ? `Last heartbeat ${formatRelativeTime(heartbeat.latest_received_at)}` : "No heartbeat recorded.";
  return `${status} to ${conn?.host ?? "unknown"}:${conn?.port ?? "?"} - ${latest}`;
}

function buildWeatherTooltip(weather: WeatherCacheHealth | null): string {
  if (!weather) {
    return "HRRR cache metrics are not available.";
  }
  const age = weather.age_seconds != null ? formatDuration(weather.age_seconds) : "unknown";
  const files = weather.file_count;
  return `Cached files: ${files} - Last update ${age} ago - Size ${formatBytes(weather.bytes)}`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) {
    return "unknown";
  }
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatRelativeTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  const diffMs = Date.now() - parsed.getTime();
  const diffSec = Math.round(diffMs / 1000);
  return `${formatDuration(diffSec)} ago`;
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
