Android secure storage and provisioning hardening

- Secure storage: The Android build now registers a Capacitor plugin `SecureStorage` backed by EncryptedSharedPreferences (AES‑256). The SDK prefers this plugin for persisting runtime env (e.g., `baseUrl`, `mqttUrl`) when running under Capacitor.
- No Wi‑Fi password persistence: The Setup Wizard never writes Wi‑Fi passwords to storage and clears the in‑memory password immediately after sending it over BLE.
- BLE provisioning rotation/disable:
  - ESP32: Provisioning is stopped after success and only re‑enabled via a physical long‑press (see `esp32/fw/main/main.c`).
  - Raspberry Pi service: Advertising stops after success and the Proof‑of‑Possession (PoP) string is rotated to prevent reuse. See `pi/ble-provision/pp_ble_provision.py`.

Usage in app code

- Access secure storage from TypeScript via `@projectplant/native-bridge`:
  - `SecureStorage.getItem({ key })` → `{ value }`
  - `SecureStorage.setItem({ key, value })`
  - Or use `namespacedStorage(namespace)` helper for scoped keys.

Notes

- The SDK will fall back to `@capacitor/preferences` if the native secure storage plugin is not available (e.g., web browser).
- If you later add API auth tokens or MQTT credentials to the SDK, store them via this secure storage to keep secrets encrypted at rest.

