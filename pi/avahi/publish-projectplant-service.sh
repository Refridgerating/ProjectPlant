#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${1:-/etc/projectplant/avahi.env}
NAME="ProjectPlant Hub"
PORT="8080"
TXT_RECORDS="role=hub"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

NAME=${PROJECTPLANT_AVAHI_NAME:-$NAME}
PORT=${PROJECTPLANT_PORT:-$PORT}
TXT_RECORDS=${PROJECTPLANT_AVAHI_TXT:-$TXT_RECORDS}

ARGS=()
IFS=';' read -ra TXT_ITEMS <<< "$TXT_RECORDS"
for item in "${TXT_ITEMS[@]}"; do
  item=$(printf '%s' "$item" | xargs)
  if [[ -n "$item" ]]; then
    ARGS+=("$item")
  fi
done

exec /usr/bin/avahi-publish-service -s "$NAME" _projectplant._tcp "$PORT" "${ARGS[@]}"
