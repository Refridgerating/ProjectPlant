# Protocol (placeholder)
MQTT topics and JSON schemas here. Next step will add initial schema stubs.

## MQTT payload notes (firmware)
These are minimal notes to keep the UI and hub aligned with firmware fields.

### Command topic
`pots/{potId}/command`

Accepted fields (boolean or "on"/"off"):
- `pump`
- `fan`
- `mister`
- `light`

Optional fields:
- `duration_ms` (uint32, for timed on)
- `requestId` (string, echoed back in status/sensor read)
- `action` or `command` values: `sensor_read` or `sensorRead`
- `deviceName` (string, update stored display name; `displayName` accepted)
- `schedule` (object with `light`/`pump`/`mister`/`fan`, each containing `enabled`, `startTime`, `endTime`)
- `tzOffsetMinutes` (integer, optional fixed offset for schedule evaluation on device)

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

### Sensor topic
`pots/{potId}/sensors`

Key fields published by firmware:
- `valveOpen`, `fanOn`, `misterOn`, `lightOn`
