# ProjectPlant UI

This Vite + React + Tailwind app provides the monitoring dashboard for the ProjectPlant Hub.

## Prerequisites
- Node.js 18+
- Preferred: launch the full local stack with `powershell -ExecutionPolicy Bypass -File ..\..\scripts\dev-stack.ps1`
- Debug-only manual mode: a FastAPI hub reachable by the Vite proxy target

## Getting started
```
npm install
npm run dev
```
Run these commands inside `apps/web_ui`. Manual `npm run dev` is debug-only and defaults to `http://127.0.0.1:5173` with `/api` proxied to `http://127.0.0.1:8000`.

If the hub backend is not listening on `8000`, set the proxy target explicitly before starting Vite:
```powershell
$env:PROJECTPLANT_HUB_URL = "http://127.0.0.1:8001"
npm run dev
```

Demo mode now renders the main dashboard shell without a live hub. Live controls, diagnostics, and other hub-backed panels stay visible but disabled until you switch back to Live mode in Settings.

For launcher-driven recovery, `scripts/dev-stack.ps1` picks a free UI port, sets `PROJECTPLANT_HUB_URL`, and enables `PROJECTPLANT_STRICT_PORTS=1` so Vite does not silently drift to another port.

## Setup Wizard
`/setup` is currently a monitor and recovery guide, not a device provisioner.

- Supported today: fallback Wi-Fi from `hardware_config.local.c` / `hardware_config.c`, or waiting for an already provisioned node to reconnect.
- Not shipped in this repo: a BLE mobile provisioning app.
- Not implemented in the current firmware/UI combination: a browser-based SoftAP provisioning portal or a button-triggered re-entry flow.

## Testing
```
npm test
```
Vitest and Testing Library power the unit tests. CSS is processed through Tailwind for component snapshots.

## Build
```
npm run build
npm run preview
```
The build output lives in `dist/` and can be served by any static host or bundled with Tauri/Capacitor later.

## Google Sign-In (optional)
Set `VITE_GOOGLE_CLIENT_ID` in your UI environment if you want to render the native Google Sign-In button in Settings.
The hub must also be configured with `GOOGLE_OAUTH_ENABLED=true` and matching `GOOGLE_OAUTH_CLIENT_IDS`.

## Apple Sign-In (optional)
Set `VITE_APPLE_CLIENT_ID` (and optionally `VITE_APPLE_REDIRECT_URI`) in your UI environment to enable Apple sign-in on the login page.
The hub must also be configured with `APPLE_OAUTH_ENABLED=true` and matching `APPLE_OAUTH_CLIENT_IDS`.

## Debug Master Account (optional)
Set `VITE_DEBUG_MASTER_USER_ID` (and optionally `VITE_DEBUG_MASTER_USER_NAME`) to preload a fallback local user id for development while unauthenticated.
Use `/api/v1/auth/local` to obtain a bearer token with email/password.
