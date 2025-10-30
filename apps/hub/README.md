﻿# ProjectPlant Hub (FastAPI)

ProjectPlant Hub is the backend API for ProjectPlant. It aggregates sensor telemetry, enriches plant knowledge, calculates irrigation recommendations, and bridges the MQTT edge network with the web UI.

## Feature Highlights
- Versioned REST API (`/api/v1`) with shared FastAPI middleware, request logging, and CORS configuration.
- Weather ingestion from weather.gov with caching, station resolution, and normalization for UI consumption.
- Plant intelligence that merges local reference data with remote sources (POWO, Trefle, OpenFarm) and caches suggestions + care profiles.
- Penman-Monteith irrigation modeller that turns climate samples into actionable watering guidance for smart pots and garden zones.
- Local catalog of pots, irrigation zones, and plant records with mock data to bootstrap the UI.
- Optional MQTT connection (asyncio-mqtt) to publish/subscribe to hardware devices, ready for local Mosquitto.
- Mock telemetry generator for rapid UI development when hardware is offline.

## API Overview

| Endpoint | Purpose |
| --- | --- |
| `GET /` / `GET /health` | Service metadata and readiness probe. |
| `GET /api/v1/health` / `GET /api/v1/info` | Versioned status plus runtime configuration snapshot. |
| `GET /api/v1/mock/telemetry?samples=` | Synthetic climate telemetry for charts and testing. |
| `GET /api/v1/weather/local?lat=&lon=&hours=` | Recent NOAA observations (0.5-48 h windows) with coverage hints. |
| `POST /api/v1/irrigation/estimate` | Penman-Monteith evapotranspiration and watering recommendation engine. |
| `GET /api/v1/plants/reference` | Local reference catalog for popular species. |
| `GET /api/v1/plants/suggest?query=` | Remote + local autocompletion for plant search. |
| `GET /api/v1/plants/details?scientific_name=` | Rich taxonomy, distribution, and care guidance. |
| `GET /api/v1/plants/pots` | Smart pot models with volume/feature metadata. |
| `GET /api/v1/plants/zones` | Irrigation zones configured for deployments. |
| `GET /api/v1/plants/detect-pot` | Helper that picks the next available smart pot profile. |
| `GET /api/v1/plants` / `POST /api/v1/plants` | In-memory plant records with create + list operations. |

Interactive docs are available at `http://localhost:8000/docs` and `http://localhost:8000/redoc`.

## Configuration

Settings are loaded via Pydantic from `apps/hub/.env` (case-insensitive keys) and environment variables. Key options:

| Variable | Description | Default |
| --- | --- | --- |
| `APP_NAME`, `APP_VERSION` | Displayed metadata in root endpoints. | `ProjectPlant Hub`, `0.1.0` |
| `DEBUG` | Enables verbose logging + exception traces. | `true` |
| `CORS_ORIGINS` | Origins allowed to call the API. Accepts JSON array or comma list. | `[*]` |
| `PORT` | Uvicorn bind port when launched via helper scripts. | `8000` |
| `MQTT_ENABLED` | Toggle MQTT startup handshake. | `false` |
| `MQTT_*` | Broker connection details (host, port, credentials, TLS). | See `.env` |
| `PROVISION_EVENT_LOG` | JSONL log path for provisioning wait/state metrics (`""` disables). | `data/provisioning/events.jsonl` |
| `WEATHER_*` | Timeouts, cache TTL, and user-agent for weather.gov. | See `.env` |
| `TREFLE_TOKEN` | Optional token to enrich plant data via Trefle. | empty |
| `OPENFARM_BASE_URL`, `POWO_BASE_URL` | Override remote plant data providers. | production APIs |

Update `apps/hub/.env` or export env vars before starting the server. When `MQTT_ENABLED=true`, ensure a broker is reachable or the startup will log connection failures.

## Fast Local Start

### Option A: uv (recommended)
```bash
cd apps/hub
uv sync --extra dev
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Option B: pip + venv
```bash
cd apps/hub
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

From the repo root you can also use:
```bash
make hub
```

Visit `http://localhost:8000/health` or `http://localhost:8000/docs` to confirm the service is running.

## Optional Services

- **Local MQTT broker**: `docker compose -f ops/mosquitto/docker-compose.yml up` spins up Mosquitto with the defaults in `.env`.
- **Frontend**: Run the Vite UI (`apps/ui`) alongside the hub to exercise the full stack.

## Development Workflow
- Run tests: `uv run pytest` (or `pytest` inside your venv).
- Static checks: `uv run ruff check` for linting, `uv run black --check apps/hub/src` for formatting, and `uv run mypy apps/hub/src` for typing.
- Weather and plant services hit public APIs; tests use mocks and are network-safe. Supply `TREFLE_TOKEN` in `.env` for richer plant data during manual testing.
- Stop the app with `Ctrl+C`; FastAPI triggers shutdown routines that close MQTT and HTTP clients cleanly.

## Project Layout

```
apps/hub/
  src/           # FastAPI app, routers, services, and helpers
    api/v1/     # Routers for weather, irrigation, plants, mock data
    services/   # Weather, plant lookup, irrigation modelling, MQTT helpers
    mock/       # Synthetic telemetry payloads for UI prototyping
    config.py   # Pydantic settings and env handling
  tests/        # pytest suite (API, services, modelling, MQTT)
  README.md     # This guide
  .env          # Local development defaults
```

## Next Steps
- Extend the MQTT manager with topic handlers to relay live telemetry.
- Persist plant records in a real database (currently in-memory).
- Expand the irrigation model with localized weather stations or soil sensors.
