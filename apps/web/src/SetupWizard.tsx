import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BleBridge, type BleDevice } from "@native/ble";
import { discoverPi } from "@projectplant/sdk";
import { connect as connectSdk } from "@projectplant/sdk";
import { useNavigate } from "react-router-dom";

type TargetKind = "esp32" | "pi";

interface ProvisionProfile {
  serviceUuid: string;
  chars: {
    STATE: string;
    REQUEST_SSIDS?: string; // optional: write to request scan
    SSIDS: string; // notify or read list
    SSID: string; // write selected ssid
    PASS: string; // write passphrase
    APPLY: string; // write to trigger apply
    RESULT: string; // notify success/error
  };
}

// TODO: Replace UUIDs with the actual values used by your firmware/services
const PROFILES: Record<TargetKind, ProvisionProfile> = {
  esp32: {
    // ESP-IDF provisioning service UUID (placeholder)
    serviceUuid: "0000ffff-0000-1000-8000-00805f9b34fb",
    chars: {
      STATE: "0000ff01-0000-1000-8000-00805f9b34fb",
      REQUEST_SSIDS: "0000ff02-0000-1000-8000-00805f9b34fb",
      SSIDS: "0000ff03-0000-1000-8000-00805f9b34fb",
      SSID: "0000ff04-0000-1000-8000-00805f9b34fb",
      PASS: "0000ff05-0000-1000-8000-00805f9b34fb",
      APPLY: "0000ff06-0000-1000-8000-00805f9b34fb",
      RESULT: "0000ff07-0000-1000-8000-00805f9b34fb"
    }
  },
  pi: {
    // ProjectPlant Setup service UUID (placeholder)
    serviceUuid: "12345678-1234-5678-1234-56789abcdef0",
    chars: {
      STATE: "12345678-1234-5678-1234-56789abcdef1",
      REQUEST_SSIDS: "12345678-1234-5678-1234-56789abcdef2",
      SSIDS: "12345678-1234-5678-1234-56789abcdef3",
      SSID: "12345678-1234-5678-1234-56789abcdef4",
      PASS: "12345678-1234-5678-1234-56789abcdef5",
      APPLY: "12345678-1234-5678-1234-56789abcdef6",
      RESULT: "12345678-1234-5678-1234-56789abcdef7"
    }
  }
};

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data);
  } catch {
    // hex as fallback
    return Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

export default function SetupWizard() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<TargetKind>("esp32");
  const profile = useMemo(() => PROFILES[kind], [kind]);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [selected, setSelected] = useState<BleDevice | null>(null);
  const [stateText, setStateText] = useState<string>("");
  const [ssidList, setSsidList] = useState<string[]>([]);
  const [ssid, setSsid] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [step, setStep] = useState<"scan" | "connect" | "config" | "apply" | "done">("scan");
  const unsubscribeRef = useRef<null | (() => void | Promise<void>)>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionHint, setPermissionHint] = useState<"location" | "bluetooth" | null>(null);

  useEffect(() => {
    return () => {
      const unsub = unsubscribeRef.current;
      if (unsub) {
        Promise.resolve(unsub()).catch(() => void 0);
      }
    };
  }, []);

  const handleScan = useCallback(async () => {
    setError(null);
    setPermissionHint(null);
    setScanning(true);
    setDevices([]);
    try {
      const found = await BleBridge.scan(profile.serviceUuid, 5000);
      const filtered = found.filter((d) => {
        const name = (d.name ?? "").toLowerCase();
        return kind === "esp32"
          ? name.includes("esp-pro") || name.includes("esp-prov") || name.includes("esp32")
          : name.includes("projectplant setup") || name.includes("projectplant");
      });
      setDevices(filtered.length > 0 ? filtered : found);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? "Scan failed");
      setError(message);
      if (message.includes("Location services")) {
        setPermissionHint("location");
      } else if (message.includes("Bluetooth is disabled")) {
        setPermissionHint("bluetooth");
      }
    } finally {
      setScanning(false);
    }
  }, [profile.serviceUuid, kind]);

  const handleOpenLocationSettings = useCallback(() => {
    void BleBridge.openLocationSettings();
  }, []);

  const handleOpenBluetoothSettings = useCallback(() => {
    void BleBridge.openBluetoothSettings();
  }, []);



  const handleConnect = useCallback(
    async (device: BleDevice) => {
      setError(null);
      try {
        await BleBridge.connect(device.id);
        BleBridge.setActiveService(profile.serviceUuid);
        setSelected(device);
        setStep("connect");
        // Read initial state
        const buf = await BleBridge.read(profile.chars.STATE);
        const text = decodeText(buf);
        setStateText(text);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [profile.serviceUuid, profile.chars.STATE]
  );

  const requestSsids = useCallback(async () => {
    setError(null);
    try {
      if (profile.chars.REQUEST_SSIDS) {
        await BleBridge.write(profile.chars.REQUEST_SSIDS, encodeText("1"));
      }
      // Subscribe for SSID list updates
      const unsub = await BleBridge.subscribe(profile.chars.SSIDS, (data) => {
        const text = decodeText(data);
        // Expect lines or CSV; split by newline/semicolon/comma
        const items = text
          .split(/\r?\n|;|,/)
          .map((s) => s.trim())
          .filter(Boolean);
        setSsidList(items);
        if (!ssid && items.length > 0) {
          setSsid(items[0]);
        }
      });
      unsubscribeRef.current = unsub;
      setStep("config");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [profile.chars.REQUEST_SSIDS, profile.chars.SSIDS, ssid]);

  const applyCredentials = useCallback(async () => {
    setError(null);
    try {
      if (!ssid) {
        setError("Select a Wi‑Fi network");
        return;
      }
      await BleBridge.write(profile.chars.SSID, encodeText(ssid));
      await BleBridge.write(profile.chars.PASS, encodeText(password));
      // Immediately clear password from memory after sending
      setPassword("");
      await BleBridge.write(profile.chars.APPLY, encodeText("1"));

      const unsub = await BleBridge.subscribe(profile.chars.RESULT, async (data) => {
        const text = decodeText(data).toLowerCase();
        if (text.includes("ok") || text.includes("success")) {
          setStep("done");
          try {
            const result = await discoverPi();
            if (result) {
              const baseUrl = `http://${result.host}:${result.port}`;
              await connectSdk({ mode: "live", baseUrl });
            }
          } catch (err) {
            console.warn("Pi discovery failed", err);
          }
          navigate("/");
        } else if (text.includes("error") || text.includes("fail")) {
          setError(`Provisioning failed: ${text}`);
        }
      });
      unsubscribeRef.current = unsub;
      setStep("apply");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ssid, password, profile.chars, navigate]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Setup Wizard</h1>
      <p style={{ color: "#4b5563" }}>
        Provision your ProjectPlant devices via Bluetooth Low Energy.
      </p>

      <section style={{ margin: "1rem 0", padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <label>
            Target:
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TargetKind)}
              style={{ marginLeft: 8, padding: "0.25rem 0.5rem" }}
            >
              <option value="pi">ProjectPlant Setup (Pi)</option>
              <option value="esp32">ESP-Prov (ESP32)</option>
            </select>
          </label>
          <button onClick={handleScan} disabled={scanning} style={{ padding: "0.5rem 0.75rem" }}>
            {scanning ? "Scanning…" : "Scan Devices"}
          </button>
        </div>
        {devices.length === 0 && !scanning && (
          <p style={{ color: "#6b7280" }}>No devices found yet. Try scanning.</p>
        )}
        {devices.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {devices.map((d) => (
              <li
                key={d.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{d.name ?? "(Unnamed)"}</div>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>{d.id}</div>
                </div>
                <button onClick={() => void handleConnect(d)} style={{ padding: "0.4rem 0.75rem" }}>
                  Connect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section style={{ margin: "1rem 0", padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <h2 style={{ marginTop: 0 }}>Device</h2>
          <p>
            <strong>{selected.name ?? "(Unnamed)"}</strong>
            <br />
            <span style={{ color: "#6b7280", fontSize: 12 }}>{selected.id}</span>
          </p>
          <p style={{ color: "#374151" }}>State: {stateText || "(unknown)"}</p>
          {step === "connect" && (
            <button onClick={() => void requestSsids()} style={{ padding: "0.5rem 0.75rem" }}>
              Request Wi‑Fi Networks
            </button>
          )}
        </section>
      )}

      {step === "config" && (
        <section style={{ margin: "1rem 0", padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <h2 style={{ marginTop: 0 }}>Wi‑Fi</h2>
          {ssidList.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <label>
                SSID:
                <select value={ssid} onChange={(e) => setSsid(e.target.value)} style={{ marginLeft: 8 }}>
                  {ssidList.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Password:
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ marginLeft: 8 }}
                />
              </label>
              <div>
                <button onClick={() => void applyCredentials()} style={{ padding: "0.5rem 0.75rem" }}>
                  Apply
                </button>
              </div>
            </div>
          ) : (
            <p style={{ color: "#6b7280" }}>Waiting for SSID list…</p>
          )}
        </section>
      )}

      {step === "apply" && (
        <section style={{ margin: "1rem 0", padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <h2 style={{ marginTop: 0 }}>Provisioning</h2>
          <p style={{ color: "#6b7280" }}>Applying credentials and waiting for result…</p>
        </section>
      )}

      {error && (
        <div style={{ color: "#b91c1c", marginTop: 12 }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
          {permissionHint === "location" ? (
            <button
              type="button"
              onClick={handleOpenLocationSettings}
              style={{ marginTop: 8, padding: "0.4rem 0.75rem" }}
            >
              Open Location Settings
            </button>
          ) : null}
          {permissionHint === "bluetooth" ? (
            <button
              type="button"
              onClick={handleOpenBluetoothSettings}
              style={{ marginTop: 8, padding: "0.4rem 0.75rem" }}
            >
              Open Bluetooth Settings
            </button>
          ) : null}
        </div>
      )}
    </main>
  );
}

