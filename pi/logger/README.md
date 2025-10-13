# ProjectPlant Live Logger

Maintains a 72-hour "live" window of telemetry for dashboards/controls and
archives anything older into append-only CSV files for long-term storage.

## Features

- Polls a configurable local weather JSON endpoint every minute (default).
- Stores normalized fields in `data/weather_live.sqlite`.
- Retains the most recent 72 hours (configurable) of readings in SQLite.
- Every 10 minutes (configurable) moves older rows to
  `data/history/YYYY-MM/YYYY-MM-DD.csv`.
- Keeps the full raw payload alongside extracted metrics, making it easy to
  add new dimensions later.

## Running Manually

```bash
python -m pi.logger.live_logger \
  --weather-url http://localhost:9000/api/weather/live \
  --source-id backyard_station
```

Key CLI flags (mirrored by environment variables):

| Flag                    | Env var                   | Default                      |
|-------------------------|---------------------------|------------------------------|
| `--weather-url`         | `WEATHER_URL`             | _required_                   |
| `--source-id`           | `WEATHER_SOURCE`          | `local_weather`              |
| `--db`                  | `WEATHER_LIVE_DB`         | `data/weather_live.sqlite`   |
| `--history-dir`         | `WEATHER_HISTORY_DIR`     | `data/history`               |
| `--retention-hours`     | `WEATHER_RETENTION_HOURS` | `72`                         |
| `--poll-seconds`        | `WEATHER_POLL_SECONDS`    | `60`                         |
| `--archive-interval`    | `WEATHER_ARCHIVE_INTERVAL`| `600` (10 minutes)           |
| `--log-level`           | `WEATHER_LOG_LEVEL`       | `INFO`                       |

The script is intentionally lightweight (standard library only) so it can run
on a Raspberry Pi or similar edge device.

## Integrating With Pots

The `LiveArchive` class exported in `pi/logger/__init__.py` can be reused by
other services (e.g. an MQTT consumer that ingests telemetry from the pots).
Import it, normalize each payload into a `NormalizedRecord`, then call
`archive.insert(record)` and periodically `archive.archive_old()`.

