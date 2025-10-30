# Provisioning Observability

The hub now emits structured events for BLE/SoftAP provisioning so operators can track
success rates, diagnose pairing failures, and trigger alerts when onboarding gets stuck.

## Event Stream

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROVISION_EVENT_LOG` | `data/provisioning/events.jsonl` | JSONL log capturing wait attempts, state messages, and outcomes. Set to blank to disable. |

Each line is a UTF-8 JSON object with an ISO8601 timestamp and event payload. Example:

```json
{"timestamp":"2025-02-12T23:11:02.183Z","event":"wait_success","device_id":"AABBCC112233","method":"ble","elapsed":4.2,"fresh":true}
```

### Event Types

| Event | Description |
| --- | --- |
| `wait_start` | UI/mobile app requested `/provision/wait` (records method, timeout, require_fresh). |
| `wait_success` | A device satisfied the waiter (includes elapsed seconds and freshness). |
| `wait_timeout` | Request expired without seeing a matching device. |
| `wait_cached` | The hub returned an already-known device immediately (require_fresh was false). |
| `state_message` | MQTT `plant/<id>/state` message processed (flags retained payloads and whether the device record was created). |

## Shipping the Log

Use the same pattern as HRRR monitoring: tail the JSONL file with Promtail/Fluent Bit and
label by `event`. A ready-to-use Promtail snippet lives at
`ops/observability/promtail-provisioning.yaml`; deploy it as-is or merge into your
existing scrape config. The relevant section is shown below:

```yaml
scrape_configs:
  - job_name: projectplant_provisioning
    static_configs:
      - targets: [localhost]
        labels:
          job: provisioning
          __path__: /opt/projectplant/data/provisioning/events.jsonl
    pipeline_stages:
      - json:
          expressions:
            event: event
            device_id: device_id
            method: method
            elapsed: elapsed
            retained: retained
            waiters: waiters_notified
      - labels:
          event:
          method:
          retained:
```

## Metrics & Alerts

* Success rate: `sum(rate({job="provisioning",event="wait_success"}[15m]))`
* Timeout rate: `sum(rate({job="provisioning",event="wait_timeout"}[15m]))`
* Median time-to-online: use `quantile_over_time` on the `elapsed` field.
* Device creation: filter `state_message` events with `created=true` to confirm new devices appear.

Alert when provisioning requests time out for more than 10 minutes. A pre-canned
Prometheus rule is checked into `ops/observability/alerts/provisioning_alerts.yaml`:

## Troubleshooting Workflow

1. **Timeouts climbing** – inspect recent `state_message` entries; retained `true` with no `created` entries usually means the hub is only seeing stale retained payloads.
2. **Success but long elapsed** – compare `elapsed` distribution, verify Wi-Fi credentials and RSSI, and confirm MQTT broker latency.
3. **No state messages** – confirm `plant/<id>/state` publishing on the firmware (BLE handshake may have failed).

Disable the log in development by setting `PROVISION_EVENT_LOG=` (empty) or overriding in tests via the settings fixture.
      - alert: ProjectPlantProvisioningTimeouts
        expr: sum(rate({job="provisioning",event="wait_timeout"}[10m])) > 0
        for: 10m
        labels:
          severity: warning
          team: projectplant
        annotations:
          summary: "Provisioning timeouts detected"
          description: |
            No device satisfied provisioning waiters in the last 10 minutes.
            Check BLE advertising, Wi-Fi credentials, and hub MQTT connectivity.
