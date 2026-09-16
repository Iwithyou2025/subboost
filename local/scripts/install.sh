#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_HOME="/opt/subboost"
DEFAULT_BIN="/usr/local/bin/subboost"
DEFAULT_RELEASE_URL="https://github.com/Iwithyou2025/subboost/releases/latest/download/release.json"
DEFAULT_UPDATE_RELEASE_URL="https://github.com/Iwithyou2025/subboost/releases/latest/download/release.json"
DEFAULT_COMPOSE_URL="https://github.com/Iwithyou2025/subboost/releases/latest/download/docker-compose.image.yml"
DEFAULT_MANAGER_URL="https://github.com/Iwithyou2025/subboost/releases/latest/download/subboost-manager"
DEFAULT_IMAGE="ghcr.io/Iwithyou2025/subboost:latest"

SUBBOOST_HOME="${SUBBOOST_HOME:-$DEFAULT_HOME}"
SUBBOOST_BIN="${SUBBOOST_BIN:-$DEFAULT_BIN}"
SUBBOOST_RELEASE_URL="${SUBBOOST_RELEASE_URL:-$DEFAULT_RELEASE_URL}"
SUBBOOST_UPDATE_RELEASE_URL="${SUBBOOST_UPDATE_RELEASE_URL:-$DEFAULT_UPDATE_RELEASE_URL}"
SUBBOOST_ASSUME_YES="${SUBBOOST_ASSUME_YES:-0}"
SUBBOOST_DRY_RUN="${SUBBOOST_DRY_RUN:-0}"

ENV_FILE="$SUBBOOST_HOME/.env"
COMPOSE_FILE="$SUBBOOST_HOME/docker-compose.yml"
TMP_DIR="${TMPDIR:-/tmp}/subboost-install.$$"
RELEASE_FILE="$TMP_DIR/release.json"
RESTORE_ARCHIVE=""
RESTORE_DUMP=""
RESTORE_ENV=""
RESTORE_MANIFEST=""
MIGRATION_ADMIN_PASSWORD=""
MIGRATION_ADMIN_USERNAME=""

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  install.sh
  install.sh --restore /path/to/backup.zip

Options:
  --restore FILE  Install a fresh SubBoost instance from a full ZIP backup.
  -h, --help      Show this help message.
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --restore)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || die "--restore requires a backup ZIP path."
        [ -z "$RESTORE_ARCHIVE" ] || die "--restore may only be specified once."
        RESTORE_ARCHIVE="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown installer option: $1"
        ;;
    esac
  done
}

is_root() {
  [ "$(id -u)" = "0" ]
}

sudo_do() {
  if is_root; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "sudo is required when the installer is not run as root."
    sudo "$@"
  fi
}

run_root() {
  if [ "$SUBBOOST_DRY_RUN" = "1" ]; then
    printf '[dry-run] root:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  sudo_do "$@"
}

prepare_private_directory() {
  local directory="$1"
  run_root mkdir -p "$directory"
  run_root chmod 700 "$directory"
  if ! is_root; then run_root chown "$(id -u):$(id -g)" "$directory"; fi
}

install_secret_file() {
  local source="$1"
  local destination="$2"
  run_root install -m 600 "$source" "$destination"
  if ! is_root; then
    run_root chown "$(id -u):$(id -g)" "$destination"
  fi
}

prompt() {
  local message="$1"
  local default_value="${2:-}"
  local answer=""
  if [ "$SUBBOOST_ASSUME_YES" = "1" ]; then
    printf '%s\n' "$default_value"
    return 0
  fi
  if { exec 3<>/dev/tty; } 2>/dev/null; then
    if [ -t 3 ] && printf '%s' "$message" >&3 2>/dev/null; then
      IFS= read -r answer <&3 2>/dev/null || answer=""
      printf '\n' >&3 2>/dev/null || true
    fi
    exec 3>&-
  fi
  if [ -n "$answer" ]; then printf '%s\n' "$answer"; else printf '%s\n' "$default_value"; fi
}

confirm_or_quit() {
  local message="$1"
  local answer
  answer="$(prompt "$message" "")"
  case "$answer" in
    q|Q) exit 0 ;;
  esac
}

require_linux() {
  [ "$(uname -s)" = "Linux" ] || die "This installer only supports Linux servers."
}

require_curl() {
  command -v curl >/dev/null 2>&1 || die "curl is required. Install curl and run this installer again."
}

download_to_temp() {
  local url="$1"
  local output="$2"
  case "$url" in
    file://*)
      cp "${url#file://}" "$output"
      ;;
    /*)
      cp "$url" "$output"
      ;;
    http://*|https://*)
      curl -fsSL "$url" -o "$output"
      ;;
    *)
      cp "$url" "$output"
      ;;
  esac
}

json_get() {
  local key="$1"
  local file="$2"
  if [ ! -s "$file" ]; then return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$key" "$file" <<'PY'
import json
import sys
key, path = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
value = data.get(key, "")
print("" if value is None else str(value))
PY
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node - "$key" "$file" <<'NODE'
const fs = require("node:fs");
const [key, file] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"))[key] ?? "";
process.stdout.write(String(value));
NODE
    return 0
  fi
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

file_env_value() {
  local file="$1"
  local key="$2"
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

absolute_existing_file() {
  local file="$1"
  [ -f "$file" ] || die "Restore archive not found: $file"
  (cd "$(dirname "$file")" && printf '%s/%s\n' "$(pwd)" "$(basename "$file")")
}

extract_restore_archive() {
  local archive="$1"
  local output_dir="$2"
  local listing name dump_name="" env_name="" manifest_name="" dump_count=0 env_count=0 manifest_count=0
  mkdir -p "$output_dir"

  case "${archive,,}" in
    *.zip) ;;
    *) die "--restore requires a .zip backup." ;;
  esac

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$archive" "$output_dir" <<'PYZIP'
import os
import stat
import sys
import zipfile

archive_path, output_dir = sys.argv[1:]
with zipfile.ZipFile(archive_path, "r") as archive:
    infos = archive.infolist()
    counts = {"dump": 0, "env": 0, "manifest": 0}
    for info in infos:
        name = info.filename
        if not name or name != os.path.basename(name) or "\\" in name or "/" in name:
            raise SystemExit("unsafe ZIP entry")
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise SystemExit("symlink ZIP entries are not allowed")
        if name.endswith(".dump"):
            counts["dump"] += 1
        elif name.endswith(".env"):
            counts["env"] += 1
        elif name == "manifest.json":
            counts["manifest"] += 1
        else:
            raise SystemExit(f"unexpected ZIP entry: {name}")
    if counts != {"dump": 1, "env": 1, "manifest": 1}:
        raise SystemExit("ZIP must contain exactly one dump, one env, and manifest.json")
    for info in infos:
        target = os.path.join(output_dir, info.filename)
        with archive.open(info, "r") as source, open(target, "wb") as destination:
            while chunk := source.read(1024 * 1024):
                destination.write(chunk)
PYZIP
  elif command -v unzip >/dev/null 2>&1; then
    listing="$(unzip -Z1 "$archive")" || die "Unable to read restore ZIP."
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      case "$name" in
        */*|*\\*) die "Restore ZIP contains an unsafe path: $name" ;;
        *.dump) dump_name="$name"; dump_count=$((dump_count + 1)) ;;
        *.env) env_name="$name"; env_count=$((env_count + 1)) ;;
        manifest.json) manifest_name="$name"; manifest_count=$((manifest_count + 1)) ;;
        *) die "Restore ZIP contains an unexpected file: $name" ;;
      esac
    done <<< "$listing"
    [ "$dump_count" = "1" ] && [ "$env_count" = "1" ] && [ "$manifest_count" = "1" ] || \
      die "Restore ZIP must contain exactly one .dump, one .env, and manifest.json."
    unzip -p "$archive" "$dump_name" > "$output_dir/$dump_name"
    unzip -p "$archive" "$env_name" > "$output_dir/$env_name"
    unzip -p "$archive" "$manifest_name" > "$output_dir/$manifest_name"
  else
    die "Restoring during installation requires python3 or unzip."
  fi

  shopt -s nullglob
  local -a dumps=("$output_dir"/*.dump) envs=("$output_dir"/*.env)
  shopt -u nullglob
  [ "${#dumps[@]}" = "1" ] && [ "${#envs[@]}" = "1" ] && [ -f "$output_dir/manifest.json" ] || \
    die "Restore ZIP must contain exactly one .dump, one .env, and manifest.json."
  RESTORE_DUMP="${dumps[0]}"
  RESTORE_ENV="${envs[0]}"
  RESTORE_MANIFEST="$output_dir/manifest.json"
}

validate_restore_environment() {
  local env_file="$1"
  local line key value expected_database_url
  local -a required_keys=(
    SUBBOOST_IMAGE
    POSTGRES_DB
    POSTGRES_USER
    POSTGRES_PASSWORD
    DATABASE_URL
    ENCRYPTION_KEY
    JWT_SECRET
    CRON_SECRET
    APP_URL
    SUBBOOST_PORT
  )
  local -a missing=()
  local -A seen=()

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac
    if ! [[ "$line" =~ ^[A-Z][A-Z0-9_]*= ]]; then
      die "Backup environment contains an unsupported line: ${line%%=*}"
    fi
    key="${line%%=*}"
    value="${line#*=}"
    [ -z "${seen[$key]:-}" ] || die "Backup environment contains a duplicate setting: $key"
    seen[$key]=1
    printf '%s' "$value" | LC_ALL=C grep -Eq '^[][A-Za-z0-9._~:/?=%+@,-]*$' || \
      die "Backup environment contains an unsafe value: $key"
  done < "$env_file"

  for key in "${required_keys[@]}"; do
    value="$(file_env_value "$env_file" "$key" || true)"
    if [ -z "$value" ]; then missing+=("$key"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "Backup configuration is incomplete. Missing: ${missing[*]}"
  fi

  port_is_number "$(file_env_value "$env_file" SUBBOOST_PORT)" || \
    die "Backup SUBBOOST_PORT must be a number between 1 and 65535."
  expected_database_url="postgresql://$(file_env_value "$env_file" POSTGRES_USER):$(file_env_value "$env_file" POSTGRES_PASSWORD)@db:5432/$(file_env_value "$env_file" POSTGRES_DB)?schema=public"
  [ "$(file_env_value "$env_file" DATABASE_URL)" = "$expected_database_url" ] || \
    die "Backup DATABASE_URL does not match its POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD values."
}

validate_restore_manifest() {
  local format_version database_file environment_file
  format_version="$(json_get formatVersion "$RESTORE_MANIFEST" || true)"
  database_file="$(json_get databaseFile "$RESTORE_MANIFEST" || true)"
  environment_file="$(json_get environmentFile "$RESTORE_MANIFEST" || true)"
  [ "$format_version" = "1" ] || die "Unsupported backup format version: ${format_version:-missing}"
  [ "$database_file" = "$(basename "$RESTORE_DUMP")" ] || die "Backup manifest databaseFile does not match the ZIP contents."
  [ "$environment_file" = "$(basename "$RESTORE_ENV")" ] || die "Backup manifest environmentFile does not match the ZIP contents."
}

prepare_restore_archive() {
  RESTORE_ARCHIVE="$(absolute_existing_file "$RESTORE_ARCHIVE")"
  extract_restore_archive "$RESTORE_ARCHIVE" "$TMP_DIR/restore-input"
  validate_restore_manifest
  validate_restore_environment "$RESTORE_ENV"
}

valid_migration_admin_password() {
  [ "${#1}" -ge 10 ] && [ "${#1}" -le 72 ] && [[ "$1" =~ ^[A-Za-z0-9._~!@#%^*+=:?,-]+$ ]]
}

read_secret_from_tty() {
  local message="$1"
  local answer=""
  local available=0
  if { exec 3<>/dev/tty; } 2>/dev/null; then
    if [ -t 3 ]; then
      available=1
      printf '%s' "$message" >&3
      IFS= read -r -s -u 3 answer || answer=""
      printf '\n' >&3
    fi
    exec 3>&-
  fi
  [ "$available" = "1" ] || return 1
  printf '%s\n' "$answer"
}

collect_migration_admin_password() {
  local first="${SUBBOOST_MIGRATION_ADMIN_PASSWORD:-}"
  local second=""
  if [ -n "$first" ]; then
    valid_migration_admin_password "$first" || \
      die "SUBBOOST_MIGRATION_ADMIN_PASSWORD must be 10-72 characters using letters, numbers, or ._~!@#%^*+=:?,-"
    MIGRATION_ADMIN_PASSWORD="$first"
    unset SUBBOOST_MIGRATION_ADMIN_PASSWORD
    return 0
  fi
  [ "$SUBBOOST_ASSUME_YES" != "1" ] || \
    die "Set SUBBOOST_MIGRATION_ADMIN_PASSWORD for a non-interactive restore installation."
  while true; do
    first="$(read_secret_from_tty "请设置迁移后的管理员密码（10-72 位）: ")" || \
      die "An interactive terminal is required. Alternatively, set SUBBOOST_MIGRATION_ADMIN_PASSWORD."
    second="$(read_secret_from_tty "请再次输入管理员密码: ")" || \
      die "An interactive terminal is required. Alternatively, set SUBBOOST_MIGRATION_ADMIN_PASSWORD."
    if ! valid_migration_admin_password "$first"; then
      warn "密码必须为 10-72 位，并且只能使用字母、数字或 ._~!@#%^*+=:?,-"
      continue
    fi
    if [ "$first" != "$second" ]; then
      warn "两次输入的密码不一致，请重新输入。"
      continue
    fi
    MIGRATION_ADMIN_PASSWORD="$first"
    return 0
  done
}

resolve_url() {
  local base="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  case "$value" in
    http://*|https://*|file://*|/*)
      printf '%s\n' "$value"
      ;;
    *)
      case "$base" in
        file://*)
          printf 'file://%s/%s\n' "$(dirname "${base#file://}")" "$value"
          ;;
        http://*|https://*)
          printf '%s/%s\n' "${base%/*}" "$value"
          ;;
        *)
          printf '%s/%s\n' "$(dirname "$base")" "$value"
          ;;
      esac
      ;;
  esac
}

fetch_release_manifest() {
  mkdir -p "$TMP_DIR"
  if download_to_temp "$SUBBOOST_RELEASE_URL" "$RELEASE_FILE" 2>/dev/null; then
    return 0
  fi
  warn "Release manifest was not reachable; using installer defaults and environment overrides."
  : > "$RELEASE_FILE"
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
  fi
}

port_number() {
  local value="$1"
  case "$value" in
    *:*) value="${value##*:}" ;;
  esac
  value="${value#[}"
  value="${value%]}"
  printf '%s\n' "$value"
}

port_is_number() {
  local port
  port="$(port_number "$1")"
  case "$port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

port_is_free() {
  local port
  port="$(port_number "$1")"
  port_is_number "$port" || return 1

  if command -v ss >/dev/null 2>&1; then
    if ss -H -ltn 2>/dev/null | awk -v port="$port" '{ if ($4 ~ ":" port "$") found = 1 } END { exit found ? 0 : 1 }'; then
      return 1
    fi
    return 0
  fi

  if command -v netstat >/dev/null 2>&1; then
    if netstat -ltn 2>/dev/null | awk -v port="$port" 'NR > 2 { if ($4 ~ ":" port "$") found = 1 } END { exit found ? 0 : 1 }'; then
      return 1
    fi
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
checks = [(socket.AF_INET, "0.0.0.0")]
if socket.has_ipv6:
    checks.append((socket.AF_INET6, "::"))

for family, host in checks:
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError:
        sys.exit(1)
    finally:
        sock.close()
PY
    return $?
  fi

  return 0
}

random_port_candidate() {
  if command -v shuf >/dev/null 2>&1; then
    shuf -i 30000-39999 -n 1
    return 0
  fi
  printf '%s\n' "$((0x$(random_hex 2) % 10000 + 30000))"
}

random_free_port() {
  local index candidate
  for index in $(seq 1 80); do
    candidate="$(random_port_candidate)"
    if port_is_free "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  for candidate in $(seq 30000 39999); do
    if port_is_free "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  die "没有找到 30000-39999 范围内的空闲端口。"
}

read_env_file() {
  if [ ! -f "$ENV_FILE" ]; then return 0; fi
  if is_root; then cat "$ENV_FILE"; else sudo cat "$ENV_FILE"; fi
}

env_value() {
  local key="$1"
  read_env_file | awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }'
}

write_env_value() {
  local key="$1"
  local value="$2"
  local tmp="$TMP_DIR/env"
  mkdir -p "$TMP_DIR"
  if [ -f "$ENV_FILE" ]; then
    read_env_file | awk -v key="$key" 'index($0, key "=") != 1 { print }' > "$tmp"
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install_secret_file "$tmp" "$ENV_FILE"
}

ensure_env_value() {
  local key="$1"
  local value="$2"
  local current
  current="$(env_value "$key" || true)"
  if [ -z "$current" ]; then
    write_env_value "$key" "$value"
  fi
}

set_env_value() {
  write_env_value "$1" "$2"
}

ensure_scheme() {
  local url="$1"
  case "$url" in
    http://*|https://*) printf '%s\n' "$url" ;;
    *) printf 'http://%s\n' "$url" ;;
  esac
}

url_has_port() {
  printf '%s' "$1" | grep -Eq '^https?://\[[^]]+\]:[0-9]+($|/)|^https?://[^/]+:[0-9]+($|/)'
}

url_without_port() {
  local url
  url="$(ensure_scheme "$1")"
  url="${url%/}"
  if printf '%s' "$url" | grep -Eq '^https?://\[[^]]+\]:[0-9]+$'; then
    printf '%s\n' "$url" | sed -E 's#^(https?://\[[^]]+\]):[0-9]+$#\1#'
  elif printf '%s' "$url" | grep -Eq '^https?://[^/]+:[0-9]+$'; then
    printf '%s\n' "$url" | sed -E 's#^(https?://[^/:]+):[0-9]+$#\1#'
  else
    printf '%s\n' "$url"
  fi
}

normalize_app_url() {
  local url
  local port="$2"
  url="$(ensure_scheme "$1")"
  url="${url%/}"
  if url_has_port "$url" || [ "$port" = "80" ] || [ "$port" = "443" ]; then
    printf '%s\n' "$url"
  else
    printf '%s:%s\n' "$url" "$port"
  fi
}

detect_public_host() {
  local detected=""
  detected="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$detected" ]; then
    detected="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$detected" ]; then detected="localhost"; fi
  printf '%s\n' "$detected"
}

install_docker_engine() {
  confirm_or_quit "Docker is missing. Press Enter to install Docker automatically, or type q to exit: "
  require_curl
  local script="$TMP_DIR/get-docker.sh"
  mkdir -p "$TMP_DIR"
  curl -fsSL https://get.docker.com -o "$script"
  run_root sh "$script"
  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl enable --now docker || true
  else
    run_root service docker start || true
  fi
}

install_compose_plugin() {
  confirm_or_quit "Docker Compose plugin is missing. Press Enter to install it automatically, or type q to exit: "
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y docker-compose-plugin
  else
    install_docker_engine
  fi
}

docker_runner() {
  if docker info >/dev/null 2>&1; then
    printf 'docker\n'
    return 0
  fi
  if ! is_root && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    printf 'sudo docker\n'
    return 0
  fi
  printf 'docker\n'
}

docker_cmd() {
  if [ "$DOCKER_RUNNER" = "sudo docker" ]; then
    if [ -n "${DOCKER_CONFIG:-}" ]; then
      sudo env "DOCKER_CONFIG=$DOCKER_CONFIG" docker "$@"
    else
      sudo docker "$@"
    fi
  else
    docker "$@"
  fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker_engine
  fi
  DOCKER_RUNNER="$(docker_runner)"
  if ! docker_cmd info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then run_root systemctl start docker || true; fi
  fi
  DOCKER_RUNNER="$(docker_runner)"
  docker_cmd info >/dev/null 2>&1 || die "Docker is installed but not usable by this shell. Check Docker daemon and permissions."
  if ! docker_cmd compose version >/dev/null 2>&1; then
    install_compose_plugin
  fi
  docker_cmd compose version >/dev/null 2>&1 || die "Docker Compose plugin is still unavailable."
}

docker_login_if_needed() {
  if [ -n "${SUBBOOST_REGISTRY_USER:-}" ] && [ -n "${SUBBOOST_REGISTRY_TOKEN:-}" ]; then
    printf '%s' "$SUBBOOST_REGISTRY_TOKEN" | docker_cmd login ghcr.io -u "$SUBBOOST_REGISTRY_USER" --password-stdin >/dev/null
  fi
}

compose() {
  (cd "$SUBBOOST_HOME" && docker_cmd compose --project-directory "$SUBBOOST_HOME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@")
}

subboost_app_container_id() {
  [ -f "$COMPOSE_FILE" ] || return 0
  [ -f "$ENV_FILE" ] || return 0
  compose ps -q app 2>/dev/null | head -n 1 || true
}

container_publishes_port() {
  local container_id="$1"
  local port
  port="$(port_number "$2")"
  [ -n "$container_id" ] || return 1
  docker_cmd port "$container_id" 3000/tcp 2>/dev/null | awk -v port="$port" '{ if ($0 ~ ":" port "$") found = 1 } END { exit found ? 0 : 1 }'
}

port_owned_by_subboost() {
  local port container_id
  port="$(port_number "$1")"
  port_is_number "$port" || return 1
  container_id="$(subboost_app_container_id)"
  container_publishes_port "$container_id" "$port"
}

port_can_be_used() {
  local port
  port="$(port_number "$1")"
  port_is_number "$port" || return 1
  port_is_free "$port" || port_owned_by_subboost "$port"
}

recommended_port_from() {
  local current_port
  current_port="$(port_number "${1:-}")"
  if port_can_be_used "$current_port"; then
    printf '%s\n' "$current_port"
    return 0
  fi
  random_free_port
}

prompt_for_port() {
  local recommended_port answer port
  recommended_port="$1"
  while true; do
    answer="$(prompt "请输入端口，直接回车会自动选择一个可用端口 [自动选择]: " "$recommended_port")"
    port="$(port_number "$answer")"
    if ! port_is_number "$port"; then
      warn "端口格式不正确，请输入 1-65535 之间的数字。"
      recommended_port="$(random_free_port)"
      continue
    fi
    if port_can_be_used "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    warn "端口已被占用: $port"
    recommended_port="$(random_free_port)"
  done
}

wait_for_health() {
  local port="$1"
  local base="http://127.0.0.1:$(port_number "$port")"
  local index
  for index in $(seq 1 60); do
    if curl -fsS "$base/api/health/live" >/dev/null 2>&1 && curl -fsS "$base/api/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$((index % 10))" = "0" ]; then
      say "SubBoost 还在启动中，继续等待..."
    fi
    sleep 2
  done
  warn "SubBoost 启动超时，健康检查没有通过。"
  warn "请稍后运行 'subboost logs' 查看完整日志。"
  warn "最近的 app 日志如下："
  compose logs --tail=80 app >&2 || true
  return 1
}

wait_for_database() {
  local db_user db_name index
  db_user="$(env_value POSTGRES_USER)"
  db_name="$(env_value POSTGRES_DB)"
  for index in $(seq 1 60); do
    if compose exec -T db pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  warn "PostgreSQL 启动超时。"
  compose logs --tail=80 db >&2 || true
  return 1
}

verify_restore_dump() {
  local -a verify_status
  [ -s "$RESTORE_DUMP" ] || { warn "Backup database dump is empty."; return 1; }
  set +e
  cat "$RESTORE_DUMP" | compose exec -T db pg_restore --list >/dev/null
  verify_status=("${PIPESTATUS[@]}")
  set -e
  if (( verify_status[0] != 0 || verify_status[1] != 0 )); then
    warn "Backup database dump validation failed: read=${verify_status[0]} pg_restore=${verify_status[1]}"
    return 1
  fi
}

restore_database_dump() {
  local db_user db_name
  local -a restore_status
  db_user="$(env_value POSTGRES_USER)"
  db_name="$(env_value POSTGRES_DB)"
  compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
    -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION CURRENT_USER;' || return 1
  set +e
  cat "$RESTORE_DUMP" | compose exec -T db pg_restore \
    --clean --if-exists --exit-on-error --no-owner --no-privileges \
    -U "$db_user" -d "$db_name"
  restore_status=("${PIPESTATUS[@]}")
  set -e
  (( restore_status[0] == 0 && restore_status[1] == 0 ))
}

reset_restored_admin_password() {
  local db_user db_name usernames
  db_user="$(env_value POSTGRES_USER)"
  db_name="$(env_value POSTGRES_DB)"
  usernames="$(compose exec -T db psql -v ON_ERROR_STOP=1 -At -U "$db_user" -d "$db_name" \
    -c 'SELECT "username" FROM "LocalAdmin" ORDER BY "createdAt";' | tr -d '\r' | sed '/^$/d')" || return 1
  [ -n "$usernames" ] || { warn "Restored database does not contain an administrator account."; return 1; }
  MIGRATION_ADMIN_USERNAME="$(printf '%s\n' "$usernames" | paste -sd, -)"
  printf "CREATE EXTENSION IF NOT EXISTS pgcrypto;\nUPDATE \"LocalAdmin\" SET \"passwordHash\" = crypt('%s', gen_salt('bf', 12)), \"updatedAt\" = NOW();\n" \
    "$MIGRATION_ADMIN_PASSWORD" | \
    compose exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" >/dev/null
}

cleanup_failed_install() {
  local volumes_before="$1"
  local project_name
  project_name="$(basename "$SUBBOOST_HOME")"
  compose down --remove-orphans >/dev/null 2>&1 || true
  while IFS= read -r volume; do
    [ -n "$volume" ] || continue
    if ! grep -Fxq "$volume" "$volumes_before"; then
      docker_cmd volume rm "$volume" >/dev/null 2>&1 || true
    fi
  done < <(docker_cmd volume ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)
}

commit_candidate_install() {
  local candidate_env="$1" candidate_compose="$2" candidate_manager="$3"
  local live_env="$4" live_compose="$5"
  local staged_env="${live_env}.candidate.$$"
  local staged_compose="${live_compose}.candidate.$$"
  local staged_manager="${SUBBOOST_BIN}.candidate.$$"
  run_root install -m 600 "$candidate_env" "$staged_env" || return 1
  if ! is_root; then run_root chown "$(id -u):$(id -g)" "$staged_env" || return 1; fi
  run_root install -m 644 "$candidate_compose" "$staged_compose" || return 1
  run_root install -m 755 "$candidate_manager" "$staged_manager" || return 1
  run_root mv -f "$staged_env" "$live_env" || return 1
  run_root mv -f "$staged_compose" "$live_compose" || return 1
  run_root mv -f "$staged_manager" "$SUBBOOST_BIN" || return 1
}

main() {
  require_linux
  parse_args "$@"
  local live_env="$ENV_FILE"
  local live_compose="$COMPOSE_FILE"
  if [ -e "$live_env" ] || [ -e "$live_compose" ]; then
    if [ -n "$RESTORE_ARCHIVE" ]; then
      die "--restore is for a fresh target only. Existing installation metadata was found."
    fi
    die "Existing installation metadata was found. Use 'subboost update' or inspect the incomplete installation before retrying."
  fi
  if [ -n "$RESTORE_ARCHIVE" ]; then prepare_restore_archive; fi
  require_curl
  fetch_release_manifest

  local manifest_image manifest_compose manifest_manager manifest_version
  manifest_image="$(json_get image "$RELEASE_FILE" || true)"
  manifest_compose="$(json_get composeUrl "$RELEASE_FILE" || true)"
  manifest_manager="$(json_get managerUrl "$RELEASE_FILE" || true)"
  manifest_version="$(json_get version "$RELEASE_FILE" || true)"

  local image compose_url manager_url backup_compose_url="" backup_manager_url=""
  if [ -n "$RESTORE_ARCHIVE" ]; then
    image="$(file_env_value "$RESTORE_ENV" SUBBOOST_IMAGE)"
    backup_compose_url="$(file_env_value "$RESTORE_ENV" SUBBOOST_COMPOSE_URL || true)"
    backup_manager_url="$(file_env_value "$RESTORE_ENV" SUBBOOST_MANAGER_URL || true)"
  else
    image="${SUBBOOST_IMAGE:-${manifest_image:-$DEFAULT_IMAGE}}"
  fi
  compose_url="${SUBBOOST_COMPOSE_URL:-${backup_compose_url:-$(resolve_url "$SUBBOOST_RELEASE_URL" "${manifest_compose:-$DEFAULT_COMPOSE_URL}")}}"
  manager_url="${SUBBOOST_MANAGER_URL:-${backup_manager_url:-$(resolve_url "$SUBBOOST_RELEASE_URL" "${manifest_manager:-$DEFAULT_MANAGER_URL}")}}"
  [ -n "$image" ] && [ -n "$compose_url" ] && [ -n "$manager_url" ] || die "Release metadata is missing image, composeUrl, or managerUrl."

  if [ -n "$RESTORE_ARCHIVE" ]; then
    say "Installing SubBoost from backup."
    say "Restore archive: $RESTORE_ARCHIVE"
  else
    say "Installing SubBoost."
  fi
  say "Install directory: $SUBBOOST_HOME"
  if [ -n "$manifest_version" ]; then say "Version: $manifest_version"; fi

  if [ "$SUBBOOST_DRY_RUN" = "1" ]; then
    say "[dry-run] image=$image"
    say "[dry-run] composeUrl=$compose_url"
    say "[dry-run] managerUrl=$manager_url"
    say "[dry-run] updateReleaseUrl=$SUBBOOST_UPDATE_RELEASE_URL"
    if [ -n "$RESTORE_ARCHIVE" ]; then say "[dry-run] restoreArchive=$RESTORE_ARCHIVE"; fi
    exit 0
  fi

  if [ -n "$RESTORE_ARCHIVE" ]; then collect_migration_admin_password; fi

  ensure_docker
  docker_login_if_needed
  prepare_private_directory "$SUBBOOST_HOME"
  prepare_private_directory "$SUBBOOST_HOME/backups"
  run_root mkdir -p "$(dirname "$SUBBOOST_BIN")"
  ENV_FILE="$TMP_DIR/candidate.env"
  COMPOSE_FILE="$TMP_DIR/candidate-compose.yml"
  local candidate_manager="$TMP_DIR/candidate-manager"
  local volumes_before="$TMP_DIR/volumes.before"
  umask 077
  download_to_temp "$compose_url" "$COMPOSE_FILE"
  if [ -x "$SUBBOOST_BIN" ]; then
    say "Existing SubBoost manager found; reusing it."
    cp "$SUBBOOST_BIN" "$candidate_manager"
  else
    download_to_temp "$manager_url" "$candidate_manager"
  fi
  [ -s "$COMPOSE_FILE" ] || die "Candidate Compose file is empty."
  [ -s "$candidate_manager" ] && bash -n "$candidate_manager" || die "Candidate manager is invalid."

  if [ -n "$RESTORE_ARCHIVE" ]; then
    install -m 600 "$RESTORE_ENV" "$ENV_FILE"
    ensure_env_value SUBBOOST_CANDIDATE_IMAGE "$image"
    ensure_env_value SUBBOOST_RELEASE_URL "$SUBBOOST_UPDATE_RELEASE_URL"
    ensure_env_value SUBBOOST_COMPOSE_URL "$compose_url"
    ensure_env_value SUBBOOST_MANAGER_URL "$manager_url"
    if ! port_is_free "$(env_value SUBBOOST_PORT)"; then
      die "Backup SUBBOOST_PORT is already in use: $(env_value SUBBOOST_PORT)"
    fi
  else
    : > "$ENV_FILE"
    set_env_value SUBBOOST_IMAGE "$image"
    set_env_value SUBBOOST_CANDIDATE_IMAGE "$image"
    set_env_value SUBBOOST_RELEASE_URL "$SUBBOOST_UPDATE_RELEASE_URL"
    set_env_value SUBBOOST_COMPOSE_URL "$compose_url"
    set_env_value SUBBOOST_MANAGER_URL "$manager_url"
    ensure_env_value POSTGRES_DB "subboost"
    ensure_env_value POSTGRES_USER "subboost"
    ensure_env_value POSTGRES_PASSWORD "$(random_hex 18)"
    ensure_env_value ENCRYPTION_KEY "$(random_hex 32)"
    ensure_env_value JWT_SECRET "$(random_hex 32)"
    ensure_env_value CRON_SECRET "$(random_hex 32)"
    ensure_env_value LOCAL_SETUP_TOKEN "$(random_hex 32)"

    local db_name db_user db_pass database_url current_url current_port default_host default_url input_url selected_port final_url recommended_port
    db_name="$(env_value POSTGRES_DB)"
    db_user="$(env_value POSTGRES_USER)"
    db_pass="$(env_value POSTGRES_PASSWORD)"
    database_url="postgresql://$db_user:$db_pass@db:5432/$db_name?schema=public"
    ensure_env_value DATABASE_URL "$database_url"

    current_port="${SUBBOOST_PORT:-$(env_value SUBBOOST_PORT || true)}"
    current_url="${APP_URL:-$(env_value APP_URL || true)}"

    default_host="$(detect_public_host)"
    if [ -n "$current_url" ]; then
      default_url="$(url_without_port "$current_url")"
    else
      default_url="http://$default_host"
    fi
    recommended_port="$(recommended_port_from "$current_port")"
    input_url="$(prompt "请输入 SubBoost 访问地址，直接回车会自动填入服务器 ip [$default_url]: " "$default_url")"
    selected_port="$(prompt_for_port "$recommended_port")"
    final_url="$(normalize_app_url "$(url_without_port "$input_url")" "$selected_port")"
    set_env_value SUBBOOST_PORT "$selected_port"
    set_env_value APP_URL "$final_url"
  fi

  compose config >/dev/null
  local services
  services="$(compose config --services)"
  for service in app db cron; do
    printf '%s\n' "$services" | grep -Fxq "$service" || die "Candidate Compose is missing service: $service"
  done
  docker_cmd volume ls -q > "$volumes_before"
  say "Pulling SubBoost image before creating containers..."
  compose pull
  if [ -n "$RESTORE_ARCHIVE" ]; then
    say "Starting PostgreSQL for backup migration..."
    if ! compose up -d db || ! wait_for_database; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed while starting PostgreSQL; resources created by this run were cleaned up."
    fi
    say "Validating database backup..."
    if ! verify_restore_dump; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation stopped because the database backup is invalid."
    fi
    say "Restoring database backup..."
    if ! restore_database_dump || ! reset_restored_admin_password; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed while restoring data or resetting the administrator password."
    fi
    say "Starting SubBoost with the restored configuration..."
    if ! compose up -d app || ! wait_for_health "$(env_value SUBBOOST_PORT)" || ! compose up -d cron; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed; resources created by this run were cleaned up."
    fi
  else
    say "Starting SubBoost..."
    if ! compose up -d db app || ! wait_for_health "$(env_value SUBBOOST_PORT)" || ! compose up -d cron; then
      cleanup_failed_install "$volumes_before"
      die "New installation failed; only resources created by this run were cleaned up."
    fi
  fi
  if ! commit_candidate_install "$ENV_FILE" "$COMPOSE_FILE" "$candidate_manager" "$live_env" "$live_compose"; then
    cleanup_failed_install "$volumes_before"
    run_root rm -f "$live_env" "$live_compose" "${live_env}.candidate.$$" "${live_compose}.candidate.$$" "${SUBBOOST_BIN}.candidate.$$"
    die "Failed to atomically install candidate metadata."
  fi
  ENV_FILE="$live_env"
  COMPOSE_FILE="$live_compose"

  if command -v systemctl >/dev/null 2>&1; then
    if ! run_root env SUBBOOST_HOME="$SUBBOOST_HOME" SUBBOOST_BIN="$SUBBOOST_BIN" "$SUBBOOST_BIN" agent-install >/dev/null 2>&1; then
      warn "网页备份管理服务未能自动启动；稍后可运行 'sudo subboost agent-install'。"
    fi
  fi

  say ""
  say "SubBoost 已启动。"
  say "访问地址: $(env_value APP_URL)"
  if [ -n "$RESTORE_ARCHIVE" ]; then
    say "管理员账号: $MIGRATION_ADMIN_USERNAME"
    say "管理员密码: $MIGRATION_ADMIN_PASSWORD"
    say "完整迁移已完成，请使用以上账号和本次设置的新密码登录。"
    MIGRATION_ADMIN_PASSWORD=""
  else
    say "首次初始化链接: $(env_value APP_URL)/login#setup-token=$(env_value LOCAL_SETUP_TOKEN)"
    say "请通过上面的链接创建第一个管理员；初始化成功后页面会清除令牌片段。"
  fi
  say "管理命令: subboost"
  say "重要提醒: 请把 $ENV_FILE 和数据库备份一起保存好。"
}

if [ "${SUBBOOST_SCRIPT_SOURCE_ONLY:-0}" != "1" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
  DOCKER_RUNNER="docker"
  main "$@"
fi
