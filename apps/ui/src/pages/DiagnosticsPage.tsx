import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertEvent,
  DeviceRegistryEntry,
  HealthStatus,
  HealthSummary,
  MqttHealth,
  StorageHealth,
  WeatherCacheHealth,
  addDeviceRegistry,
  deleteDeviceRegistry,
  fetchDeviceRegistry
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
  const [showHeartbeatList, setShowHeartbeatList] = useState(false);
  const [registryEntries, setRegistryEntries] = useState<DeviceRegistryEntry[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [registryInput, setRegistryInput] = useState("");

  const loadRegistry = useCallback(
    async (signal?: AbortSignal) => {
      setRegistryLoading(true);
      setRegistryError(null);
      try {
        const entries = await fetchDeviceRegistry(signal);
        if (signal?.aborted) {
          return;
        }
        setRegistryEntries(entries);
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load device registry.";
        setRegistryError(message);
      } finally {
        if (!signal?.aborted) {
          setRegistryLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!showHeartbeatList) {
      return;
    }
    const controller = new AbortController();
    void loadRegistry(controller.signal);
    return () => controller.abort();
  }, [loadRegistry, showHeartbeatList]);

  const handleRegistrySubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = registryInput.trim();
      if (!trimmed) {
        setRegistryError("Enter a pot id to add.");
        return;
      }
      setRegistryLoading(true);
      setRegistryError(null);
      try {
        await addDeviceRegistry(trimmed);
        setRegistryInput("");
        await loadRegistry();
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to add device.";
        setRegistryError(message);
      } finally {
        setRegistryLoading(false);
      }
    },
    [registryInput, loadRegistry, onRefresh]
  );

  const handleRegistryRemove = useCallback(
    async (potId: string) => {
      if (!potId) {
        return;
      }
      setRegistryLoading(true);
      setRegistryError(null);
      try {
        await deleteDeviceRegistry(potId, { purgeCache: true });
        await loadRegistry();
        onRefresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete device.";
        setRegistryError(message);
      } finally {
        setRegistryLoading(false);
      }
    },
    [loadRegistry, onRefresh]
  );

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

  const heartbeatEntries = useMemo(() => {
    const pots = mqtt?.heartbeat?.pots ?? [];
    return [...pots].sort((a, b) => a.pot_id.localeCompare(b.pot_id));
  }, [mqtt]);
  const heartbeatCount = useMemo(() => {
    if (mqtt?.heartbeat?.count !== undefined) {
      return mqtt.heartbeat.count;
    }
    return heartbeatEntries.filter((entry) => !entry.manual).length;
  }, [heartbeatEntries, mqtt]);
  const manualCount = useMemo(
    () => heartbeatEntries.filter((entry) => entry.manual).length,
    [heartbeatEntries]
  );
  const heartbeatLabel = heartbeatCount === 1 ? "device" : "devices";
  const manualSuffix = manualCount ? ` + ${manualCount} tracked` : "";

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
              value: mqtt?.heartbeat ? `${mqtt.heartbeat.count} pots (${mqtt.heartbeat.status.toUpperCase()})` : "n/a",
              onClick: () => setShowHeartbeatList(true)
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
            { label: "Files", value: formatCacheFileCount(weather) },
            { label: "Size", value: formatCacheSize(weather) },
            {
              label: "Last update",
              value: formatCacheLastUpdate(weather)
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

      {showHeartbeatList ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowHeartbeatList(false)}
            aria-hidden="true"
          />
          <div className="relative z-50 w-full max-w-3xl overflow-hidden rounded-2xl border border-emerald-700/50 bg-[rgba(7,31,21,0.95)] shadow-2xl shadow-emerald-900/60">
            <div className="flex items-start justify-between border-b border-emerald-800/50 px-5 py-4">
              <div>
                <p className="text-sm uppercase tracking-wide text-emerald-300/70">Mosquitto</p>
                <h3 className="text-lg font-semibold text-emerald-50">Connected devices (heartbeats)</h3>
                <p className="text-xs text-emerald-200/70">
                  Showing {heartbeatCount} {heartbeatLabel} reporting heartbeats{manualSuffix}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowHeartbeatList(false)}
                className="rounded-full border border-emerald-600/50 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400/70 hover:bg-emerald-500/20"
              >
                Close
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
              <div className="mb-4 rounded-xl border border-emerald-800/40 bg-[rgba(6,26,18,0.78)] p-4 text-xs text-emerald-200/80 shadow-inner shadow-emerald-950/40">
                <p className="text-xs uppercase tracking-wide text-emerald-300/70">Tracked IDs</p>
                <p className="mt-1 text-xs text-emerald-200/70">
                  Add a pot id to keep it visible here even when offline. Removing will also purge cached heartbeat
                  entries.
                </p>
                <p className="mt-1 text-[0.7rem] text-emerald-200/60">Tracking {registryEntries.length} ids.</p>
                <form onSubmit={handleRegistrySubmit} className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={registryInput}
                    onChange={(event) => setRegistryInput(event.target.value)}
                    placeholder="pot-01"
                    disabled={registryLoading}
                    className="min-w-[10rem] flex-1 rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-xs text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                  />
                  <button
                    type="submit"
                    disabled={registryLoading}
                    className="rounded-lg border border-emerald-500/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-50 transition hover:border-emerald-400 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {registryLoading ? "Saving..." : "Add ID"}
                  </button>
                </form>
                {registryError ? <p className="mt-2 text-xs text-rose-200">{registryError}</p> : null}
              </div>
              {heartbeatEntries.length === 0 ? (
                <p className="text-sm text-emerald-200/70">No heartbeats recorded yet.</p>
              ) : (
                <ul className="divide-y divide-emerald-800/50">
                  {heartbeatEntries.map((entry) => (
                    <li key={entry.pot_id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-emerald-50">{entry.pot_id}</p>
                          <p className="text-xs text-emerald-200/70">
                            Last seen {entry.received_at ? formatRelative(entry.received_at) : "unknown"} •{" "}
                            {formatDuration(entry.age_seconds ?? null)} ago
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-emerald-200/80">
                          {entry.manual ? (
                            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-100/80">
                              Manual
                            </span>
                          ) : null}
                          <span className={`rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ${statusBadge(entry.status)}`}>
                            {STATUS_LABELS[entry.status] ?? entry.status.toUpperCase()}
                          </span>
                          {renderStateDot(entry.pump_on, "Pump")}
                          {renderStateDot(entry.fan_on, "Fan")}
                          {renderStateDot(entry.mister_on, "Mister")}
                          <button
                            type="button"
                            onClick={() => handleRegistryRemove(entry.pot_id)}
                            disabled={registryLoading}
                            className="rounded-full border border-emerald-600/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-100/80 transition hover:border-emerald-400/70 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                            title="Remove from tracked list and purge cached heartbeats"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type DiagnosticCardProps = {
  title: string;
  status: HealthStatus | "loading";
  lines: DiagnosticLine[];
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
        {lines.map((line) => {
          const content = (
            <div className="flex w-full items-center justify-between gap-2">
              <dt className="text-emerald-200/60">{line.label}</dt>
              <dd className="text-right text-emerald-100">{line.value}</dd>
            </div>
          );

          if (line.onClick) {
            return (
              <button
                key={line.label}
                type="button"
                onClick={line.onClick}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 transition hover:bg-emerald-500/5 focus:outline-none focus:ring focus:ring-emerald-500/30"
              >
                {content}
              </button>
            );
          }

          return (
            <div key={line.label} className="flex items-center justify-between gap-2">
              {content}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

type DiagnosticLine = {
  label: string;
  value: string | ReactNode;
  onClick?: () => void;
};

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

function cacheIsEmpty(weather: WeatherCacheHealth | null | undefined): boolean {
  if (!weather) {
    return false;
  }
  return weather.state === "empty" || weather.file_count === 0;
}

function formatCacheFileCount(weather: WeatherCacheHealth | null): string {
  if (!weather) {
    return "0";
  }
  return cacheIsEmpty(weather) ? "empty" : weather.file_count.toString();
}

function formatCacheSize(weather: WeatherCacheHealth | null): string {
  if (!weather) {
    return "0 B";
  }
  return formatBytes(weather.bytes ?? 0);
}

function formatCacheLastUpdate(weather: WeatherCacheHealth | null): string {
  if (!weather || cacheIsEmpty(weather)) {
    return "n/a";
  }
  return weather.latest_modified ? formatRelative(weather.latest_modified) : "unknown";
}

function statusBadge(status: HealthStatus | string): string {
  const normalized = status?.toLowerCase?.() ?? "unknown";
  switch (normalized) {
    case "ok":
      return "border border-emerald-500/50 bg-emerald-500/15 text-emerald-100";
    case "warning":
      return "border border-amber-500/50 bg-amber-500/15 text-amber-100";
    case "critical":
      return "border border-rose-500/50 bg-rose-500/15 text-rose-100";
    case "disabled":
      return "border border-slate-500/40 bg-slate-500/10 text-slate-100";
    default:
      return "border border-slate-600/50 bg-slate-600/10 text-slate-100";
  }
}

function renderStateDot(state: boolean | null | undefined, label: string): ReactNode {
  if (state == null) {
    return null;
  }
  const active = state === true;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${active ? "bg-emerald-500/15 text-emerald-100" : "bg-slate-600/30 text-slate-200/80"}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-400" : "bg-slate-400"}`} aria-hidden="true" />
      {label} {active ? "on" : "off"}
    </span>
  );
}
