import { useEffect, useMemo, useRef, useState } from "react";
import { namespacedStorage } from "@native/secure-storage";
import { mockBackend as createSdkMockBackend } from "@sdk/mock";
import type { SensorTelemetry, MockBackend } from "@sdk/mock";
import type { IrrigationZone, PotSummary } from "@sdk/rest";
import { getEnv, type RuntimeMode } from "@sdk/env";
import { discoverPi, connect as sdkConnect } from "@sdk";
import { sensorTopic } from "@sdk/topics";

type Unsubscribe = () => void;

interface PlantDataProvider {
  listPots(): Promise<PotSummary[]>;
  listZones(): Promise<IrrigationZone[]>;
  subscribeToPot(potId: string, handler: (telemetry: SensorTelemetry) => void): Promise<Unsubscribe>;
}

const storageNamespace = "projectplant-web";

function createDemoProvider(backend: MockBackend): PlantDataProvider {
  return {
    async listPots() {
      return backend.listPots();
    },
    async listZones() {
      return backend.listZones();
    },
    async subscribeToPot(potId, handler) {
      const topic = sensorTopic(potId);
      const unsubscribe = backend.subscribeSensor(topic, handler);
      return () => unsubscribe();
    }
  };
}

async function loadLiveProvider(): Promise<PlantDataProvider> {
  const { listPots, listZones, subscribeSensor } = await import("@sdk");

  return {
    async listPots() {
      return listPots();
    },
    async listZones() {
      return listZones();
    },
    async subscribeToPot(potId, handler) {
      const topic = sensorTopic(potId);
      try {
        const dispose = await subscribeSensor(topic, (event) => {
          if (event.parsed) {
            handler(event.parsed);
          }
        });
        return () => dispose();
      } catch (err) {
        // Fallback: if MQTT is unavailable, poll REST and synthesize telemetry
        let cancelled = false;
        const poll = async () => {
          if (cancelled) return;
          try {
            const pots = await listPots();
            const zones = await listZones();
            const pot = pots.find((p) => p.id === potId);
            const zone = zones.find((z) => z.valves.some((v) => v.potId === potId));
            const valve = zone?.valves.find((v) => v.potId === potId);
            if (pot) {
              const synthetic: SensorTelemetry = {
                potId: pot.id,
                moisture: pot.soilMoisture,
                temperature: pot.temperature,
                humidity: pot.humidity,
                valveOpen: valve?.isOpen ?? false,
                flowRateLpm: valve?.flowRateLpm,
                timestamp: pot.updatedAt
              };
              handler(synthetic);
            }
          } catch {
            // ignore
          }
        };
        await poll();
        const interval = setInterval(poll, 3000);
        return () => {
          cancelled = true;
          clearInterval(interval);
        };
      }
    }
  };
}

export default function App() {
  const demoBackendRef = useRef<MockBackend | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("demo");
  const [provider, setProvider] = useState<PlantDataProvider>(() => {
    demoBackendRef.current = createSdkMockBackend({ potCount: 3, intervalMs: 2000 });
    return createDemoProvider(demoBackendRef.current);
  });
  const [discovering, setDiscovering] = useState(false);
  const [status, setStatus] = useState<string>("Initialising...");
  const [manualUrl, setManualUrl] = useState<string>("");

  const switchToDemo = () => {
    setStatus("Demo mode active");
    setMode("demo");
    void sdkConnect({ mode: "demo" }).catch(() => void 0);
    if (!demoBackendRef.current) {
      demoBackendRef.current = createSdkMockBackend({ potCount: 3, intervalMs: 2000 });
    }
    setProvider(createDemoProvider(demoBackendRef.current));
  };

  const switchToLive = async () => {
    setStatus("Switching to live mode...");
    try {
      const liveProvider = await loadLiveProvider();
      setProvider(liveProvider);
      setMode("live");
      setStatus("Live mode");
      demoBackendRef.current?.shutdown();
      demoBackendRef.current = null;
    } catch (error) {
      console.error("Failed to switch to live provider", error);
      setStatus("Live mode unavailable");
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const env = await getEnv();
        if (cancelled) return;
        setMode(env.mode);
        if (env.mode === "live" && env.baseUrl) {
          await sdkConnect(env);
          if (cancelled) return;
          await switchToLive();
          setStatus(`Connected to ${env.baseUrl}`);
        } else {
          setStatus("Demo mode active");
        }
      } catch (error) {
        console.error("Unable to initialise runtime environment", error);
        setStatus("Demo mode active");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Background discovery on mount (non-blocking)
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setDiscovering(true);
      try {
        const result = await discoverPi();
        if (cancelled) return;
        if (result) {
          const baseUrl = `http://${result.host}:${result.port}`;
          await sdkConnect({ mode: "live", baseUrl });
          if (cancelled) return;
          await switchToLive();
          setStatus(`Connected to ${baseUrl} (${result.via})`);
        } else {
          setStatus("Demo mode active");
        }
      } catch (error) {
        console.warn("Pi discovery failed", error);
      } finally {
        if (!cancelled) setDiscovering(false);
      }
    };
    run().catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRetryDiscovery = async () => {
    setDiscovering(true);
    setStatus("Discovering hub...");
    try {
      const result = await discoverPi();
      if (result) {
        const baseUrl = `http://${result.host}:${result.port}`;
        await sdkConnect({ mode: "live", baseUrl });
        await switchToLive();
        setStatus(`Connected to ${baseUrl} (${result.via})`);
      } else {
        setStatus("Discovery failed; staying in demo");
      }
    } catch (error) {
      console.warn("Discovery retry failed", error);
      setStatus("Discovery error; staying in demo");
    } finally {
      setDiscovering(false);
    }
  };

  const handleManualConnect = async () => {
    const input = (manualUrl || "").trim();
    if (!input) {
      setStatus("Enter an IP or URL");
      return;
    }
    try {
      let baseUrl: string;
      if (input.startsWith("http://") || input.startsWith("https://")) {
        baseUrl = input.replace(/\/$/, "");
      } else if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(input)) {
        baseUrl = input.includes(":") ? `http://${input}` : `http://${input}:80`;
      } else {
        baseUrl = `http://${input}:80`;
      }
      setStatus(`Connecting to ${baseUrl}...`);
      await sdkConnect({ mode: "live", baseUrl });
      await switchToLive();
      setStatus(`Connected to ${baseUrl}`);
    } catch (error) {
      console.error("Manual connect failed", error);
      setStatus("Manual connect failed");
    }
  };

  useEffect(() => () => {
    demoBackendRef.current?.shutdown();
  }, []);

  return (
    <Dashboard
      provider={provider}
      mode={mode}
      status={status}
      discovering={discovering}
      onToggleMode={(next) => (next === "demo" ? switchToDemo() : handleRetryDiscovery())}
      manualUrl={manualUrl}
      onManualUrlChange={setManualUrl}
      onManualConnect={() => void handleManualConnect()}
      onRetryDiscovery={() => void handleRetryDiscovery()}
    />
  );
}

interface DashboardProps {
  provider: PlantDataProvider;
  mode: RuntimeMode;
  status: string;
  discovering: boolean;
  onToggleMode: (next: RuntimeMode) => void;
  manualUrl: string;
  onManualUrlChange: (value: string) => void;
  onManualConnect: () => void;
  onRetryDiscovery: () => void;
}

function Dashboard({ provider, mode, status, discovering, onToggleMode, manualUrl, onManualUrlChange, onManualConnect, onRetryDiscovery }: DashboardProps) {
  const [pots, setPots] = useState<PotSummary[]>([]);
  const [zones, setZones] = useState<IrrigationZone[]>([]);
  const [selectedPotId, setSelectedPotId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<SensorTelemetry | null>(null);
  const [note, setNote] = useState("");
  const storage = useMemo(() => namespacedStorage(storageNamespace), []);

  useEffect(() => {
    let active = true;
    storage.get("note").then((value) => {
      if (active && value) {
        setNote(value);
      }
    });
    return () => {
      active = false;
    };
  }, [storage]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [initialPots, initialZones] = await Promise.all([
          provider.listPots(),
          provider.listZones()
        ]);
        if (!active) {
          return;
        }
        setPots(initialPots);
        setZones(initialZones);
        setSelectedPotId((current) => current ?? (initialPots[0]?.id ?? null));
      } catch (error) {
        console.error("Failed to load initial data", error);
      }
    })();
    return () => {
      active = false;
    };
  }, [provider]);

  useEffect(() => {
    if (!selectedPotId) {
      setTelemetry(null);
      return;
    }

    let active = true;
    let unsubscribe: Unsubscribe | undefined;

    (async () => {
      try {
        unsubscribe = await provider.subscribeToPot(selectedPotId, (payload) => {
          if (!active) {
            return;
          }
          setTelemetry(payload);
          void provider.listPots().then((latest) => {
            if (!active) {
              return;
            }
            setPots(latest);
            if ((!selectedPotId || !latest.some((pot) => pot.id === selectedPotId)) && latest.length > 0) {
              setSelectedPotId(latest[0].id);
            } else if (latest.length === 0) {
              setSelectedPotId(null);
            }
          });
          void provider.listZones().then((latest) => {
            if (!active) {
              return;
            }
            setZones(latest);
          });
        });
      } catch (error) {
        console.error(`Unable to subscribe to telemetry for ${selectedPotId}`, error);
      }
    })();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [provider, selectedPotId]);

  const handleNoteChange = (value: string) => {
    setNote(value);
    void storage.set("note", value).catch((error) => {
      console.error("Unable to persist note", error);
    });
  };

  const selectedPot = selectedPotId
    ? pots.find((pot) => pot.id === selectedPotId) ?? null
    : null;

  const selectedZone = selectedPot
    ? zones.find((zone) => zone.valves.some((valve) => valve.potId === selectedPot.id))
    : undefined;
  const selectedValve = selectedZone?.valves.find((valve) => valve.potId === selectedPot?.id);

  const fallbackTelemetry: SensorTelemetry | null = selectedPot
    ? {
        potId: selectedPot.id,
        moisture: selectedPot.soilMoisture,
        temperature: selectedPot.temperature,
        humidity: selectedPot.humidity,
        valveOpen: selectedValve?.isOpen ?? false,
        flowRateLpm: selectedValve?.flowRateLpm,
        timestamp: selectedPot.updatedAt
      }
    : null;

  const activeTelemetry = telemetry ?? fallbackTelemetry;
  const modeBadge = mode === "demo" ? "Demo Mode" : "Live Mode";

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: "960px",
        margin: "0 auto",
        color: "#111827"
      }}
    >
      <header style={{ marginBottom: "2rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
          <div>
            <h1 style={{ margin: 0 }}>Project Plant</h1>
            <p style={{ color: "#555", marginTop: "0.5rem" }}>
              Monitor and control your plants from anywhere.
              <span
                style={{
                  marginLeft: "0.75rem",
                  padding: "0.25rem 0.75rem",
                  borderRadius: "9999px",
                  backgroundColor: mode === "demo" ? "#dbeafe" : "#dcfce7",
                  color: mode === "demo" ? "#1d4ed8" : "#047857",
                  fontSize: "0.85rem",
                  fontWeight: 600
                }}
              >
                {modeBadge}
              </span>
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#374151" }}>Demo</span>
              <input
                type="checkbox"
                checked={mode === "live"}
                onChange={(e) => onToggleMode(e.target.checked ? "live" : "demo")}
              />
              <span style={{ color: "#374151" }}>Live</span>
            </label>
            <a
              href="/setup"
              style={{
                textDecoration: "none",
                background: "#111827",
                color: "#fff",
                padding: "0.5rem 0.75rem",
                borderRadius: 8,
                whiteSpace: "nowrap"
              }}
            >
              Setup Wizard
            </a>
          </div>
        </div>
      </header>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: "1rem",
          marginBottom: "1.5rem",
          background: "#f9fafb"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <strong>Connect</strong>
          <span style={{ color: "#6b7280" }}>{status}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="IP or Base URL (e.g. 192.168.1.50 or http://projectplant.local)"
            value={manualUrl}
            onChange={(e) => onManualUrlChange(e.target.value)}
            style={{ flex: 1, minWidth: 260, padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: 8 }}
          />
          <button onClick={onManualConnect} style={{ padding: "0.5rem 0.75rem" }}>Connect</button>
          <button onClick={onRetryDiscovery} disabled={discovering} style={{ padding: "0.5rem 0.75rem" }}>
            {discovering ? "Discovering..." : "Retry"}
          </button>
        </div>
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ marginTop: 0 }}>Smart Pots</h2>
        {pots.length > 0 ? (
          <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {pots.map((pot) => (
              <button
                key={pot.id}
                onClick={() => setSelectedPotId(pot.id)}
                style={{
                  textAlign: "left",
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  padding: "0.75rem 1rem",
                  background: selectedPotId === pot.id ? "#eef2ff" : "#fff",
                  cursor: "pointer"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>{pot.name}</strong>
                  <span style={{ color: "#6b7280", fontSize: 12 }}>{formatTimestamp(pot.updatedAt)}</span>
                </div>
                <div style={{ marginTop: 8, color: "#374151" }}>
                  Moisture: <strong>{formatNumber(pot.soilMoisture, "%")}</strong>
                </div>
                <div style={{ color: "#374151" }}>
                  Temp: <strong>{formatNumber(pot.temperature, " °C")}</strong>
                </div>
                {typeof pot.humidity === "number" && (
                  <div style={{ color: "#374151" }}>Humidity: <strong>{formatNumber(pot.humidity, "%")}</strong></div>
                )}
              </button>
            ))}
          </div>
        ) : (
          <p style={{ color: "#6b7280" }}>No pots detected yet.</p>
        )}
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "12px",
          padding: "1.5rem",
          marginBottom: "2rem"
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            marginBottom: "1.0rem"
          }}
        >
          <h2 style={{ margin: 0 }}>Sensors</h2>
          <select
            value={selectedPotId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedPotId(value === "" ? null : value);
            }}
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              backgroundColor: "#fff",
              minWidth: "160px"
            }}
          >
            <option value="">All</option>
            {pots.map((pot) => (
              <option key={pot.id} value={pot.id}>
                {pot.name}
              </option>
            ))}
          </select>
        </div>

        {activeTelemetry ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}>
            <li>Soil Moisture: <strong>{formatNumber(activeTelemetry.moisture, "%")}</strong></li>
            <li>Temperature: <strong>{formatNumber(activeTelemetry.temperature, " degC")}</strong></li>
            <li>Humidity: <strong>{formatNumber(activeTelemetry.humidity, "%")}</strong></li>
            <li>
              Valve: <strong>{activeTelemetry.valveOpen ? "Open" : "Closed"}</strong>
              {typeof activeTelemetry.flowRateLpm === "number" && (
                <span> - Flow {formatNumber(activeTelemetry.flowRateLpm, " L/min", 2)}</span>
              )}
            </li>
            <li>Updated: <strong>{formatTimestamp(activeTelemetry.timestamp)}</strong></li>
          </ul>
        ) : (
          <p style={{ color: "#6b7280" }}>Awaiting telemetry...</p>
        )}
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Irrigation</h2>
        {zones.length > 0 ? (
          <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            {zones.map((zone) => {
              const zoneActive = zone.valves.some((valve) => valve.isOpen);
              const aggregateFlow = zone.valves.reduce((sum, valve) => sum + (valve.flowRateLpm ?? 0), 0);
              return (
                <div
                  key={zone.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "12px",
                    padding: "1rem",
                    backgroundColor: "#f9fafb"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{zone.name}</strong>
                    <span style={{ color: zoneActive ? "#047857" : "#6b7280" }}>
                      {zoneActive ? "Active" : "Idle"}
                    </span>
                  </div>
                  <div style={{ marginTop: "0.5rem", color: "#374151" }}>
                    Flow: <strong>{formatNumber(aggregateFlow, " L/min", 2)}</strong>
                  </div>
                  <ul style={{ listStyle: "none", margin: "0.75rem 0 0", padding: 0, color: "#4b5563" }}>
                    {zone.valves.map((valve) => (
                      <li key={valve.id} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{valve.potId}</span>
                        <span>
                          {valve.isOpen ? "Open" : "Closed"} - {formatNumber(valve.flowRateLpm, " L/min", 2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ color: "#6b7280" }}>No irrigation zones detected.</p>
        )}
      </section>

      <section>
        <h2>Notes</h2>
        <textarea
          value={note}
          onChange={(event) => handleNoteChange(event.target.value)}
          placeholder="Add care notes for your plant"
          rows={4}
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: "8px",
            border: "1px solid #d1d5db",
            resize: "vertical"
          }}
        />
        <p style={{ color: "#6b7280", marginTop: "0.5rem" }}>Saved locally for quick reference.</p>
      </section>
    </main>
  );
}

function formatNumber(value: number | undefined, unit = "", fractionDigits = 1): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `${value.toFixed(fractionDigits)}${unit}`;
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

