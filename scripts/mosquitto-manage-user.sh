#!/usr/bin/env bash
set -euo pipefail

# mosquitto-manage-user.sh
# Create/delete/list Mosquitto users and ensure per-device ACL pattern.
#
# Requires: mosquitto_passwd
# Default files: /etc/mosquitto/passwd and /etc/mosquitto/acl

PASSWD_FILE="/etc/mosquitto/passwd"
ACL_FILE="/etc/mosquitto/acl"
MOSQ_USER="mosquitto"
MOSQ_GROUP="mosquitto"

usage() {
  cat <<EOF
Usage:
  sudo $0 add <device_id> [password]
  sudo $0 del <device_id>
  sudo $0 list
  sudo $0 ensure-acl

Notes:
  - Enforces per-device topics via ACL pattern: devices/%u/#
  - Ensure your mosquitto.conf refers to:
      password_file ${PASSWD_FILE}
      acl_file ${ACL_FILE}
EOF
}

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "This command must run as root (use sudo)." >&2
    exit 1
  fi
}

ensure_acl_pattern() {
  mkdir -p "$(dirname "$ACL_FILE")"
  touch "$ACL_FILE"

  # Add the per-device pattern if missing
  if ! grep -qE '^\s*pattern\s+readwrite\s+devices/%u/#\s*$' "$ACL_FILE"; then
    {
      echo "# Per-device namespace: each username is confined to devices/<username>/#"
      echo "pattern readwrite devices/%u/#"
    } >> "$ACL_FILE"
  fi

  # Set reasonable permissions if the user/group exist
  if id -u "$MOSQ_USER" >/dev/null 2>&1 && getent group "$MOSQ_GROUP" >/dev/null 2>&1; then
    chown ${MOSQ_USER}:${MOSQ_GROUP} "$ACL_FILE" || true
    chmod 640 "$ACL_FILE" || true
  else
    chmod 640 "$ACL_FILE" || true
  fi
}

ensure_passwd_file() {
  mkdir -p "$(dirname "$PASSWD_FILE")"
  touch "$PASSWD_FILE"
  if id -u "$MOSQ_USER" >/dev/null 2>&1 && getent group "$MOSQ_GROUP" >/dev/null 2>&1; then
    chown ${MOSQ_USER}:${MOSQ_GROUP} "$PASSWD_FILE" || true
  fi
  chmod 640 "$PASSWD_FILE" || true
}

cmd_add() {
  need_root
  local user="$1"
  local pass="${2:-}"
  if [[ -z "$user" ]]; then
    echo "Device ID (username) required." >&2
    exit 1
  fi

  if ! command -v mosquitto_passwd >/dev/null 2>&1; then
    echo "mosquitto_passwd not found. Install Mosquitto utilities." >&2
    exit 1
  fi

  ensure_passwd_file
  ensure_acl_pattern

  if [[ -z "$pass" ]]; then
    # Prompt for password if not provided
    read -r -s -p "Enter password for '$user': " pass; echo
    read -r -s -p "Confirm password: " pass2; echo
    if [[ "$pass" != "$pass2" ]]; then
      echo "Passwords do not match." >&2
      exit 1
    fi
  fi

  # Add/update user
  mosquitto_passwd -b "$PASSWD_FILE" "$user" "$pass"

  echo "User '$user' added/updated. Per-device ACL enforced via pattern."
  echo "Reload mosquitto to apply changes: systemctl reload mosquitto || systemctl restart mosquitto"
}

cmd_del() {
  need_root
  local user="$1"
  if [[ -z "$user" ]]; then
    echo "Device ID (username) required." >&2
    exit 1
  fi
  if ! command -v mosquitto_passwd >/dev/null 2>&1; then
    echo "mosquitto_passwd not found. Install Mosquitto utilities." >&2
    exit 1
  fi
  if [[ ! -f "$PASSWD_FILE" ]]; then
    echo "Password file not found: $PASSWD_FILE" >&2
    exit 1
  fi
  mosquitto_passwd -D "$PASSWD_FILE" "$user"
  echo "User '$user' deleted. Reload mosquitto if needed."
}

cmd_list() {
  if [[ -f "$PASSWD_FILE" ]]; then
    cut -d: -f1 "$PASSWD_FILE" | sed '/^$/d'
  else
    echo "No password file at $PASSWD_FILE"
  fi
}

cmd_ensure_acl() {
  need_root
  ensure_acl_pattern
  echo "Ensured per-device ACL pattern in $ACL_FILE"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    add)
      cmd_add "${1:-}" "${2:-}" ;;
    del|delete)
      cmd_del "${1:-}" ;;
    list)
      cmd_list ;;
    ensure-acl)
      cmd_ensure_acl ;;
    -h|--help|help|"")
      usage ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 1 ;;
  esac
}

main "$@"

