import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  CacheEntriesOrder,
  CacheEntryKind,
  HealthStatus,
  WeatherCacheEntry,
  WeatherCacheHealth,
  WeatherCacheInventory,
  deleteWeatherCacheEntries,
  fetchWeatherCacheEntries,
  fetchWeatherCacheHealth,
  storeWeatherCacheEntries
} from "../api/hubClient";

type CacheManagerPanelProps = {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
};

const ORDER_OPTIONS: { label: string; value: CacheEntriesOrder }[] = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
  { label: "Largest first", value: "largest" },
  { label: "Smallest first", value: "smallest" }
];

const LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2000] as const;

const KIND_OPTIONS: { label: string; value: CacheEntryKind }[] = [
  { label: "GRIB files", value: "grib" },
  { label: "Metadata", value: "metadata" },
  { label: "Logs", value: "log" },
  { label: "Other", value: "other" }
];

export function CacheManagerPanel({ open, onClose, onChanged }: CacheManagerPanelProps) {
  const [inventory, setInventory] = useState<WeatherCacheInventory | null>(null);
  const [health, setHealth] = useState<WeatherCacheHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<CacheEntriesOrder>("newest");
  const [limit, setLimit] = useState<number>(250);
  const [kinds, setKinds] = useState<CacheEntryKind[]>(["grib"]);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [storeLabel, setStoreLabel] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const loadInventory = useCallback(
    async (signal?: AbortSignal) => {
      if (!open) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [inv, healthPayload] = await Promise.all([
          fetchWeatherCacheEntries(
            {
              limit,
              order,
              kinds: kinds.length ? kinds : undefined
            },
            signal
          ),
          fetchWeatherCacheHealth(signal)
        ]);
        if (signal?.aborted) {
          return;
        }
        setInventory(inv);
        setHealth(healthPayload);
        setLoading(false);
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        setInventory(null);
        setLoading(false);
        setError(err instanceof Error ? err.message : "Failed to load cache inventory.");
      }
    },
    [open, limit, order, kinds]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    void loadInventory(controller.signal);
    return () => controller.abort();
  }, [open, loadInventory]);

  useEffect(() => {
    if (!open) {
      setSelection(new Set());
      setActionMessage(null);
      setActionError(null);
    }
  }, [open]);

  const entries = inventory?.entries ?? [];
  const selectedPaths = useMemo(() => Array.from(selection), [selection]);
  const selectedCount = selection.size;
  const allSelected = entries.length > 0 && selectedCount === entries.length;

  const toggleSelection = (path: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!entries.length) {
      return;
    }
    if (allSelected) {
      setSelection(new Set());
    } else {
      setSelection(new Set(entries.map((entry) => entry.path)));
    }
  };

  const toggleKind = (kind: CacheEntryKind) => {
    setKinds((prev) => {
      if (prev.includes(kind)) {
        return prev.filter((value) => value !== kind);
      }
      return [...prev, kind];
    });
  };

  const handleRefresh = useCallback(() => {
    void loadInventory();
  }, [loadInventory]);

  const handleDelete = async () => {
    if (!selectedPaths.length) {
      return;
    }
    setActionBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const response = await deleteWeatherCacheEntries(selectedPaths, { includeMetadata });
      setActionMessage(
        `Deleted ${response.processed} entr${response.processed === 1 ? "y" : "ies"} (${formatBytes(
          response.bytes_removed
        )}).`
      );
      setSelection(new Set());
      setStoreLabel("");
      await loadInventory();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete cache entries.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleStore = async () => {
    if (!selectedPaths.length) {
      return;
    }
    setActionBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const trimmedLabel = storeLabel.trim();
      const response = await storeWeatherCacheEntries(selectedPaths, {
        includeMetadata,
        label: trimmedLabel || undefined
      });
      setActionMessage(
        `Stored ${response.processed} entr${response.processed === 1 ? "y" : "ies"} (${formatBytes(
          response.bytes_moved
        )}) to ${response.destination}.`
      );
      setSelection(new Set());
      setStoreLabel("");
      await loadInventory();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to store cache entries.");
    } finally {
      setActionBusy(false);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8">
      <div className="flex w-full max-w-6xl flex-col rounded-2xl border border-emerald-700/50 bg-[rgba(3,16,10,0.95)] shadow-[0_30px_80px_rgba(0,0,0,0.75)]">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-emerald-800/40 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-emerald-50">HRRR Cache Manager</h2>
            <p className="text-sm text-emerald-200/70">
              Review cached GRIB files, delete stale data, or move files into cold storage.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/10"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-emerald-500/30 px-3 py-1.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/10"
            >
              Close
            </button>
          </div>
        </header>

        <div className="grid gap-4 border-b border-emerald-900/40 px-6 py-4 text-sm text-emerald-100 md:grid-cols-4">
          <SummaryItem label="Status">
            <StatusBadge status={health?.status} />
          </SummaryItem>
          <SummaryItem label="Cache directory">{inventory?.cache_dir ?? "Unknown"}</SummaryItem>
          <SummaryItem label="Total files">{inventory ? inventory.total_files.toLocaleString() : "0"}</SummaryItem>
          <SummaryItem label="Total size">{formatBytes(inventory?.total_bytes ?? 0)}</SummaryItem>
        </div>

        <div className="flex flex-col gap-4 border-b border-emerald-900/40 px-6 py-4 text-sm text-emerald-50">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex flex-col text-xs text-emerald-300/80">
              Order
              <select
                value={order}
                onChange={(event) => setOrder(event.target.value as CacheEntriesOrder)}
                className="mt-1 rounded-lg border border-emerald-700 bg-transparent px-3 py-1 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
              >
                {ORDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-900 text-emerald-50">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-emerald-300/80">
              Entries
              <select
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="mt-1 rounded-lg border border-emerald-700 bg-transparent px-3 py-1 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
              >
                {LIMIT_OPTIONS.map((value) => (
                  <option key={value} value={value} className="bg-slate-900 text-emerald-50">
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2 text-xs text-emerald-300/80">
              {KIND_OPTIONS.map((option) => (
                <label key={option.value} className="inline-flex items-center gap-1 rounded-full border border-emerald-700/60 px-2 py-1">
                  <input
                    type="checkbox"
                    checked={kinds.includes(option.value)}
                    onChange={() => toggleKind(option.value)}
                    className="h-3 w-3 rounded border-emerald-600 bg-transparent text-emerald-400 focus:ring-emerald-500"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
          {kinds.length === 0 ? (
            <p className="text-xs text-amber-200/80">No filters selected – showing every file type.</p>
          ) : null}
        </div>

        <div className="flex-1 overflow-hidden px-6 py-4">
          <div className="overflow-hidden rounded-2xl border border-emerald-800/50 bg-[rgba(2,14,9,0.85)]">
            {loading ? (
              <div className="px-4 py-6 text-sm text-emerald-200/70">Scanning cache...</div>
            ) : error ? (
              <div className="px-4 py-6 text-sm text-amber-200/80">{error}</div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-6 text-sm text-emerald-200/70">No cached files match the current filters.</div>
            ) : (
              <div className="max-h-[28rem] overflow-y-auto">
                <table className="min-w-full divide-y divide-emerald-900/60 text-sm">
                  <thead className="bg-[rgba(5,20,13,0.9)] text-xs uppercase tracking-wide text-emerald-300/70">
                    <tr>
                      <th className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-emerald-600 text-emerald-400 focus:ring-emerald-500"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                        />
                      </th>
                      <th className="px-4 py-3 text-left">File</th>
                      <th className="px-4 py-3 text-left">Size</th>
                      <th className="px-4 py-3 text-left">Modified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-900/40 text-emerald-100">
                    {entries.map((entry) => {
                      const selected = selection.has(entry.path);
                      return (
                        <tr key={entry.path} className={selected ? "bg-emerald-500/5" : undefined}>
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-emerald-600 text-emerald-400 focus:ring-emerald-500"
                              checked={selected}
                              onChange={() => toggleSelection(entry.path)}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-mono text-xs text-emerald-50">{entry.path}</p>
                            <p className="text-[0.7rem] text-emerald-300/80">{describeEntry(entry)}</p>
                          </td>
                          <td className="px-4 py-3 text-sm">{formatBytes(entry.bytes)}</td>
                          <td className="px-4 py-3 text-sm">{formatRelative(entry.modified)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-emerald-900/40 px-6 py-4 text-sm text-emerald-50">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-emerald-300/80">
              Selected {selectedCount} entr{selectedCount === 1 ? "y" : "ies"}
            </span>
            <label className="inline-flex items-center gap-2 text-xs text-emerald-300/80">
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(event) => setIncludeMetadata(event.target.checked)}
                className="h-4 w-4 rounded border-emerald-600 text-emerald-400 focus:ring-emerald-500"
              />
              Include metadata files
            </label>
            <input
              type="text"
              value={storeLabel}
              onChange={(event) => setStoreLabel(event.target.value)}
              placeholder="Storage label (optional)"
              className="flex-1 rounded-lg border border-emerald-700 bg-transparent px-3 py-2 text-sm text-emerald-100 placeholder:text-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!selectedCount || actionBusy}
              onClick={handleDelete}
              className="rounded-lg border border-rose-500/60 px-4 py-2 text-sm font-semibold text-rose-100 transition hover:border-rose-400/80 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {actionBusy ? "Working..." : "Delete Selected"}
            </button>
            <button
              type="button"
              disabled={!selectedCount || actionBusy}
              onClick={handleStore}
              className="rounded-lg border border-sky-500/60 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:border-sky-400/80 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {actionBusy ? "Working..." : "Store Selected"}
            </button>
            {actionMessage ? <span className="text-xs text-emerald-300/90">{actionMessage}</span> : null}
            {actionError ? <span className="text-xs text-rose-300/90">{actionError}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-emerald-800/40 bg-[rgba(5,20,13,0.65)] p-3">
      <p className="text-xs uppercase tracking-wide text-emerald-300/70">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: HealthStatus | undefined }) {
  const theme = statusTheme(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${theme.container}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden="true" />
      {theme.label}
    </span>
  );
}

function statusTheme(status: HealthStatus | undefined) {
  switch (status) {
    case "ok":
      return { container: "border-emerald-600/50 text-emerald-100", dot: "bg-emerald-400", label: "Healthy" };
    case "warning":
      return { container: "border-amber-600/50 text-amber-100", dot: "bg-amber-400", label: "Warning" };
    case "critical":
      return { container: "border-rose-600/50 text-rose-100", dot: "bg-rose-400", label: "Critical" };
    case "disabled":
      return { container: "border-slate-600/50 text-slate-100", dot: "bg-slate-400", label: "Disabled" };
    case "unknown":
    default:
      return { container: "border-slate-600/50 text-slate-200", dot: "bg-slate-400", label: status ? status : "Unknown" };
  }
}

function describeEntry(entry: WeatherCacheEntry): string {
  const parts: string[] = [entry.kind.toUpperCase()];
  if (entry.cycle) {
    parts.push(`Cycle ${entry.cycle}`);
  }
  if (entry.forecast_hour != null) {
    parts.push(`Hour +${entry.forecast_hour}`);
  }
  if (entry.domain) {
    parts.push(entry.domain.toUpperCase());
  }
  return parts.join(" • ");
}

function formatBytes(value: number | null | undefined): string {
  if (!value || Number.isNaN(value)) {
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

function formatRelative(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "Unknown";
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }
  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  return `${hours}h ${minutes}m ago`;
}
