# ProjectPlant Hub (FastAPI)

ProjectPlant Hub is the backend API for ProjectPlant. It aggregates sensor telemetry, enriches plant knowledge, calculates irrigation recommendations, and bridges the MQTT edge network with the web UI.

## Feature Highlights
- Versioned REST API (`/api/v1`) with shared FastAPI middleware, request logging, and CORS configuration.
- Weather ingestion from weather.gov with caching, station resolution, and normalization for UI consumption.
- Plant intelligence that merges local reference data with remote sources (POWO, iNaturalist) and caches suggestions + care profiles.
- Penman-Monteith irrigation modeller that turns climate samples into actionable watering guidance for smart pots and garden zones.
- Local catalog of pots, irrigation zones, and plant records with mock data to bootstrap the UI.
- Optional MQTT connection (asyncio-mqtt) to publish/subscribe to hardware devices, ready for local Mosquitto.
- Mock telemetry generator for rapid UI development when hardware is offline.

## API Overview

| Endpoint | Purpose |
| --- | --- |
| `GET /` / `GET /health` | Service metadata and readiness probe. |
| `GET /api/v1/health` / `GET /api/v1/info` | Versioned status plus runtime configuration snapshot. |
| `POST /api/v1/auth/local` | Sign in with ProjectPlant email/password account and mint hub access token. |
| `POST /api/v1/auth/google` | Verify Google ID token, upsert account, and mint hub access token. |
| `POST /api/v1/auth/apple` | Verify Apple ID token, upsert account, and mint hub access token. |
| `GET /api/v1/mock/telemetry?samples=` | Synthetic climate telemetry for charts and testing. |
| `GET /api/v1/weather/local?lat=&lon=&hours=` | Recent station observations (0.5-72 h windows) with HRRR solar overlay for ET workflows. |
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

Settings are loaded via Pydantic from `apps/hub_api/.env` (case-insensitive keys) and environment variables. Key options:

| Variable | Description | Default |
| --- | --- | --- |
| `APP_NAME`, `APP_VERSION` | Displayed metadata in root endpoints. | `ProjectPlant Hub`, `0.1.0` |
| `DEBUG` | Enables verbose logging + exception traces. Accepts booleans plus aliases such as `debug`, `development`, `release`, and `production`. | `true` |
| `CORS_ORIGINS` | Origins allowed to call the API. Accepts JSON array or comma list. | `[*]` |
| `PORT` | Uvicorn bind port when launched via helper scripts. | `8000` |
| `AUTH_JWT_SECRET` | Secret used to sign hub bearer tokens (set a strong value in production). | `change-me-in-production` |
| `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE` | JWT claim values used when issuing and validating bearer tokens. | `projectplant-hub`, `projectplant-clients` |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | Bearer token lifetime in seconds. | `3600` |
| `GOOGLE_OAUTH_ENABLED` | Enables `POST /api/v1/auth/google`. | `false` |
| `GOOGLE_OAUTH_CLIENT_IDS` | Allowed Google OAuth client IDs (JSON array or comma list). | `[]` |
| `GOOGLE_OAUTH_HOSTED_DOMAIN` | Optional Google Workspace domain restriction. | unset |
| `APPLE_OAUTH_ENABLED` | Enables `POST /api/v1/auth/apple`. | `false` |
| `APPLE_OAUTH_CLIENT_IDS` | Allowed Apple Services IDs (JSON array or comma list). | `[]` |
| `MQTT_ENABLED` | Toggle MQTT startup handshake. | `false` |
| `MQTT_*` | Broker connection details (host, port, credentials, TLS). | See `.env` |
| `PROVISION_EVENT_LOG` | JSONL log path for provisioning wait/state metrics (`""` disables). Relative paths resolve from `apps/hub_api`. | `data/provisioning/events.jsonl` |
| `WEATHER_*` | Timeouts, cache TTL, and user-agent for weather.gov. | See `.env` |
| `HRRR_SOLAR_HISTORY_DB` | SQLite path for extracted NOAA HRRR solar history used by ET calculations. | `data/hrrr/solar_history.sqlite` |
| `HRRR_SOLAR_RETENTION_HOURS` | Retention window for extracted HRRR solar history. | `72` |
| `POWO_BASE_URL` | Override remote plant data provider. | production APIs |
| `INAT_BASE_URL` | Override iNaturalist API base URL. | production API |

Update `apps/hub_api/.env` or export env vars before starting the server. When `MQTT_ENABLED=true`, ensure a broker is reachable or the startup will log connection failures.

## Fast Local Start

### Standard start
```bash
cd apps/hub_api
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8000
```

This manual mode is debug-only. It does not inject the managed control-plane env, generated CORS origins, or dynamic UI proxy URL that the local recovery launcher provides.

If you start `apps/web_ui` manually while the hub is on a non-default port, point the UI proxy at that backend before launching Vite:
```powershell
$env:PROJECTPLANT_HUB_URL = "http://127.0.0.1:<hub-port>"
```

From the repo root you can also use:
```bash
make hub
```

To recover the full local managed stack on Windows:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1
```

The launcher is the supported local recovery path. It keeps fleet pinned to `8100`, picks free ports for the hub and both UIs, and prints both localhost and LAN URLs after startup.

Visit `http://localhost:8000/health` or `http://localhost:8000/docs` to confirm the service is running.

## Optional Services

- **Local MQTT broker**: `docker compose -f ops/mosquitto/docker-compose.yml up` spins up Mosquitto with the defaults in `.env`.
- **Frontend**: Run the Vite UI (`apps/web_ui`) alongside the hub to exercise the full stack.

## Development Workflow
- Run tests: `pytest` inside your venv.
- Static checks: `ruff check`, `black --check apps/hub_api/src`, and `mypy apps/hub_api/src`.
- Weather and plant services hit public APIs; tests use mocks and are network-safe.
- Stop the app with `Ctrl+C`; FastAPI triggers shutdown routines that close MQTT and HTTP clients cleanly.

## Project Layout

```
apps/hub_api/
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
