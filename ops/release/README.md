# ProjectPlant Release Tooling

This folder contains helper scripts for building and publishing signed hub releases.

## Expected artifact names
- `hub-app.tar.zst`
- `ui-dist.tar.zst`
- `systemd-units.tar.zst`
- `managed-configs.tar.zst`
- `debs.tar.zst`

## Build
Package repo artifacts first:
```bash
python ops/release/package_artifacts.py \
  --output-dir dist/release \
  --ui-dist apps/ui/dist \
  --systemd-dir pi/systemd \
  --config-dir ops/release/configs \
  --debs-dir ops/release/debs
```

This expects `apps/ui/dist` to exist already and requires `tar` with `--zstd` support.

Then generate and sign the release manifest:
```bash
python ops/release/build_release.py \
  --release-id 2026.02.28-1 \
  --channel stable \
  --hub-version 0.2.0 \
  --ui-version 0.2.0 \
  --agent-min-version 0.1.0 \
  --artifact-dir dist/release \
  --private-key-path release-signing-key.hex
```

## Publish
```bash
python ops/release/publish_release.py \
  --control-url https://fleet.internal:8100 \
  --token <operator-bearer-token> \
  --release-dir dist/release
```
