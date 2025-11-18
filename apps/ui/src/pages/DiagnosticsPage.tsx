import { useMemo, useState } from "react";
import {
  AlertEvent,
  HealthStatus,
  HealthSummary,
  MqttHealth,
  StorageHealth,
  WeatherCacheHealth
} from "../api/hubClient";

type DiagnosticsPageProps = {
  summary: HealthSummary | null;
  mqtt: MqttHealth | null;
  weather: WeatherCacheHealth | null;
  storage: StorageHealth | null;
  events: AlertEvent[];
  eventsCount: number;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

export function DiagnosticsPage({
  summary,
  mqtt,
  weather,
  storage,
  events,
  eventsCount,
  loading,
  error,
  onRefresh
}: DiagnosticsPageProps) {
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      const severity = event.severity?.toLowerCase() ?? "info";
      if (severityFilter !== "all" && severity !== severityFilter) {
        return false;
      }
      if (!search.trim()) {
        return true;
      }
      const needle = search.trim().toLowerCase();
      return (
        event.message.toLowerCase().includes(needle) ||
        event.event_type.toLowerCase().includes(needle) ||
        (event.detail ? event.detail.toLowerCase().includes(needle) : false)
      );
    });
  }, [events, severityFilter, search]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-emerald-50">Edge Diagnostics</h2>
          <p className="text-sm text-emerald-200/70">
            Inspect health signals, broker connectivity, and recent alerts from edge services.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-[rgba(8,36,24,0.8)] px-3 py-1.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-[rgba(12,52,32,0.85)]"
        >
          Refresh Diagnostics
        </button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-emerald-700/40 bg-[rgba(6,30,20,0.75)] px-4 py-3 text-sm text-emerald-100">
          Refreshing diagnostics...
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-amber-500/40 bg-[rgba(50,32,12,0.85)] px-4 py-3 text-amber-100 shadow-inner shadow-amber-900/40">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <DiagnosticCard
          title="Hub"
          status={summary?.status ?? "unknown"}
          lines={[
            { label: "Uptime", value: formatDuration(summary?.uptime.seconds) },
            {
              label: "Database",
              value: `${summary?.database.status.toUpperCase() ?? "UNKNOWN"} - ${summary?.database.latency_ms?.toFixed(1) ?? "?"} ms`
            },
            { label: "Path", value: summary?.database.path ?? "n/a" }
          ]}
        />
        <DiagnosticCard
          title="Mosquitto"
          status={mqttStatus(mqtt)}
          lines={[
            {
              label: "Connection",
              value: mqttConnectionSummary(mqtt)
            },
            {
              label: "Heartbeats",
              value: mqtt?.heartbeat ? `${mqtt.heartbeat.count} pots (${mqtt.heartbeat.status.toUpperCase()})` : "n/a"
            },
            {
              label: "Latest heartbeat",
              value: mqtt?.heartbeat?.latest_received_at ? formatRelative(mqtt.heartbeat.latest_received_at) : "never"
            }
          ]}
        />
        <DiagnosticCard
          title="HRRR Cache"
          status={weather?.status ?? "unknown"}
          lines={[
            { label: "Files", value: weather ? weather.file_count.toString() : "0" },
            { label: "Size", value: formatBytes(weather?.bytes ?? 0) },
            {
              label: "Last update",
              value: weather?.latest_modified ? formatRelative(weather.latest_modified) : "never"
            }
          ]}
        />
        <DiagnosticCard
          title="Storage"
          status={storage?.status ?? "unknown"}
          lines={[
            { label: "Path", value: storage?.path_checked ?? "n/a" },
            {
              label: "Free",
              value: storage ? `${storage.free_percent.toFixed(1)}% (${formatBytes(storage.free_bytes)})` : "n/a"
            },
            {
              label: "Used",
              value: storage ? `${storage.used_percent.toFixed(1)}% (${formatBytes(storage.used_bytes)})` : "n/a"
            }
          ]}
        />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-emerald-200/80">
            <span className="font-semibold text-emerald-100">Recent alerts</span>
            <span className="rounded-full border border-emerald-500/30 bg-[rgba(8,36,24,0.6)] px-2 py-0.5 text-xs font-semibold text-emerald-100/80">
              {filteredEvents.length} of {eventsCount}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-emerald-200/70">
            <label className="flex items-center gap-1">
              <span>Severity</span>
              <select
                value={severityFilter}
                onChange={(event) => setSeverityFilter(event.target.value)}
                className="rounded-lg bg-[rgba(9,36,23,0.85)] px-2 py-1 text-emerald-100 outline-none ring-emerald-500/40 focus:ring"
              >
                <option value="all">All</option>
                <option value="critical">Critical</option>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span>Search</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="message or event type"
                className="w-44 rounded-lg bg-[rgba(9,36,23,0.85)] px-2 py-1 text-emerald-100 placeholder:text-emerald-300/40 outline-none ring-emerald-500/40 focus:ring"
              />
            </label>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-emerald-700/40 bg-[rgba(6,27,18,0.65)] shadow-inner shadow-emerald-950/40">
          {filteredEvents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-emerald-200/70">No events match the selected filters.</div>
          ) : (
            <ul className="divide-y divide-emerald-900/40">
              {filteredEvents.map((event, index) => (
                <li key={`${event.timestamp}-${event.event_type}-${index}`} className="px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-emerald-50">{event.message}</p>
                      <p className="text-xs text-emerald-200/60">
                        {formatAbsolute(event.timestamp)} - {event.event_type}
                      </p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${severityBadge(event.severity)}`}>
                      {event.severity.toUpperCase()}
                    </span>
                  </div>
                  {event.detail ? (
                    <p className="mt-2 text-xs text-emerald-200/70 whitespace-pre-wrap break-words">{event.detail}</p>
                  ) : null}
                  {event.context && Object.keys(event.context).length ? (
                    <div className="mt-2 text-[0.7rem] text-emerald-200/50">
                      {Object.entries(event.context)
                        .map(([key, value]) => `${key}=${String(value)}`)
                        .join(" - ")}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

type DiagnosticCardProps = {
  title: string;
  status: HealthStatus | "loading";
  lines: { label: string; value: string }[];
};

function DiagnosticCard({ title, status, lines }: DiagnosticCardProps) {
  const theme = STATUS_CARD_THEME[status] ?? STATUS_CARD_THEME.unknown;
  return (
    <div className={`rounded-2xl border p-4 shadow-inner ${theme.container}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-emerald-50">{title}</h3>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${theme.badge}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden="true" />
          {STATUS_LABELS[status] ?? status.toUpperCase()}
        </span>
      </div>
      <dl className="mt-3 space-y-2 text-sm text-emerald-200/80">
        {lines.map((line) => (
          <div key={line.label} className="flex items-center justify-between gap-2">
            <dt className="text-emerald-200/60">{line.label}</dt>
            <dd className="text-right text-emerald-100">{line.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  ok: "Healthy",
  warning: "Warning",
  critical: "Critical",
  disabled: "Disabled",
  unknown: "Unknown",
  loading: "Refreshing..."
};

const STATUS_CARD_THEME: Record<string, { container: string; dot: string; badge: string }> = {
  ok: {
    container: "border-emerald-500/40 bg-[rgba(8,36,24,0.78)]",
    dot: "bg-emerald-400",
    badge: "border border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
  },
  warning: {
    container: "border-amber-500/40 bg-[rgba(47,33,9,0.78)]",
    dot: "bg-amber-400",
    badge: "border border-amber-500/40 bg-amber-500/10 text-amber-100"
  },
  critical: {
    container: "border-rose-500/40 bg-[rgba(48,18,22,0.8)]",
    dot: "bg-rose-400",
    badge: "border border-rose-500/40 bg-rose-500/10 text-rose-100"
  },
  disabled: {
    container: "border-slate-600/40 bg-[rgba(24,30,33,0.8)]",
    dot: "bg-slate-400",
    badge: "border border-slate-500/40 bg-slate-500/10 text-slate-100"
  },
  unknown: {
    container: "border-slate-600/40 bg-[rgba(18,26,24,0.8)]",
    dot: "bg-slate-400",
    badge: "border border-slate-500/40 bg-slate-500/10 text-slate-100"
  },
  loading: {
    container: "border-emerald-500/30 bg-[rgba(8,36,24,0.6)]",
    dot: "bg-emerald-200 animate-pulse",
    badge: "border border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
  }
};

function mqttStatus(mqtt: MqttHealth | null): HealthStatus | "loading" {
  if (!mqtt) {
    return "unknown";
  }
  if (!mqtt.enabled) {
    return "disabled";
  }
  return mqtt.status ?? "unknown";
}

function mqttConnectionSummary(mqtt: MqttHealth | null): string {
  if (!mqtt) {
    return "unavailable";
  }
  if (!mqtt.enabled) {
    return "disabled";
  }
  const connection = mqtt.connection;
  if (!connection) {
    return "manager unavailable";
  }
  return connection.connected ? `Connected (${connection.host}:${connection.port})` : `Disconnected (${connection.host}:${connection.port})`;
}

function severityBadge(severity: string): string {
  const normalized = severity.toLowerCase();
  switch (normalized) {
    case "critical":
      return "bg-rose-500/20 text-rose-100 border border-rose-500/40";
    case "error":
      return "bg-rose-500/15 text-rose-100 border border-rose-500/30";
    case "warning":
      return "bg-amber-500/15 text-amber-100 border border-amber-500/30";
    case "info":
      return "bg-sky-500/15 text-sky-100 border border-sky-500/30";
    case "success":
      return "bg-emerald-500/15 text-emerald-100 border border-emerald-500/30";
    default:
      return "bg-slate-500/15 text-slate-100 border border-slate-500/30";
  }
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

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatRelative(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  return `${formatDuration(diffSeconds)} ago`;
}

function formatAbsolute(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString();
}
