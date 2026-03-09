# Protocol (placeholder)
MQTT topics and JSON schemas here. Next step will add initial schema stubs.

## MQTT payload notes (firmware)
These are minimal notes to keep the UI and hub aligned with firmware fields.

### Command topic
`pots/{potId}/command`

Accepted fields (boolean or "on"/"off"):
- `pump`
- `icZone1` (IC Zone 1 override; `ic_zone1` also accepted)
- `fan`
- `mister`
- `light`

Optional fields:
- `duration_ms` (uint32, for timed on)
- `requestId` (string, echoed back in status/sensor read)
- `action` or `command` values: `sensor_read` or `sensorRead`
- `deviceName` (string, update stored display name; `displayName` accepted)
- `schedule` (object with `light`/`pump`/`mister`/`fan`, each containing `enabled`, `startTime`, `endTime`)
- `schedule.icZone1` (optional; same timer payload shape)
- `tzOffsetMinutes` (integer, optional fixed offset for schedule evaluation on device)
- `scheduleUpdatedAtMs` (number, optional epoch ms used for schedule recency)

### Common payload fields (status + sensors)
- `potId` (string)
- `timestampMs` (number, epoch ms)
- `timestamp` (string, ISO8601)
- `deviceName` (string, current display name)
- `isNamed` (bool, true if display name was user-set)

### Status topic
`pots/{potId}/status`

Key fields published by firmware:
- `status` (string)
- `fwVersion` (string)
- `requestId` (string, optional)
Status values include `online`, device override events, and naming updates (`name_updated`, `name_update_failed`).
Schedule sync status may include `schedule_state` with a `schedule` payload and `scheduleUpdatedAtMs`.

### Sensor topic
`pots/{potId}/sensors`

Key fields published by firmware:
- `valveOpen`, `icZone1On`, `fanOn`, `misterOn`, `lightOn`

## Fleet payload notes (Pi hub control plane)
These schemas define the hub-fleet control plane contract for Raspberry Pi hubs.

### Hub identity
- `hubId` (string, format `hub-xxxxxxxxxxxx`)
- `publicKey` (string, Ed25519 public key encoded as hex)
- `hostname` (string)
- `advertisedName` (string, optional)
- `site` (string, optional)
- `channel` (`dev` | `beta` | `stable`)

### Hub inventory
- `localIpAddresses` (string[])
- `agentVersion` (string)
- `hubVersion` (string, optional)
- `uiVersion` (string, optional)
- `managedServices` (string[])
- `diskFreeBytes` (number, optional)
- `uptimeSeconds` (number, optional)
- `lastBootAt` (string, ISO8601, optional)
- `mosquittoEnabled` (bool)
- `mqttBrokerMode` (`local` | `external`)

### Agent enrollment
`POST /api/v1/hubs/enroll`

Request:
- `bootstrapToken`
- `hubId`
- `publicKey`
- `inventory`

Response:
- `hub`
- `pollIntervalSeconds`
- `serverTime`

### Agent check-in
`POST /api/v1/hubs/check-in`

Headers:
- `X-ProjectPlant-Hub-Id`
- `X-ProjectPlant-Timestamp`
- `X-ProjectPlant-Signature` (base64 Ed25519 signature over `timestamp + "\\n" + rawBody`)

Body:
- `hubId`
- `inventory`
- `operationResult` (optional)

Response:
- `pollIntervalSeconds`
- `serverTime`
- `desiredOperation` (optional)

### Desired operation
- `operationId`
- `type` (`install_release` | `rollback_release` | `refresh_inventory`)
- `releaseId` (optional)
- `rolloutId` (optional)
- `manifest` (optional)
- `manifestUrl` (optional)
- `signatureUrl` (optional)
- `artifacts` (optional)

### Release manifest
- `releaseId`
- `channel`
- `hubVersion`
- `uiVersion`
- `agentMinVersion`
- `artifacts`: array of `{ name, sha256, url? }`
- `managedServices`
- `healthChecks`
- `rollbackWindowSeconds`
