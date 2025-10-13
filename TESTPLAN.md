# ProjectPlant Test Plan

This test plan validates key onboarding and runtime behaviors for ProjectPlant across Demo, device discovery, MQTT streaming, BLE/SoftAP provisioning, and permissions.

## Scope & Goals
- Verify Demo mode opens with believable, dynamic data.
- Confirm LAN discovery locates a Raspberry Pi and `/healthz` returns OK.
- Validate MQTT over WebSocket connects and live sensor messages update the UI.
- Exercise BLE provisioning flows for Raspberry Pi (SSID selection) and ESP32 (PoP).
- Validate SoftAP fallback onboarding when BLE is unavailable/disabled.
- Ensure OS permission prompts appear only on the Setup screen.

## Test Environment
- Mobile device(s): one Android 12+ and one iOS 16+ phone.
- Raspberry Pi with ProjectPlant agent and BLE enabled; connected to 2.4GHz Wi‑Fi or Ethernet.
- ESP32 with provisioning firmware (BLE PoP + SoftAP fallback) and sensor stub.
- MQTT broker with WebSocket enabled (e.g., `ws://broker.local:8083/mqtt` or `wss://broker.local/mqtt`).
- Local LAN with multicast/mDNS enabled; Pi reachable by hostname or IP.
- Tools: curl/Postman, MQTTX or Mosquitto (`mosquitto_pub/sub`), nRF Connect (BLE), OS console logs (adb/Xcode), Wi‑Fi router admin access.

## Test Data & Accounts
- Wi‑Fi SSIDs: `TestLab-2G` (valid), `TestLab-5G`, `Guest`, hidden SSID; password `P@ssw0rd!` and negative `WrongPass!`.
- ESP32 PoP: valid `abcd1234`, invalid `badpop`.
- MQTT topics (example):
  - Telemetry: `pots/<deviceId>/sensors` (JSON array or obj)
  - Status: `pots/<deviceId>/status`
  - Commands: `pots/<deviceId>/command`
- Sample telemetry payload:
  ```json
  {
    "deviceId": "pi-01",
    "timestamp": 1735600000,
    "sensors": {"temp": 23.8, "humidity": 51.2, "soil": 0.41}
  }
  ```

## Acceptance Criteria
- All scenarios below pass on both Android and iOS (unless marked platform‑specific).
- No crashes, UI lockups, or unhandled errors.
- Reconnects and retries behave gracefully; user receives clear guidance on failure.

---

## T1. Demo Mode Opens With Live‑Looking Data
Preconditions
- Fresh install or no devices discovered.

Steps
1) Launch the app to the Home/Dashboard.
2) Confirm it enters Demo mode automatically or via explicit Demo toggle.
3) Observe charts/tiles for at least 60 seconds.

Expected
- UI shows changing values/graphs at realistic intervals (e.g., 1–5s updates), not static placeholders.
- No control actions attempt to hit live endpoints (guarded or disabled in Demo).
- Labeling makes mode clear (e.g., “Demo”).

Negative/Edge
- Toggle Demo off then on: data regenerates cleanly without duplication.
- Background/foreground the app; Demo stream resumes without error.

Artifacts
- Screen recording of first 60 seconds.

---

## T2. LAN Discovery Finds Pi; `/healthz` OK
Preconditions
- Pi online on same LAN; agent running; discovery enabled (mDNS/UDP as applicable).

Steps
1) Open app Setup/Devices. Wait for discovery (≤ 15s).
2) Confirm Pi appears with name/IP.
3) Tap device; app pings `/healthz`.
4) Independently verify: `curl http://<pi-ip>/healthz`.

Expected
- Device appears within discovery timeout; shows reachable status.
- `/healthz` returns HTTP 200 with JSON including at least `status: "ok"` and version/build.
- App surfaces version/build in UI or device details.

Negative/Edge
- Pi offline: app shows “not found” after timeout, offers retry/help.
- `/healthz` non‑200: error surfaced with actionable text; no crash.
- Multiple Pis online: all listed without duplication; stable ordering.

Artifacts
- Screenshot of device list; curl output from `/healthz`.

---

## T3. MQTT Over WebSocket; Sensor Stream Updates UI
Preconditions
- Broker reachable over WS/WSS; credentials configured in app or device.
- At least one device publishing telemetry.

Steps
1) Navigate to live dashboard bound to discovered device.
2) Observe connection indicator transitions (Connecting → Connected).
3) Publish test telemetry using MQTTX or mosquitto to device topic.
  - Example: `mosquitto_pub -h broker.local -p 8083 -V mqttv311 -t pots/pi-01/sensors -m '{"potId":"pi-01","timestamp":1735600000,"moisture":0.41,"temperature":25.2}'`
4) Confirm UI updates relevant tiles/graphs within 2s.

Expected
- WS connect succeeds; no mixed‑content errors on WSS.
- Incoming messages update only the corresponding device’s UI (correct filtering by `deviceId`).
- Connection loss shows a non‑blocking banner; auto‑reconnect with backoff resumes stream.

Negative/Edge
- Publish malformed JSON: app ignores with logged warning; UI stable.
- Subscribe to non‑existent topic: app handles gracefully; no spinner freeze.
- TLS with self‑signed cert (if supported): app presents expected UX or documented limitation.

Artifacts
- Screen recording of publish → UI change; app logs showing WS connect and message handling.

---

## T4. BLE Provisioning Raspberry Pi (SSID → Connect → Live)
Preconditions
- Phone Bluetooth ON; location permission (Android) not yet granted.
- Pi advertising BLE provisioning service.

Steps
1) Open Setup screen (not at app launch).
2) Observe OS prompts (Bluetooth/Location/Local Network as applicable) appear here only; grant when asked.
3) Start scan; select the Pi.
4) Fetch SSID list from Pi; choose `TestLab-2G`; enter `P@ssw0rd!`.
5) Send credentials; wait for Pi to report success.
6) App switches to LAN discovery; device transitions to Live.
7) Validate `/healthz` and live dashboard load.

Expected
- SSID list loads within 10s; hidden SSID supported via manual entry.
- Success status returns within provisioning timeout (≤ 90s).
- Discovery flips from Provisioning → Live automatically; no manual refresh required.

Negative/Edge
- Wrong password: provisioning fails with clear error; allows retry without re‑scan.
- SSID disappears mid‑flow: app handles gracefully; allows manual SSID entry.
- Phone moves out of BLE range: resumes or restarts flow without crash.

Artifacts
- Screen recording; timestamps for each step; app logs with BLE events.

---

## T5. BLE Provisioning ESP32 (PoP Required → Appears Under /devices)
Preconditions
- ESP32 in BLE provisioning mode with PoP `abcd1234`.

Steps
1) On Setup, scan and select ESP32.
2) App prompts for PoP; enter invalid `badpop` → expect failure.
3) Re‑enter valid `abcd1234`.
4) Choose SSID `TestLab-2G`; enter password; complete provisioning.
5) App confirms success and shows device under Devices or via API `/devices`.

Expected
- Invalid PoP yields explicit “invalid PoP/authorization failed” message; flow remains recoverable.
- With valid PoP, provisioning completes ≤ 60s; device appears under `/devices` with correct metadata (id, type, firmware).
- MQTT connects and telemetry appears for the new device.

Negative/Edge
- Attempt provisioning with already‑provisioned ESP32: app detects and offers reset.
- Power‑cycle mid‑provision: app shows recoverable state and instructions.

Artifacts
- Screenshot of device entry; curl or app view of `/devices` including new device.

---

## T6. SoftAP Fallback When BLE Disabled
Preconditions
- Phone Bluetooth OFF; ESP32/agent supports SoftAP fallback (SSID e.g., `ProjectPlant-XXXX`).

Steps
1) Enter Setup; confirm BLE is disabled and app proposes SoftAP.
2) In OS Wi‑Fi settings, join `ProjectPlant-XXXX` AP; return to app/captive portal.
3) Provide SSID/password; submit and wait for handover.
4) Device reboots/joins LAN; phone auto‑returns to normal Wi‑Fi.
5) App discovers device on LAN; open dashboard.

Expected
- Captive portal or in‑app SoftAP flow works end‑to‑end without manual IP entry.
- After handover, SoftAP disappears; device reachable on LAN within 60s.
- No stray permission prompts outside Setup.

Negative/Edge
- 5GHz‑only Wi‑Fi: app communicates 2.4GHz requirement clearly.
- Phone remains stuck on SoftAP: app guides user to switch back; discovery re‑attempts.

Artifacts
- Screen recording of SoftAP join and handover.

---

## T7. Permissions Prompts Only on Setup Screen
Preconditions
- Fresh install or cleared app permissions.

Steps
1) Launch app; navigate around Home/Dashboard without entering Setup.
2) Confirm no OS permission prompts appear.
3) Enter Setup; trigger BLE scan and LAN discovery.
4) Observe prompts: iOS (Bluetooth, Local Network), Android (Bluetooth, Nearby Devices/Location).
5) Deny once; see in‑app rationale; then grant via prompt.
6) Revisit Home; confirm no additional prompts occur.

Expected
- Prompts appear only after entering Setup and starting relevant operations.
- Deny flows are handled with in‑app education and retry paths.
- Granted permissions are not re‑prompted unless revoked in OS settings.

Negative/Edge
- Background → foreground transitions do not trigger prompts outside Setup.
- App upgrade preserves granted permissions; no surprise prompts.

Artifacts
- Screenshots of prompts and their timing context.

---

## Regression & Integration Checks
- Multiple devices online: ensure correct device scoping for discovery and MQTT subscriptions.
- Offline broker: app surfaces clear offline state and backs off reconnects.
- Network change (Wi‑Fi → LTE → Wi‑Fi): app disconnects/reconnects cleanly.
- Time skew on device: timestamps rendered correctly (no graph jumps/NaNs).

## Exit Criteria
- All scenarios T1–T7 pass on both platforms or documented with acceptable mitigations.
- No high‑severity defects open; medium defects have workarounds documented.

## Reporting
- Capture logs and screenshots for each failure.
- Record device IDs, firmware versions, and app build numbers for reproducibility.
