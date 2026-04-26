# ProjectPlant

ProjectPlant is a full-stack smart plant platform. This repo contains the ESP32 pot firmware, MQTT and edge integrations, Python APIs, React dashboards, a Capacitor Android app, Raspberry Pi services, and shared TypeScript libraries that connect the whole system.

Use this README as the monorepo entrypoint for local setup, common development commands, and repo navigation. Subsystem-specific API details, configuration matrices, and hardware notes live in the linked docs for each area.

## What's In This Repo

| Path | Role |
| --- | --- |
| `apps/hub_api` | FastAPI hub API for telemetry, weather, plant intelligence, irrigation, auth, and device control. |
| `apps/fleet` | FastAPI fleet control plane for hub enrollment, releases, rollouts, and rollback workflows. |
| `apps/web_ui` | Main Vite + React dashboard for plant monitoring, setup, diagnostics, and controls. |
| `apps/fleet-ui` | Vite + React operator UI for fleet management workflows. |
| `apps/android` | Active Capacitor Android wrapper for the main app. It currently packages the `apps/web_ui` build output. |
| `apps/web` | Secondary Vite + React web shell and provisioning surface. Present in the repo, but not the primary Android build input. |
| `packages/*` | Shared libraries: `care-engine` for plant care logic, `sdk` for client/runtime helpers, `native-bridge` for Capacitor integrations, plus `protocol` and `design` as shared support packages. |
| `firmware/esp32_pot` | ESP-IDF firmware for the smart pot hardware. |
| `pi/*` | Raspberry Pi services such as the local API, update agent, logging, fallback AP, and BLE provisioning support. |
| `ops/*` | Operational tooling for local MQTT and signed release packaging/publishing. |

## Architecture at a Glance

```text
Smart pots / ESP32 firmware -> MQTT broker -> Hub API -> Hub UI / Android app
Pi hubs + update agent -> Fleet API -> Fleet UI / release tooling
Shared packages -> UI, web shell, and mobile runtime integrations
```

- `firmware/esp32_pot` publishes device state and accepts commands over MQTT.
- `apps/hub_api` bridges plant/device workflows to HTTP clients and local dashboards.
- `apps/web_ui` is the main dashboard surface, and `apps/android` wraps that UI for Android.
- `apps/web` remains available as a separate shell/provisioning surface.
- `apps/fleet`, `apps/fleet-ui`, `pi/update-agent`, and `ops/release` make up the hub fleet management path.

## Prerequisites

- `Node.js 18+`
- `pnpm 9`
- `Python 3.11+`
- Optional: `Docker` for the local Mosquitto broker
- `ESP-IDF 5.1+` for firmware work
- `Android Studio`, JDK, and `adb` for Android development and release builds

## Quick Start

The supported local recovery flow is the Windows launcher in `scripts/dev-stack.ps1`. It creates or reuses the Python virtual environments, installs Python requirements, resolves free local ports, and starts the main local surfaces together.

1. Install workspace dependencies:

```bash
pnpm install
```

2. Start the managed local stack:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1
```

3. If you already have `make` available, the repo shortcut is:

```bash
make stack
```

The launcher starts:

- Fleet API
- Hub API
- Fleet UI
- Hub UI

It prints both localhost and LAN URLs after startup. Manual per-app startup commands are still available for debugging, but they do not provide the same managed environment injection, dynamic port selection, or cross-service URL wiring as the launcher.

## Development Workflows

These commands are the current repo-supported entrypoints. For deeper setup, environment variables, or subsystem behavior, use the docs linked later in this README.

### Hub API

Debug/manual start:

```bash
cd apps/hub_api
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8000
```

Shortcut from the repo root:

```bash
make hub
```

### Fleet API

Debug/manual start:

```bash
cd apps/fleet
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8100
```

Shortcut from the repo root:

```bash
make fleet
```

### Hub UI

```bash
pnpm -C apps/web_ui dev --host 127.0.0.1 --port 5173
```

Shortcut from the repo root:

```bash
make ui
```

### Fleet UI

```bash
pnpm -C apps/fleet-ui dev --host 127.0.0.1 --port 5180
```

Shortcut from the repo root:

```bash
make fleet-ui
```

### Mobile Development

The active Android wrapper is `apps/android`, and it currently packages `apps/web_ui/dist`. Android live reload and packaged builds run against `apps/web_ui`, not `apps/web`.

Use the root package scripts:

```bash
pnpm run mobile:android:dev
pnpm run mobile:android:build
pnpm run mobile:android:open
```

- `mobile:android:dev` runs the main `apps/web_ui` Vite app for device live reload.
- `mobile:android:build` builds `apps/web_ui` first, then builds the Android project.
- `mobile:android:open` opens the native Android project in Android Studio.
- Signed APK and release signing steps are documented in [docs/android-release.md](docs/android-release.md).

### Secondary Web Shell (`apps/web`)

`apps/web` stays in the repo as a separate shell/provisioning surface. It is useful for targeted web-shell work, but it is not the primary Android build input today.

```bash
pnpm run dev:web
pnpm run build:web
```

### Shared Packages

```bash
pnpm --filter @projectplant/care-engine run build
pnpm --filter @projectplant/care-engine run test
pnpm --filter @projectplant/sdk run build
pnpm --filter @projectplant/sdk run test
pnpm --filter @projectplant/native-bridge run build
```

### Hub API Contracts

The Hub API contract is generated from FastAPI/Pydantic and consumed through `@projectplant/sdk`.
Regenerate contracts after changing Hub request or response models:

```bash
apps/hub_api/.venv/Scripts/python.exe apps/hub_api/scripts/export-openapi.py
pnpm --filter @projectplant/sdk run generate:openapi-types
pnpm --filter @projectplant/sdk run build
```

This updates `apps/hub_api/openapi.json` and `packages/sdk/src/generated/api-types.ts`. Do not hand-maintain duplicated HTTP API request/response shapes in UI code; add SDK aliases or client helpers and migrate UI slices incrementally.

### Local MQTT

```bash
docker compose -f ops/mosquitto/docker-compose.yml up
```

### Firmware

```bash
cd firmware/esp32_pot
idf.py set-target esp32
idf.py build
idf.py -p <PORT> flash monitor
```

## Testing and Checks

Use the checks below for the surface you are working on.

### Hub API

```bash
cd apps/hub_api
pytest
ruff check
black --check src
mypy src
```

### Fleet API

`apps/fleet` follows the same Python service pattern as the hub. Run its tests from `apps/fleet/tests` as needed after installing the local dev environment.

### Hub UI

```bash
pnpm -C apps/web_ui test
pnpm -C apps/web_ui run lint
```

### Shared Packages

```bash
pnpm --filter @projectplant/care-engine run test
pnpm --filter @projectplant/sdk run test
pnpm --filter @projectplant/care-engine run build
pnpm --filter @projectplant/sdk run build
pnpm --filter @projectplant/native-bridge run build
```

### Secondary Web Shell

```bash
pnpm run build:web
```

### Android

```bash
pnpm run mobile:android:build
```

### Firmware

```bash
cd firmware/esp32_pot
idf.py build
```

## Docs by Area

- [Hub API](apps/hub_api/README.md)
- [Fleet API](apps/fleet/README.md)
- [Hub UI](apps/web_ui/README.md)
- [ESP32 firmware](firmware/esp32_pot/README.md)
- [Plant care engine](packages/care-engine/README.md)
- [Protocol notes](packages/protocol/README.md)
- [Pi API](pi/api/README.md)
- [Update agent](pi/update-agent/README.md)
- [Android release guide](docs/android-release.md)
- [Release tooling](ops/release/README.md)
