# HRRR Observability Playbook

This guide explains how to monitor the NOAA HRRR ingestion pipeline that now powers `/weather/hrrr/*` endpoints.

## Data Sources

| Source | Path | Purpose |
| --- | --- | --- |
| Fetch log | `<HRRR_CACHE_DIR>/fetch_status.jsonl` | JSONL stream appended after every refresh attempt (success or error). |
| Health API | `GET /weather/hrrr/health` | Readiness probe that flags scheduler stoppage, stale data, or recent fetch failures. |
| Status API | `GET /weather/hrrr/status` | Rich payload used by dashboards for cache size, presets, and recent fetch history. |

All timestamps are emitted in UTC with second precision.

## Shipping the Fetch Log

Use any log forwarder that can tail JSON lines. Example Promtail snippet:

```yaml
scrape_configs:
  - job_name: projectplant_hrrr
    static_configs:
      - targets: [localhost]
        labels:
          job: hrrr_fetch
          __path__: /opt/projectplant/data/hrrr/fetch_status.jsonl
    pipeline_stages:
      - json:
          expressions:
            status: status
            lat: lat
            lon: lon
            persisted: persisted
            duration: duration_s
            run_cycle: run_cycle
            forecast_hour: forecast_hour
            valid_time: valid_time
      - labels:
          status:
          persisted:
      - timestamp:
          source: timestamp
          format: RFC3339
```

Once the stream arrives in Loki (or another log store), you can build metrics:

- **Download failure rate**: `sum(count_over_time({job="hrrr_fetch",status="error"}[15m]))`
- **Successful refresh cadence**: `sum(rate({job="hrrr_fetch",status="success"}[1h]))`
- **Persist rate**: `avg_over_time(({job="hrrr_fetch"} |= "persisted":true)[1h])`

## Grafana Dashboard Template

Import the following JSON into Grafana (replace the data source UID `loki-default` with your Loki data source ID):

```json
{
  "title": "ProjectPlant HRRR",
  "uid": "projectplant-hrrr",
  "version": 1,
  "panels": [
    {
      "type": "timeseries",
      "title": "Successful Refreshes",
      "datasource": { "type": "loki", "uid": "loki-default" },
      "fieldConfig": { "defaults": { "unit": "short" } },
      "targets": [
        {
          "expr": "sum(rate({job=\"hrrr_fetch\",status=\"success\"}[5m]))",
          "legendFormat": "Success/min"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Download Failures",
      "datasource": { "type": "loki", "uid": "loki-default" },
      "fieldConfig": { "defaults": { "color": { "mode": "palette-classic" } } },
      "targets": [
        {
          "expr": "sum(rate({job=\"hrrr_fetch\",status=\"error\"}[5m]))",
          "legendFormat": "Errors/min"
        }
      ]
    },
    {
      "type": "stat",
      "title": "Time Since Last Refresh",
      "datasource": { "type": "loki", "uid": "loki-default" },
      "fieldConfig": { "defaults": { "unit": "m" } },
      "targets": [
        {
          "expr": "(time() - max_over_time(({job=\"hrrr_fetch\",status=\"success\"} | unwrap timestamp)[1d])) / 60",
          "legendFormat": "minutes"
        }
      ]
    }
  ]
}
```

## Alerting Rules

### 1. Download Failure Burst (Prometheus-style)

```yaml
- alert: ProjectPlantHRRRDownloadFailures
  expr: sum(rate({job="hrrr_fetch",status="error"}[10m])) > 0
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "HRRR downloads are failing"
    description: "ProjectPlant observed at least one failed HRRR download in the last 10 minutes. Check S3 access, network, or eccodes availability."
```

### 2. Stale HRRR Data

Leverage the health endpoint if you prefer HTTP-based probes, or run the following LogQL derived alert:

```yaml
- alert: ProjectPlantHRRRStaleData
  expr: (time() - max_over_time(({job="hrrr_fetch",status="success"} | unwrap timestamp)[2h])) / 60 > 30
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "HRRR data stale"
    description: "No successful HRRR refresh in the last 30 minutes. Check scheduler status via /weather/hrrr/health."
```

Alternatively, configure your uptime system to call `GET /weather/hrrr/health` and alert whenever `ok=false` or `stale=true`.

## Health Check Integration

- **Kubernetes**: configure an HTTP `ReadinessProbe` hitting `/weather/hrrr/health`. Fail the probe on non-2xx or when the JSON body contains `ok=false`.
- **Docker Compose**: add `healthcheck: { test: ["CMD", "curl", "-f", "http://hub:8000/weather/hrrr/health"] }` to the service definition. 

## Operational Runbook

1. **Fetch failures**: inspect the `detail` field in the latest JSON line or the `recent_fetch.detail` property returned by `/weather/hrrr/health`. Common issues include HTTP 404 (upstream lag), network DNS/TLS failures, or missing `eccodes`.
2. **Staleness**: if the scheduler stops, verify the hub logs for tracebacks and ensure the refresh preset is still active (`POST /weather/hrrr/schedule`).
3. **Disk pressure**: cache eviction runs automatically but relies on adequate permissions. Monitor `df -h` for the cache mount.

With these probes, dashboards, and alerts, you can quickly spot ingest regressions before they compromise irrigation recommendations.
