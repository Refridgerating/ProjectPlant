import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BleBridge, type BleDevice } from "@native/ble";
import { connect as connectSdk, discoverPi, type PiDiscoveryResult } from "@projectplant/sdk";
import { EspBleProvisioner, type ProtocolInfo, type HubConfigResponse } from "./provisioning/espBleProvisioning";
import type { WiFiScanEntry, WiFiStatus } from "./provisioning/protobuf";

type WizardStage = "discover" | "secure" | "network" | "provisioning" | "done";

function normalizeHubUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/$/, "");
  }
  if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(trimmed)) {
    return trimmed.includes(":") ? `http://${trimmed}` : `http://${trimmed}:80`;
  }
  return `http://${trimmed}`;
}

function derivePopCandidate(device: BleDevice): string {
  const name = (device.name ?? "").trim();
  const suffixMatch = name.match(/([0-9a-fA-F]{4})$/);
  if (suffixMatch) {
    return `pp-${suffixMatch[1].toLowerCase()}`;
  }
  return "pp-";
}

function isWifiStatusFailure(status: WiFiStatus | null): boolean {
  return status?.staState === 3;
}

function formatWifiState(status: WiFiStatus | null): string {
  if (!status) {
    return "Waiting for status...";
  }
  if (status.staState === 0) {
    return "Connected";
  }
  if (status.staState === 1) {
    return typeof status.attemptsRemaining === "number" && status.attemptsRemaining >= 0
      ? `Connecting (${status.attemptsRemaining} retries left)`
      : "Connecting";
  }
  if (status.staState === 2) {
    return "Disconnected";
  }
  if (status.staState === 3) {
    if (status.failReason === 0) {
      return "Connection failed: incorrect password";
    }
    if (status.failReason === 1) {
      return "Connection failed: network not found";
    }
    return "Connection failed";
  }
  return "Unknown";
}

export default function SetupWizard() {
  const navigate = useNavigate();
  const provisionerRef = useRef<EspBleProvisioner | null>(null);

  const [stage, setStage] = useState<WizardStage>("discover");
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<BleDevice | null>(null);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [securing, setSecuring] = useState(false);
  const [applying, setApplying] = useState(false);

  const [protocolInfo, setProtocolInfo] = useState<ProtocolInfo | null>(null);
  const [permissionHint, setPermissionHint] = useState<"location" | "bluetooth" | null>(null);
  const [pop, setPop] = useState("");
  const [networks, setNetworks] = useState<WiFiScanEntry[]>([]);
  const [loadingNetworks, setLoadingNetworks] = useState(false);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [hubUrlInput, setHubUrlInput] = useState("");
  const [mqttUriInput, setMqttUriInput] = useState("");
  const [hubResponse, setHubResponse] = useState<HubConfigResponse | null>(null);
  const [wifiStatus, setWifiStatus] = useState<WiFiStatus | null>(null);
  const [connectedHubUrl, setConnectedHubUrl] = useState<string | null>(null);
  const [hubDiscovery, setHubDiscovery] = useState<PiDiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      const current = provisionerRef.current;
      if (current) {
        void current.disconnect();
      }
    };
  }, []);

  const reconnectClean = useCallback(async () => {
    const current = provisionerRef.current;
    if (current) {
      try {
        await current.disconnect();
      } catch {
        // Ignore disconnect errors while switching device.
      }
    }
    provisionerRef.current = null;
  }, []);

  const handleScan = useCallback(async () => {
    setError(null);
    setPermissionHint(null);
    setScanning(true);
    setStage("discover");
    setDevices([]);
    try {
      const found = await EspBleProvisioner.scanProvisioningDevices(5000);
      const sorted = [...found].sort((left, right) => (right.rssi ?? -200) - (left.rssi ?? -200));
      setDevices(sorted);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : String(scanError);
      setError(message);
      if (message.toLowerCase().includes("location")) {
        setPermissionHint("location");
      } else if (message.toLowerCase().includes("bluetooth")) {
        setPermissionHint("bluetooth");
      }
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void handleScan();
  }, [handleScan]);

  const refreshNetworks = useCallback(async () => {
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      throw new Error("Device is not connected");
    }
    setLoadingNetworks(true);
    try {
      const scanned = await provisioner.scanWifiNetworks();
      setNetworks(scanned);
      setSsid((current) => {
        if (current) {
          return current;
        }
        return scanned[0]?.ssid ?? "";
      });
    } finally {
      setLoadingNetworks(false);
    }
  }, []);

  const handleSelectDevice = useCallback(
    async (device: BleDevice) => {
      setError(null);
      setPermissionHint(null);
      setConnecting(true);
      try {
        await reconnectClean();
        const provisioner = new EspBleProvisioner();
        await provisioner.connect(device.id);
        provisionerRef.current = provisioner;
        setSelectedDevice(device);
        setPop((current) => current || derivePopCandidate(device));
        setProtocolInfo(await provisioner.getProtocolInfo());
        setHubResponse(null);
        setWifiStatus(null);
        setConnectedHubUrl(null);
        setHubDiscovery(null);
        setStage("secure");
      } catch (connectError) {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      } finally {
        setConnecting(false);
      }
    },
    [reconnectClean]
  );

  const handleStartSession = useCallback(async () => {
    if (!pop.trim()) {
      setError("Proof-of-possession is required");
      return;
    }
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      setError("No provisioning device connected");
      return;
    }
    setError(null);
    setSecuring(true);
    try {
      await provisioner.establishSecurity1Session(pop.trim());
      await refreshNetworks();
      setStage("network");
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setSecuring(false);
    }
  }, [pop, refreshNetworks]);

  const handleApplyConfig = useCallback(async () => {
    const provisioner = provisionerRef.current;
    if (!provisioner) {
      setError("No provisioning device connected");
      return;
    }
    const selectedSsid = ssid.trim();
    if (!selectedSsid) {
      setError("Select or enter a Wi-Fi SSID");
      return;
    }

    setError(null);
    setApplying(true);
    setStage("provisioning");
    setHubResponse(null);
    setWifiStatus(null);
    setConnectedHubUrl(null);
    setHubDiscovery(null);

    try {
      const hubResponsePayload = await provisioner.sendHubConfig({
        hubUrl: normalizeHubUrl(hubUrlInput),
        mqttUri: mqttUriInput.trim() || undefined,
      });
      setHubResponse(hubResponsePayload);

      await provisioner.sendWiFiConfig(selectedSsid, password);
      setPassword("");
      await provisioner.applyWiFiConfig();

      const waitResult = await provisioner.waitForWifiConnection({
        timeoutMs: 120_000,
        intervalMs: 2_500,
        onStatus: setWifiStatus,
      });

      if (!waitResult.connected) {
        const suffix = isWifiStatusFailure(waitResult.status) ? ` (${formatWifiState(waitResult.status)})` : "";
        throw new Error(`Provisioning did not complete${suffix}`);
      }

      let baseUrl = normalizeHubUrl(hubUrlInput) ?? null;
      let discovery: PiDiscoveryResult | null = null;
      if (!baseUrl) {
        discovery = await discoverPi().catch(() => null);
        if (discovery) {
          baseUrl = `http://${discovery.host}:${discovery.port}`;
        }
      }

      if (baseUrl) {
        await connectSdk({
          mode: "live",
          baseUrl,
          mqttUrl: mqttUriInput.trim() || undefined,
        });
      }

      setConnectedHubUrl(baseUrl);
      setHubDiscovery(discovery);
      setStage("done");
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
      setStage("network");
    } finally {
      setApplying(false);
    }
  }, [hubUrlInput, mqttUriInput, password, ssid]);

  const handleOpenLocationSettings = useCallback(() => {
    void BleBridge.openLocationSettings();
  }, []);

  const handleOpenBluetoothSettings = useCallback(() => {
    void BleBridge.openBluetoothSettings();
  }, []);

  const progress = useMemo(() => {
    if (stage === "discover") return 1;
    if (stage === "secure") return 2;
    if (stage === "network") return 3;
    if (stage === "provisioning") return 4;
    return 5;
  }, [stage]);

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        fontFamily: "\"Space Grotesk\", \"Trebuchet MS\", \"Segoe UI\", sans-serif",
        background:
          "radial-gradient(1200px 600px at 12% -10%, #d4f7cb 0%, rgba(212,247,203,0) 65%), linear-gradient(180deg, #f5fff2 0%, #fefcf6 100%)",
        color: "#1f2c1f",
      }}
    >
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.25rem 3rem", display: "grid", gap: 16 }}>
        <section style={{ padding: "1.1rem 1.25rem", borderRadius: 16, background: "#153222", color: "#ecffe9" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: "1.6rem" }}>ProjectPlant Onboarding</h1>
              <p style={{ margin: "0.4rem 0 0", opacity: 0.9 }}>
                Pair your factory-default pot, send Wi-Fi credentials, and attach to your self-hosted hub.
              </p>
              <p style={{ margin: "0.4rem 0 0", opacity: 0.85, fontSize: 12 }}>
                Use this setup screen for provisioning. Pairing from phone Bluetooth settings alone does not submit Wi-Fi credentials.
              </p>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.82, alignSelf: "flex-start" }}>
              Language: English (streamlined setup)
            </div>
          </div>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
            {["Find", "Secure", "Network", "Apply", "Done"].map((label, index) => {
              const active = progress >= index + 1;
              return (
                <div
                  key={label}
                  style={{
                    borderRadius: 999,
                    padding: "0.35rem 0.5rem",
                    textAlign: "center",
                    fontSize: 12,
                    background: active ? "#a7ef97" : "rgba(255,255,255,0.18)",
                    color: active ? "#173022" : "#e6f4e2",
                    fontWeight: 600,
                  }}
                >
                  {label}
                </div>
              );
            })}
          </div>
        </section>

        <section style={{ background: "rgba(255,255,255,0.88)", border: "1px solid #daead5", borderRadius: 16, padding: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>1. Discover provisioning device</h2>
            <button onClick={() => void handleScan()} disabled={scanning || connecting} style={{ padding: "0.45rem 0.8rem" }}>
              {scanning ? "Scanning..." : "Scan Again"}
            </button>
          </div>

          {devices.length === 0 && !scanning ? (
            <p style={{ color: "#4d6352" }}>No nearby provisioning devices found. Power on the pot and look for name `PROV_xxxxxx`.</p>
          ) : null}

          <div style={{ display: "grid", gap: 10 }}>
            {devices.map((device) => (
              <button
                key={device.id}
                onClick={() => void handleSelectDevice(device)}
                disabled={connecting || applying || securing}
                style={{
                  textAlign: "left",
                  background: selectedDevice?.id === device.id ? "#ecffe5" : "white",
                  border: selectedDevice?.id === device.id ? "1px solid #8fcd7d" : "1px solid #d7e7d0",
                  borderRadius: 12,
                  padding: "0.7rem 0.8rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{device.name ?? "(Unnamed)"}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#4a6150" }}>{device.id}</div>
                  </div>
                  <span style={{ fontSize: 12, color: "#567159" }}>
                    RSSI {typeof device.rssi === "number" ? device.rssi : "--"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {stage !== "discover" && selectedDevice ? (
          <section style={{ background: "rgba(255,255,255,0.9)", border: "1px solid #dae8d2", borderRadius: 16, padding: "1rem", display: "grid", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>2. Secure session (ESP Security1)</h2>
            <div style={{ display: "grid", gap: 8 }}>
              <label>
                Proof of possession
                <input
                  value={pop}
                  onChange={(event) => setPop(event.target.value)}
                  placeholder="pp-xxxx"
                  style={{ marginTop: 6, width: "100%", maxWidth: 260, padding: "0.45rem 0.55rem" }}
                />
              </label>
              <p style={{ margin: 0, fontSize: 12, color: "#4f6554" }}>
                Use the PoP shown on your packaging or provisioning label.
              </p>
              {protocolInfo ? (
                <p style={{ margin: 0, fontSize: 12, color: "#4f6554" }}>
                  Protocol: <strong>{protocolInfo.version}</strong>
                  {protocolInfo.capabilities.length ? ` | Capabilities: ${protocolInfo.capabilities.join(", ")}` : ""}
                </p>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => void handleStartSession()} disabled={securing || applying}>
                {securing ? "Establishing..." : "Establish Session"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage("discover");
                  setSelectedDevice(null);
                  setNetworks([]);
                  setSsid("");
                  setProtocolInfo(null);
                  void reconnectClean();
                }}
              >
                Disconnect
              </button>
            </div>
          </section>
        ) : null}

        {stage === "network" || stage === "provisioning" || stage === "done" ? (
          <section style={{ background: "rgba(255,255,255,0.92)", border: "1px solid #d9e8d4", borderRadius: 16, padding: "1rem", display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "1.1rem" }}>3. Network and hub</h2>
              <button onClick={() => void refreshNetworks()} disabled={loadingNetworks || applying || stage === "done"}>
                {loadingNetworks ? "Refreshing..." : "Refresh Networks"}
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                Wi-Fi SSID
                <input
                  list="wifi-list"
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                  placeholder="Enter SSID"
                  disabled={stage === "done"}
                  style={{ padding: "0.45rem 0.55rem" }}
                />
                <datalist id="wifi-list">
                  {networks.map((entry) => (
                    <option key={`${entry.ssid}-${entry.bssidHex}`} value={entry.ssid} />
                  ))}
                </datalist>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                Wi-Fi password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Required for secured networks"
                  disabled={applying || stage === "done"}
                  style={{ padding: "0.45rem 0.55rem" }}
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                Hub URL (optional)
                <input
                  value={hubUrlInput}
                  onChange={(event) => setHubUrlInput(event.target.value)}
                  placeholder="e.g. projectplant.local:80"
                  disabled={applying || stage === "done"}
                  style={{ padding: "0.45rem 0.55rem" }}
                />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                MQTT URI (optional)
                <input
                  value={mqttUriInput}
                  onChange={(event) => setMqttUriInput(event.target.value)}
                  placeholder="mqtt://192.168.1.10:1883"
                  disabled={applying || stage === "done"}
                  style={{ padding: "0.45rem 0.55rem" }}
                />
              </label>
            </div>

            {stage !== "done" ? (
              <button onClick={() => void handleApplyConfig()} disabled={applying || !ssid.trim()}>
                {applying ? "Provisioning..." : "Apply Wi-Fi and Join Hub"}
              </button>
            ) : null}

            {stage === "provisioning" || stage === "done" ? (
              <div style={{ borderRadius: 12, background: "#f1fff0", border: "1px solid #cce5c6", padding: "0.7rem 0.8rem" }}>
                <strong>Device status:</strong> {formatWifiState(wifiStatus)}
              </div>
            ) : null}

            {hubResponse ? (
              <div style={{ borderRadius: 12, background: "#f8fff5", border: "1px solid #d8edd2", padding: "0.7rem 0.8rem", fontSize: 13 }}>
                Hub endpoint response: <strong>{hubResponse.status}</strong>
              </div>
            ) : null}
          </section>
        ) : null}

        {stage === "done" ? (
          <section style={{ background: "#173423", color: "#efffe8", borderRadius: 16, padding: "1rem" }}>
            <h2 style={{ margin: "0 0 0.6rem" }}>4. Setup complete</h2>
            <p style={{ margin: 0 }}>
              The pot joined Wi-Fi successfully.
              {connectedHubUrl ? ` Connected hub: ${connectedHubUrl}.` : " Hub connection can be configured in dashboard settings."}
              {hubDiscovery ? ` (discovered via ${hubDiscovery.via})` : ""}
            </p>
            <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => navigate("/dashboard")}
                style={{ background: "#b4f6a4", color: "#193221", border: "none", padding: "0.5rem 0.9rem", borderRadius: 8, fontWeight: 700 }}
              >
                Open Dashboard
              </button>
              {connectedHubUrl ? (
                <button
                  onClick={() => {
                    const opened = window.open(connectedHubUrl, "_blank", "noopener,noreferrer");
                    if (!opened) {
                      window.location.href = connectedHubUrl;
                    }
                  }}
                  style={{ padding: "0.5rem 0.9rem", borderRadius: 8 }}
                >
                  Open Hub Landing Page
                </button>
              ) : null}
              <button
                onClick={() => {
                  setStage("discover");
                  setDevices([]);
                  setSelectedDevice(null);
                  setNetworks([]);
                  setSsid("");
                  setProtocolInfo(null);
                  setHubResponse(null);
                  setWifiStatus(null);
                  setConnectedHubUrl(null);
                  setHubDiscovery(null);
                  setError(null);
                  setPop("");
                  void reconnectClean();
                  void handleScan();
                }}
                style={{ padding: "0.5rem 0.9rem", borderRadius: 8 }}
              >
                Provision Another Device
              </button>
            </div>
          </section>
        ) : null}

        {error ? (
          <section style={{ borderRadius: 12, border: "1px solid #f0b7b7", background: "#fff5f5", color: "#862626", padding: "0.8rem 0.9rem" }}>
            <strong>Error:</strong> {error}
            {permissionHint === "location" ? (
              <div style={{ marginTop: 8 }}>
                <button onClick={handleOpenLocationSettings}>Open Location Settings</button>
              </div>
            ) : null}
            {permissionHint === "bluetooth" ? (
              <div style={{ marginTop: 8 }}>
                <button onClick={handleOpenBluetoothSettings}>Open Bluetooth Settings</button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
