# ProjectPlant Agents Guide (Full-Stack)

This file is the shared playbook for AI agents working on ProjectPlant. Keep it concise, safe, and repeatable. Prefer small, focused changes and ask for missing context when needed.

## Mission & Scope
- Build and maintain the full stack: Hub API, UI, firmware, and edge services.
- Respect hardware safety (pumps, sensors, power) and guard secrets.
- Default to minimal, verifiable changes; avoid speculative refactors.

## Repo Map (quick mental model)
- `apps/hub/` FastAPI backend (telemetry, weather, plant intel, irrigation).
- `apps/ui/` Vite + React dashboard.
- `apps/web/` Vite + React web shell (mobile build entrypoint).
- `apps/android/` Capacitor Android wrapper.
- `firmware/esp32_pot/` ESP-IDF firmware for pot hardware.
- `packages/` shared TypeScript libraries (care-engine, design, protocol).
- `pi/` Raspberry Pi services (API, provisioning, logging).
- `ops/` operational tooling (MQTT broker, deployment helpers).

## Agent Command Palette (Claude/OpenAI-style)
Use these canonical commands as copy/paste recipes. Each command lists the working directory and exact shell commands.

### /workspace:install
```
pnpm install
```

### /hub:dev
Run the FastAPI hub locally.
```
cd apps/hub
uv sync --extra dev
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
Alt: `make hub` from repo root.

### /hub:test
```
cd apps/hub
uv run pytest
```

### /hub:lint
```
cd apps/hub
uv run ruff check
uv run black --check src
uv run mypy src
```

### /ui:dev
```
cd apps/ui
pnpm install
pnpm run dev
```
Alt from repo root: `pnpm -C apps/ui install` then `pnpm -C apps/ui dev`.

### /ui:test
```
cd apps/ui
pnpm test
```

### /ui:lint
```
cd apps/ui
pnpm run lint
```

### /web:dev
```
pnpm --filter @projectplant/web run dev
```

### /web:build
```
pnpm --filter @projectplant/web run build
```

### /web:preview
```
pnpm --filter @projectplant/web run preview
```

### /mobile:android:build
```
pnpm --filter @projectplant/android run build
```
Alt from repo root: `pnpm run mobile:android:build`.

### /mobile:android:open
```
pnpm --filter @projectplant/android run open
```
Alt from repo root: `pnpm run mobile:android:open`.

### /pkg:care-engine:build
```
pnpm --filter @projectplant/care-engine run build
```

### /pkg:care-engine:test
```
pnpm --filter @projectplant/care-engine run test
```

### /pkg:sdk:build
```
pnpm --filter @projectplant/sdk run build
```

### /pkg:sdk:test
```
pnpm --filter @projectplant/sdk run test
```

### /pkg:native-bridge:build
```
pnpm --filter @projectplant/native-bridge run build
```

### /firmware:build
```
cd firmware/esp32_pot
idf.py set-target esp32
idf.py build
```

### /firmware:flash
```
cd firmware/esp32_pot
idf.py -p <PORT> flash monitor
```

### /mosquitto:up
```
docker compose -f ops/mosquitto/docker-compose.yml up
```

### /pi:api:dev
```
cd pi/api
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
ENV=development uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Conventions
- Use `.env` files for local config; never commit secrets.
- Keep API changes backward compatible when possible (UI and firmware rely on endpoints and MQTT schema).
- Prefer adding tests for new hub routes or care-engine logic.
- Document new MQTT topics or payload fields in `packages/protocol/`.
- For JS/TS work, use `pnpm` (workspace aware); avoid `npm`/`yarn` in this repo.

## Safety & Guardrails
- Pump control is real hardware: default to "off" in tests and mocks.
- Do not change Wi-Fi, MQTT, or credentials defaults without explicit request.
- Avoid destructive commands (flash/erase) unless user confirms.

## When to Ask
- Missing hardware context (ports, device IDs, sensor calibration).
- Ambiguous scope between Hub/UI/Firmware responsibilities.
- Any request that affects deployments or live devices.
