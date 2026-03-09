# ProjectPlant Update Agent

The ProjectPlant update agent runs on each Raspberry Pi hub. It owns hub identity,
enrollment, signed check-ins, release staging, activation, health validation, and rollback.

## Files
- `agent/config.py`: load `/etc/projectplant/fleet.env` and local runtime paths.
- `agent/identity.py`: stable `hubId` and Ed25519 key management.
- `agent/fleet_client.py`: HTTPS enrollment and signed check-ins.
- `agent/installer.py`: artifact download, verification, activation, and rollback.
- `agent/main.py`: long-running poll loop.

## Run manually
```bash
cd /opt/projectplant/current/pi/update-agent
python -m agent.main
```
