#!/usr/bin/env bash
set -euo pipefail

STATE_DIR=/var/lib/projectplant
FLAG="$STATE_DIR/provisioned"

mkdir -p "$STATE_DIR"

if [[ -f "$FLAG" ]]; then
  echo "Provisioning flag exists; not starting AP."
  exit 0
fi

echo "Waiting up to 5 minutes for provisioning..."
for i in {1..300}; do
  if [[ -f "$FLAG" ]]; then
    echo "Provisioned during wait; exiting."
    exit 0
  fi
  sleep 1
done

echo "Timeout waiting for provisioning; starting fallback AP."
systemctl start projectplant-ap.target || true

