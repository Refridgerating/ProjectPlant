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
| `WEATHER_*` | Timeouts, cache TTL, and user-agent for weather.gov. | See `.env` |
| `HRRR_ENABLED` | Turn NOAA HRRR ingestion on/off. Scheduler and endpoints disable when `false`. | `true` |
| `HRRR_BASE_URL` / `HRRR_DOMAIN` | Source bucket + sub-domain (`conus`, `alaska`, etc.) for GRIB downloads. | NOAA public S3 + `conus` |
| `HRRR_CACHE_DIR` | Filesystem path where GRIBs + fetch logs are stored. | `data/hrrr` |
| `HRRR_CACHE_MAX_AGE_MINUTES` | Minutes to keep cached GRIB files before eviction. | `360` |
| `HRRR_MAX_FORECAST_HOUR` | Preferred forecast lead (0-48) when computing target runs. | `18` |
| `HRRR_AVAILABILITY_DELAY_MINUTES` | Publication lag to subtract when selecting cycles. | `90` |
| `HRRR_DEFAULT_LAT` / `HRRR_DEFAULT_LON` | Coordinates used by the background refresh job. | unset |
| `HRRR_REFRESH_INTERVAL_MINUTES` | Default cadence (minutes) for the HRRR scheduler when no preset is chosen. | `60` |
| `POWO_BASE_URL` | Override remote plant data provider. | production APIs |
| `INAT_BASE_URL` | Override iNaturalist API base URL. | production API |

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

### HRRR Forecast Configuration

1. Set the default location (`HRRR_DEFAULT_LAT`/`HRRR_DEFAULT_LON`) in `apps/hub/.env` so the scheduler knows which grid point to refresh. You can also update the cadence at runtime through `POST /weather/hrrr/schedule` with `{ "interval_minutes": 15 }` or `60`.
2. Adjust `HRRR_MAX_FORECAST_HOUR` if you prefer deeper lead times (e.g., 24 hours). The service trims values above the configured horizon when computing `compute_target_run`.
3. Point `HRRR_CACHE_DIR` to fast local storage with ~2 GB free. The service stores GRIBs, companion metadata, and a JSONL fetch log at `<cache_dir>/fetch_status.jsonl` that powers observability dashboards.
4. Tune `HRRR_CACHE_MAX_AGE_MINUTES` and `HRRR_AVAILABILITY_DELAY_MINUTES` to match your deployment's tolerance for stale data and upstream publication lag.

See `docs/observability/hrrr_monitoring.md` for dashboards and alerting examples built on that fetch log.

## Optional Services

- **Local MQTT broker**: `docker compose -f ops/mosquitto/docker-compose.yml up` spins up Mosquitto with the defaults in `.env`.
- **Frontend**: Run the Vite UI (`apps/ui`) alongside the hub to exercise the full stack.

## Development Workflow
- Run tests: `uv run pytest` (or `pytest` inside your venv).
- Static checks: `uv run ruff check` for linting, `uv run black --check apps/hub/src` for formatting, and `uv run mypy apps/hub/src` for typing.
- Weather and plant services hit public APIs; tests use mocks and are network-safe.
- Stop the app with `Ctrl+C`; FastAPI triggers shutdown routines that close MQTT and HTTP clients cleanly.

Android release build
- See `docs/android-release.md` for keystore creation, signing config, shrinker/ProGuard rules, build output path, and `adb install` commands.

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
