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
RESUME_HTTPS=0
RESTORE_ARCHIVE=""
RESTORE_DUMP=""
RESTORE_ENV=""
RESTORE_MANIFEST=""
MIGRATION_ADMIN_PASSWORD=""
MIGRATION_ADMIN_USERNAME=""

say() {
  printf '%s\n' "$*"
}

# Normal installs show stages, not Docker progress or database/Caddy internals.
# A failed command retains its exit status and emits a bounded diagnostic tail.
run_step() {
  local label="$1" result logfile
  shift
  mkdir -p "$TMP_DIR"
  logfile="$(mktemp "$TMP_DIR/step.XXXXXX")" || return 1
  chmod 600 "$logfile"
  say "$label..."
  if "$@" >"$logfile" 2>&1; then
    rm -f "$logfile"
    say "$label：完成"
    return 0
  else
    result=$?
    warn "$label失败（退出码 $result），诊断如下："
    tail -n 25 "$logfile" >&2
    rm -f "$logfile"
    return "$result"
  fi
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
  --resume-https  Configure/retry HTTPS on an installed server; never restores data.
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
      --resume-https) RESUME_HTTPS=1; shift ;;
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
  run_root install -m 600 "$source" "$destination" || return 1
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
      curl --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 180 -fsSL "$url" -o "$output"
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

valid_local_ipv4() {
  printf '%s\n' "$1" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || $i>255) exit 1; if($1==0 || $1==127 || $1>=224 || ($1==169 && $2==254)) exit 1}'
}

detect_local_host() {
  local candidate
  candidate="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") {print $(i+1); exit}}' || true)"
  if valid_local_ipv4 "$candidate"; then printf '%s\n' "$candidate"; return; fi
  for candidate in $(hostname -I 2>/dev/null); do
    if valid_local_ipv4 "$candidate"; then printf '%s\n' "$candidate"; return; fi
  done
  return 1
}

configure_restored_local_access() {
  local answer port host
  while true; do
    answer="$(prompt '请输入本地端口号（输入回车将选择随机端口号）：' '')"
    if [ -z "$answer" ]; then port="$(random_free_port)"; else port="$answer"; fi
    if port_is_number "$port" && port_is_free "$port"; then break; fi
    warn "端口无效或已被占用，请输入 1-65535 的可用端口。"
    [ "$SUBBOOST_ASSUME_YES" != 1 ] || return 1
  done
  host="$(detect_local_host || true)"
  if ! valid_local_ipv4 "$host"; then
    warn "无法自动获取本机 IPv4 地址，请检查网络或手动提供；不会沿用备份中的地址。"
    while true; do
      host="$(prompt '请输入当前机器的 IPv4 地址（留空退出）：' '')"
      [ -n "$host" ] || return 1
      valid_local_ipv4 "$host" && break
      warn "IPv4 地址无效，请重新输入。"
    done
  fi
  set_env_value SUBBOOST_PORT "$port"
  set_env_value APP_URL "http://$host:$port"
  set_env_value TRUST_PROXY_HEADERS false
  unset APP_URL SUBBOOST_PORT TRUST_PROXY_HEADERS
  say "本次本地访问地址：http://$host:$port"
}

install_docker_engine() {
  confirm_or_quit "Docker is missing. Press Enter to install Docker automatically, or type q to exit: "
  require_curl
  local script="$TMP_DIR/get-docker.sh"
  mkdir -p "$TMP_DIR"
  download_to_temp https://get.docker.com "$script"
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
  local -a https_files=()
  if [ -f "$SUBBOOST_HOME/https-compose.yml" ]; then https_files=(-f "$SUBBOOST_HOME/https-compose.yml"); fi
  (cd "$SUBBOOST_HOME" && docker_cmd compose --project-directory "$SUBBOOST_HOME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${https_files[@]}" "$@")
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
    if curl --connect-timeout 2 --max-time 5 -fsS "$base/api/health/live" >/dev/null 2>&1 && curl --connect-timeout 2 --max-time 5 -fsS "$base/api/health/ready" >/dev/null 2>&1; then
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
  local db_user db_name index stable_checks
  db_user="$(env_value POSTGRES_USER)"
  db_name="$(env_value POSTGRES_DB)"
  # The PostgreSQL image briefly accepts connections during initdb, stops that
  # temporary server, and then starts the final server. Require a stable-ready
  # window so a restore cannot begin during that shutdown gap.
  stable_checks=0
  for index in $(seq 1 120); do
    if compose exec -T db pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      stable_checks=$((stable_checks + 1))
      if [ "$stable_checks" -ge 3 ]; then
        return 0
      fi
    else
      stable_checks=0
    fi
    sleep 1
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

# Server install state is persisted separately from release-owned Compose files.
HTTPS_SUPPORT_VERSION=1
INSTALL_MODE="${SUBBOOST_INSTALL_MODE:-}"
TLS_MODE="${SUBBOOST_TLS_MODE:-}"
HTTPS_DOMAIN="${SUBBOOST_DOMAIN:-}"

retry_network() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    warn "网络操作失败（$attempt/3），请检查网络、DNS 或镜像仓库权限。"
    [ "$attempt" = 3 ] || sleep "$((attempt * 2))"
  done
  return 1
}

https_dependencies() {
  local missing=0 tool
  for tool in curl openssl python3 timeout; do command -v "$tool" >/dev/null 2>&1 || missing=1; done
  [ "$missing" = 1 ] || return 0
  say "正在安装 HTTPS 配置所需的依赖..."
  if command -v apt-get >/dev/null 2>&1; then
    retry_network run_root apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update || die "软件源不可用，请修复网络后重试。"
    retry_network run_root env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y curl ca-certificates openssl python3 coreutils || die "依赖安装失败。"
  elif command -v dnf >/dev/null 2>&1; then
    retry_network run_root dnf install -y curl ca-certificates openssl python3 coreutils || die "依赖安装失败。"
  elif command -v yum >/dev/null 2>&1; then
    retry_network run_root yum install -y curl ca-certificates openssl python3 coreutils || die "依赖安装失败。"
  else
    die "请安装 curl、ca-certificates、openssl、python3、coreutils 后重试。"
  fi
  for tool in curl openssl python3 timeout; do command -v "$tool" >/dev/null 2>&1 || die "依赖仍不可用: $tool"; done
}

valid_https_domain() {
  local domain="$1" label
  [ "${#domain}" -le 253 ] && [[ "$domain" == *.* ]] || return 1
  [[ ! "$domain" =~ ^[0-9.]+$ ]] || return 1
  [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || return 1
  local -a labels
  IFS=. read -ra labels <<< "$domain"
  [[ "$domain" != *. ]] || return 1
  for label in "${labels[@]}"; do
    [ "${#label}" -le 63 ] && [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

https_dns_preflight() {
  mkdir -p "$TMP_DIR"
  DNS_PUBLIC_ADDRESS=""
  DNS_LOCAL_STALE=0
  rm -f "$TMP_DIR/dns-result.json"
  # Inspired by lego's distinction between recursive propagation and local
  # resolution. This is A/AAAA preflight for TLS-ALPN, NOT DNS-01 validation.
  # DoH avoids local DNS caches and UDP/53 filtering; TLS verification stays on.
  timeout 18 python3 - "$HTTPS_DOMAIN" "$TLS_MODE" "$TMP_DIR/dns-result.json" "${1:-preflight}" <<'PYDNS'
import concurrent.futures, ipaddress, json, socket, subprocess, sys
from urllib.parse import urlencode

domain, mode, output, phase = sys.argv[1:]
providers = [('Cloudflare', 'cloudflare-dns.com', '1.1.1.1', '/dns-query'),
             ('Google', 'dns.google', '8.8.8.8', '/resolve')]
ranges = "173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"
networks = [ipaddress.ip_network(x) for x in ranges.split()]
def query(provider, kind):
    label, host, bootstrap, endpoint = provider
    url = 'https://' + host + endpoint + '?' + urlencode({'name': domain, 'type': kind})
    try:
        raw = subprocess.run(['curl', '--noproxy', '*', '--resolve', f'{host}:443:{bootstrap}',
            '--connect-timeout', '3', '--max-time', '6', '-fsS', '-H', 'accept: application/dns-json', url],
            capture_output=True, text=True, timeout=8, check=True).stdout
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('Status') not in (0, 3) or data.get('TC'):
            return None
        values, ttls = set(), []
        answers = data.get('Answer', [])
        if not isinstance(answers, list): return None
        for answer in answers:
            if not isinstance(answer, dict): return None
            if answer.get('type') == (1 if kind == 'A' else 28):
                addr = ipaddress.ip_address(answer['data'])
                if addr.version != (4 if kind == 'A' else 6): return None
                values.add(str(addr)); ttls.append(int(answer.get('TTL', 0)))
        return values, min(ttls, default=0), data['Status']
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    tasks = {(p[0], k): pool.submit(query, p, k) for p in providers for k in ('A', 'AAAA')}
    results = {key: task.result() for key, task in tasks.items()}
complete = []
observed = set()
for provider in providers:
    name = provider[0]; rows = [results[(name, k)] for k in ('A', 'AAAA')]
    for row in rows:
        if row is not None: observed.update(row[0])
    if any(row is None for row in rows):
        print(name + ' 公共 DNS：查询不完整或超时（不是橙云状态判断）')
        continue
    addresses = set().union(*(row[0] for row in rows))
    if any(row[2] == 3 for row in rows): addresses = set()
    ttl = min((row[1] for row in rows if row[0]), default=0)
    print(name + ' 公共 DNS：' + (', '.join(sorted(addresses)) or '无 A/AAAA 记录') + f'（TTL {ttl} 秒）')
    complete.append(addresses)
if not complete:
    print('公共 DNS 查询失败。请检查出站 HTTPS 网络后重查；不会把网络故障当成橙云开启。', file=sys.stderr)
    raise SystemExit(1)
if phase == 'diagnostic':
    # Certificate issuance has already succeeded. Resolver agreement is NOT a
    # success criterion here: select a fresh candidate and actually test TLS.
    candidates = {a for row in complete for a in row if ipaddress.ip_address(a).is_global}
    if mode == 'auto':
        candidates = {a for a in candidates if not any(ipaddress.ip_address(a) in n for n in networks)}
    if not candidates:
        print('未获得可用于直连重试的公共地址；DNS 信息仅供诊断，不代表控制台代理状态。', file=sys.stderr)
        raise SystemExit(1)
    print('DNS 诊断：公共结果可能尚在传播，将对最新可用地址进行真实 HTTPS 重试。')
    selected = sorted(candidates, key=lambda a: (ipaddress.ip_address(a).version, a))[0]
    with open(output, 'w') as f: json.dump({'address': selected, 'stale': True}, f)
    raise SystemExit(0)
if any(not row for row in complete):
    print('公共 DNS 尚未返回有效地址，可能仍在传播，请稍后重查。', file=sys.stderr)
    raise SystemExit(1)
if mode == 'auto':
    if any(ipaddress.ip_address(a) in n for a in observed for n in networks):
        print('公共 DNS 仍返回 Cloudflare 代理地址；可能橙云仍开启，也可能关闭后缓存尚未到期。请等待传播或选择导入证书。', file=sys.stderr)
        raise SystemExit(1)
    if any(not ipaddress.ip_address(a).is_global for a in observed):
        print('自动证书需要公网 A/AAAA 地址。', file=sys.stderr)
        raise SystemExit(1)
    if any(row != complete[0] for row in complete[1:]):
        print('公共 DNS 结果尚不一致，请等待传播后重查。', file=sys.stderr)
        raise SystemExit(1)
    print('公共 DNS 未发现 Cloudflare 代理地址，可继续尝试自动签发；仍需源站 TCP 443 可达。')
else:
    print('导入证书模式：不要求关闭代理；Origin CA 证书需代理开启且使用完全（严格）模式。')
if len(complete) < 2:
    print('一个公共 DNS 不可用，已采用另一个的完整 A/AAAA 结果；最终以 HTTPS 验证为准。')
addresses = complete[0]
local = set()
try:
    raw = subprocess.run([sys.executable, '-c',
        'import socket,sys,json; print(json.dumps(sorted({x[4][0] for x in socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM)})))', domain],
        capture_output=True, text=True, timeout=3, check=True).stdout
    local = set(json.loads(raw))
except (OSError, ValueError, subprocess.SubprocessError):
    pass
stale = local != addresses
if stale:
    print('系统解析与公共 DNS 不一致或不可用，可能是本机/上游缓存。无需重启脚本；本次入口验证使用上述公共 DNS 地址。')
selected = sorted(addresses, key=lambda a: (ipaddress.ip_address(a).version, a))[0]
with open(output, 'w') as f: json.dump({'address': selected, 'stale': stale}, f)
PYDNS
  local result=$?
  [ "$result" = 0 ] || return "$result"
  DNS_PUBLIC_ADDRESS="$(json_get address "$TMP_DIR/dns-result.json")"
  [ "$(json_get stale "$TMP_DIR/dns-result.json")" != True ] || DNS_LOCAL_STALE=1
}

select_install_mode() {
  local answer
  while true; do
    answer="${INSTALL_MODE:-$(prompt $'请选择安装方式：\n1. 本地环境安装\n2. 公网环境安装\n请选择 [1]: ' 1)}"
    case "$answer" in
      1|local) INSTALL_MODE=local; return ;;
      2|server) INSTALL_MODE=server; break ;;
      *) [ -z "$INSTALL_MODE" ] || die "SUBBOOST_INSTALL_MODE 必须为 local 或 server。"; warn "请输入 1 或 2。" ;;
    esac
  done
  https_dependencies
  while true; do
    answer="${HTTPS_DOMAIN:-$(prompt '请输入访问域名（不含路径）: ' '')}"
    answer="${answer#https://}"; answer="${answer%/}"; answer="${answer,,}"
    if valid_https_domain "$answer"; then HTTPS_DOMAIN="$answer"; break; fi
    [ -z "$HTTPS_DOMAIN" ] && [ "$SUBBOOST_ASSUME_YES" != 1 ] && [ -n "$answer" ] || die "需要有效的公网域名。"
    warn "域名格式无效，请重新输入。"
  done
  while true; do
    answer="${TLS_MODE:-$(prompt $'证书方式：\n1. 自动申请（关闭橙云，域名直连，开放 TCP 443）\n2. 导入已有证书（可直接粘贴）\n请选择 [1]: ' 1)}"
    case "$answer" in
      1|auto) TLS_MODE=auto; break ;;
      2|import) TLS_MODE=import; break ;;
      *) [ -z "$TLS_MODE" ] || die "SUBBOOST_TLS_MODE 必须为 auto 或 import。"; warn "请输入 1 或 2。" ;;
    esac
  done
  while ! https_dns_preflight; do
    [ "$SUBBOOST_ASSUME_YES" != 1 ] || die "DNS 前置检查失败；尚未创建服务。修复 DNS 或选择导入证书后重试。"
    answer="$(prompt 'DNS 未满足条件：1 重新检查，2 更换证书方式，其他退出 [q]: ' q)"
    case "$answer" in
      1) ;;
      2) TLS_MODE=""; select_install_mode; return ;;
      *) die "安装已停止；未恢复数据库。已有安装的数据保持不变。" ;;
    esac
  done
  say "公网环境需要云安全组及防火墙允许 TCP 443；安装结束会验证 HTTPS 连通性。"
}

# Read /dev/tty, never pipeline stdin (curl | bash). Silent input keeps private
# key material out of terminal recordings; DONE is an explicit multiline end.
read_pem_from_tty() {
  local output="$1" description="$2" line="" bytes=0
  [ "$SUBBOOST_ASSUME_YES" != 1 ] || return 1
  (
    exec 3<>/dev/tty || exit 1
    [ -t 3 ] || exit 1
    printf '\n请粘贴完整%s（含 BEGIN/END 标记），另起一行输入 DONE 并回车结束。输入不回显：\n' "$description" >&3
    umask 077
    : > "$output"
    while IFS= read -r -s line <&3; do
      line="${line%$'\r'}"
      [ "$line" != DONE ] || { printf '\n接收完成。\n' >&3; exit 0; }
      bytes=$((bytes + ${#line} + 1))
      [ "$bytes" -le 131072 ] || { printf '\n证书输入过长。\n' >&3; exit 1; }
      printf '%s\n' "$line" >> "$output"
    done
    exit 1
  )
}

validate_https_certificate() {
  local cert="$1" key="$2" domain="$3" cert_pub key_pub
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null 2>&1 || { warn "证书无效、已过期或将在 24 小时内到期。"; return 1; }
  openssl x509 -in "$cert" -noout -checkhost "$domain" 2>/dev/null | grep -q 'does match certificate' || { warn "证书不覆盖域名 $domain。"; return 1; }
  # Validate notBefore as well; OpenSSL checkend only checks notAfter.
  python3 - "$cert" <<'PYDATE' || return 1
import ssl, sys, time
cert = ssl._ssl._test_decode_cert(sys.argv[1])
if ssl.cert_time_to_seconds(cert['notBefore']) > time.time():
    raise SystemExit('证书尚未生效，请检查系统时间。')
PYDATE
  openssl pkey -in "$key" -passin pass: -check -noout >/dev/null 2>&1 || { warn "私钥无效或已加密，请提供未加密的 PEM 私钥。"; return 1; }
  cert_pub="$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)" || return 1
  key_pub="$(openssl pkey -in "$key" -passin pass: -pubout -outform DER | openssl dgst -sha256)" || return 1
  [ "$cert_pub" = "$key_pub" ] || { warn "证书与私钥不匹配。"; return 1; }
}

collect_https_certificate() {
  local cert="$TMP_DIR/origin.pem" key="$TMP_DIR/origin.key" method
  while true; do
    if [ -n "${SUBBOOST_TLS_CERT_FILE:-}" ] || [ -n "${SUBBOOST_TLS_KEY_FILE:-}" ]; then
      [ -f "${SUBBOOST_TLS_CERT_FILE:-}" ] && [ -f "${SUBBOOST_TLS_KEY_FILE:-}" ] || die "必须同时提供证书和私钥文件。"
      install -m 600 "$SUBBOOST_TLS_CERT_FILE" "$cert"
      install -m 600 "$SUBBOOST_TLS_KEY_FILE" "$key"
      validate_https_certificate "$cert" "$key" "$HTTPS_DOMAIN" || die "证书检查失败。"
      break
    fi
    method="$(prompt '证书输入方式：1. 直接粘贴  2. 文件路径 [1]: ' 1)"
    case "$method" in
      1)
        read_pem_from_tty "$cert" '证书/证书链（不是单独的公钥）' || die "未完成证书输入。"
        read_pem_from_tty "$key" '私钥' || die "未完成私钥输入。"
        ;;
      2)
        local source_cert source_key
        source_cert="$(prompt '证书文件路径: ' '')"
        source_key="$(prompt '私钥文件路径: ' '')"
        if [ ! -f "$source_cert" ] || [ ! -f "$source_key" ]; then warn "文件不存在。"; continue; fi
        install -m 600 "$source_cert" "$cert"
        install -m 600 "$source_key" "$key"
        ;;
      *) warn "请输入 1 或 2。"; continue ;;
    esac
    if validate_https_certificate "$cert" "$key" "$HTTPS_DOMAIN"; then break; fi
    rm -f "$cert" "$key"
    [ "$SUBBOOST_ASSUME_YES" != 1 ] || die "证书检查失败。"
    warn "请重新输入证书和私钥。"
  done
}

prepare_https_config() {
  [ "$INSTALL_MODE" = server ] || return 0
  if [ "${RESUME_HTTPS:-0}" != 1 ]; then port_is_free 443 || die "TCP 443 已被占用。请自行调整冲突服务；未停止任何现有项目。"; fi
  local version
  version="$(docker_cmd compose version --short)"; version="${version#v}"
  python3 - "$version" <<'PYVERSION' || die "服务器模式需要 Docker Compose 2.24.4 或更新版本（支持 !override）。"
import re, sys
m = re.match(r'(\d+)\.(\d+)\.(\d+)', sys.argv[1])
if not m or tuple(map(int, m.groups())) < (2,24,4): raise SystemExit(1)
PYVERSION
  [ "$TLS_MODE" != import ] || collect_https_certificate
  HTTPS_FILES_CREATED=1
  prepare_private_directory "$SUBBOOST_HOME/https" || return 1
  if [ "$TLS_MODE" = import ]; then
    install_secret_file "$TMP_DIR/origin.pem" "$SUBBOOST_HOME/https/origin.pem" || return 1
    install_secret_file "$TMP_DIR/origin.key" "$SUBBOOST_HOME/https/origin.key" || return 1
  fi
  local caddyfile="$TMP_DIR/Caddyfile"
  {
    printf '{\n    auto_https disable_redirects\n}\n\nhttps://%s {\n' "$HTTPS_DOMAIN"
    if [ "$TLS_MODE" = import ]; then
      printf '    tls /etc/subboost-tls/origin.pem /etc/subboost-tls/origin.key\n'
    else
      printf '    tls {\n        issuer acme {\n            disable_http_challenge\n        }\n    }\n'
    fi
    printf '    header Referrer-Policy "no-referrer"\n    reverse_proxy app:3000 {\n        header_down -Referrer-Policy\n    }\n}\n'
  } > "$caddyfile"
  install_secret_file "$caddyfile" "$SUBBOOST_HOME/https/Caddyfile" || return 1
  cat > "$TMP_DIR/https.yml" <<'YAML'
# Locally owned: always load AFTER the release-owned Compose file.
services:
  app:
    ports: !override
      - "127.0.0.1:${SUBBOOST_PORT}:3000"
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "443:443/tcp"
    volumes:
      - ./https:/etc/subboost-tls:ro
      - subboost-caddy-data:/data
      - subboost-caddy-config:/config
    command: ["caddy", "run", "--config", "/etc/subboost-tls/Caddyfile", "--adapter", "caddyfile"]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  subboost-caddy-data:
  subboost-caddy-config:
YAML
  install_secret_file "$TMP_DIR/https.yml" "$SUBBOOST_HOME/https-compose.yml" || return 1
  set_env_value SUBBOOST_INSTALL_MODE server || return 1
  set_env_value SUBBOOST_TLS_MODE "$TLS_MODE" || return 1
  set_env_value APP_URL "https://$HTTPS_DOMAIN" || return 1
  if [ "${RESUME_HTTPS:-0}" != 1 ]; then set_env_value SUBBOOST_PORT "$(random_free_port)"; fi
  set_env_value TRUST_PROXY_HEADERS false || return 1
  # Compose prioritizes exported variables over --env-file. Do not let an
  # inherited old APP_URL or port override the server configuration just saved.
  unset APP_URL SUBBOOST_PORT TRUST_PROXY_HEADERS
}

https_start_and_check() {
  [ "$INSTALL_MODE" = server ] || return 0
  run_step "检查 HTTPS 配置" compose run --rm --no-deps caddy caddy validate --config /etc/subboost-tls/Caddyfile --adapter caddyfile || return 1
  run_step "启动 HTTPS 服务" compose up -d caddy || return 1
  local i code=""
  for i in $(seq 1 30); do
    # Imported Origin CA certs are not publicly trusted. -k is LOCAL ONLY.
    local -a verification=()
    [ "$TLS_MODE" != import ] || verification=(-k)
    if curl --noproxy '*' "${verification[@]}" -fsS --connect-timeout 3 --max-time 5 \
      --resolve "$HTTPS_DOMAIN:443:127.0.0.1" "https://$HTTPS_DOMAIN/api/health/ready" >/dev/null 2>&1; then break; fi
    [ "$i" = 30 ] && { warn "本机 HTTPS 未就绪：自动证书请检查 DNS/橙云/443、防火墙和系统时间；运行 subboost logs 检查。"; return 1; }
    [ "$((i % 5))" != 0 ] || say "正在等待 HTTPS 就绪（$i/30）..."
    sleep 2
  done
  say "本机 HTTPS 验证通过。"
  # Test the actual endpoint first. Public recursive DNS caches can disagree
  # even after ACME validation succeeded; do not reuse the issuance gate here.
  code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 25 "https://$HTTPS_DOMAIN/api/health/ready" 2>/dev/null)" || code=000
  if [ "$code" != 200 ]; then
    warn "默认解析的 HTTPS 请求未通过（HTTP $code），正在查询公共 DNS 辅助诊断。"
    if https_dns_preflight diagnostic && [ -n "${DNS_PUBLIC_ADDRESS:-}" ]; then
      local public_ip="$DNS_PUBLIC_ADDRESS" retry_code
      [[ "$public_ip" != *:* ]] || public_ip="[$public_ip]"
      retry_code="$(curl --resolve "$HTTPS_DOMAIN:443:$public_ip" --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 25 "https://$HTTPS_DOMAIN/api/health/ready" 2>/dev/null)" || retry_code=000
      if [ "$retry_code" = 200 ]; then
        run_root rm -f "$SUBBOOST_HOME/.https-pending"
        say "公共解析地址的 HTTPS 实测通过，证书有效。"
        warn "默认解析路径尚未通过；网站已部署，请等待缓存更新或检查默认网络路径。无需重新安装，不保证所有客户端已可访问。"
        return 0
      fi
      code="$retry_code"
    fi
  fi
  case "$code" in
    200) run_root rm -f "$SUBBOOST_HOME/.https-pending"; say "公网 HTTPS 验证通过。" ;;
    522|523) warn "本机正常，但 Cloudflare 522/523：检查 DNS 指向、云安全组 TCP 443、Docker FORWARD/DOCKER-USER 防火墙和完全（严格）模式。"; return 1 ;;
    525|526) warn "Cloudflare TLS 校验失败：检查源站证书和完全（严格）模式。"; return 1 ;;
    *) warn "本机正常，但公网 HTTPS 检查失败（HTTP $code）：检查 A/AAAA、云防火墙、代理模式及证书信任。"; return 1 ;;
  esac
}

resume_https() {
  [ -z "$RESTORE_ARCHIVE" ] || die "--resume-https 不可与 --restore 同用；此操作不会重复恢复数据。"
  [ -f "$ENV_FILE" ] && [ -f "$COMPOSE_FILE" ] || die "未找到完整安装记录，不能继续 HTTPS。"
  [ "$(file_env_value "$ENV_FILE" SUBBOOST_INSTALL_MODE)" = server ] || die "此入口仅用于新版服务器模式；旧独立 Caddy 请先迁移配置。"
  [ -f "$SUBBOOST_HOME/https-compose.yml" ] || die "服务器 HTTPS Compose 缺失，请先恢复该文件。"
  mkdir -p "$TMP_DIR"
  INSTALL_MODE=server
  HTTPS_DOMAIN="$(file_env_value "$ENV_FILE" APP_URL)"; HTTPS_DOMAIN="${HTTPS_DOMAIN#https://}"
  # Empty TLS_MODE intentionally offers both modes again, including switching
  # from failed ACME to an imported Origin certificate.
  select_install_mode
  local saved="$TMP_DIR/https-previous"
  mkdir -p "$saved"
  cp -a "$ENV_FILE" "$saved/env"
  cp -a "$SUBBOOST_HOME/https-compose.yml" "$saved/compose"
  cp -a "$SUBBOOST_HOME/https" "$saved/https"
  if ! (prepare_https_config && run_step "检查 HTTPS 配置" compose run --rm --no-deps caddy caddy validate --config /etc/subboost-tls/Caddyfile --adapter caddyfile); then
    cp -a "$saved/env" "$ENV_FILE"
    cp -a "$saved/compose" "$SUBBOOST_HOME/https-compose.yml"
    cp -a "$saved/https/." "$SUBBOOST_HOME/https/"
    die "新配置验证失败，已恢复旧配置；数据库未改动。可重新运行 --resume-https。"
  fi
  unset APP_URL SUBBOOST_PORT TRUST_PROXY_HEADERS
  run_root touch "$SUBBOOST_HOME/.https-pending"
  run_step "启动 HTTPS 服务" compose up -d caddy
  run_step "加载 HTTPS 配置" compose restart caddy
  https_start_and_check || die "数据保留。修复 DNS/443 后运行 sudo subboost restart；更换证书方式可重新运行安装脚本 --resume-https。"
  say "HTTPS 配置完成；未恢复或替换数据库。"
}

main() {
  umask 077
  require_linux
  parse_args "$@"
  if [ "$RESUME_HTTPS" = 1 ]; then resume_https; return; fi
  local live_env="$ENV_FILE"
  local live_compose="$COMPOSE_FILE"
  if [ -e "$live_env" ] || [ -e "$live_compose" ]; then
    if [ -n "$RESTORE_ARCHIVE" ]; then
      die "--restore 仅用于全新安装，已有安装记录。恢复数据用 sudo subboost restore <backup.zip>；继续/更换 HTTPS 配置请将本安装命令的 --restore 文件参数替换为 --resume-https；网络修复后可运行 sudo subboost restart。"
    fi
    die "Existing installation metadata was found. Use 'subboost update' or inspect the incomplete installation before retrying."
  fi
  if [ -e "$SUBBOOST_HOME/https-compose.yml" ] || [ -e "$SUBBOOST_HOME/https" ]; then
    die "发现已有 HTTPS 配置，请先检查未完成的安装，不会覆盖已有证书。"
  fi
  select_install_mode
  if [ -n "$RESTORE_ARCHIVE" ]; then
    if ! command -v python3 >/dev/null 2>&1 && ! command -v unzip >/dev/null 2>&1; then https_dependencies; fi
    prepare_restore_archive
  fi
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
  if [ "$INSTALL_MODE" = server ]; then
    # Old backups may pin pre-HTTPS managers. Keep their application image and
    # encryption key, but use this release's HTTPS-aware deployment tooling.
    compose_url="${SUBBOOST_COMPOSE_URL:-$(resolve_url "$SUBBOOST_RELEASE_URL" "${manifest_compose:-$DEFAULT_COMPOSE_URL}")}"
    manager_url="${SUBBOOST_MANAGER_URL:-$(resolve_url "$SUBBOOST_RELEASE_URL" "${manifest_manager:-$DEFAULT_MANAGER_URL}")}"
  fi
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
  if [ -x "$SUBBOOST_BIN" ] && [ "$INSTALL_MODE" != server ]; then
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
    if [ "$INSTALL_MODE" = local ]; then
      configure_restored_local_access || die "本地访问地址配置未完成，尚未创建容器。"
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

    if [ "$INSTALL_MODE" != server ]; then
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
  fi

  if [ "$INSTALL_MODE" = local ]; then
    # A restored server backup must not claim HTTPS is configured locally.
    if [ -n "$(env_value SUBBOOST_INSTALL_MODE)" ]; then set_env_value SUBBOOST_INSTALL_MODE local; fi
    if [ -n "$(env_value SUBBOOST_TLS_MODE)" ]; then set_env_value SUBBOOST_TLS_MODE none; fi
  fi
  prepare_https_config
  if [ "$INSTALL_MODE" = server ]; then
    set_env_value SUBBOOST_COMPOSE_URL "$compose_url"
    set_env_value SUBBOOST_MANAGER_URL "$manager_url"
    grep -q '^HTTPS_SUPPORT_VERSION=1$' "$candidate_manager" || die "管理脚本不支持 HTTPS。请使用包含此功能的同版本发行资产。"
  fi

  compose config >/dev/null
  local services
  services="$(compose config --services)"
  for service in app db cron; do
    printf '%s\n' "$services" | grep -Fxq "$service" || die "Candidate Compose is missing service: $service"
  done
  docker_cmd volume ls -q > "$volumes_before"
  run_step "下载部署镜像" retry_network compose pull || die "镜像下载失败；尚未创建应用容器，可修复网络后重试。"
  if [ -n "$RESTORE_ARCHIVE" ]; then
    if ! run_step "启动数据库" compose up -d db || ! run_step "等待数据库就绪" wait_for_database; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed while starting PostgreSQL; resources created by this run were cleaned up."
    fi
    if ! run_step "校验备份" verify_restore_dump; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation stopped because the database backup is invalid."
    fi
    if ! run_step "恢复数据" restore_database_dump || ! run_step "设置管理员账户" reset_restored_admin_password; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed while restoring data or resetting the administrator password."
    fi
    if ! run_step "启动应用" compose up -d app || ! run_step "检查应用健康" wait_for_health "$(env_value SUBBOOST_PORT)" || ! run_step "启动定时任务" compose up -d cron; then
      cleanup_failed_install "$volumes_before"
      die "Migration installation failed; resources created by this run were cleaned up."
    fi
  else
    if ! run_step "启动数据库和应用" compose up -d db app || ! run_step "检查应用健康" wait_for_health "$(env_value SUBBOOST_PORT)" || ! run_step "启动定时任务" compose up -d cron; then
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

  if [ "$INSTALL_MODE" = server ]; then run_root touch "$SUBBOOST_HOME/.https-pending"; fi
  if ! https_start_and_check; then
    warn "应用及数据已保留，但 HTTPS 尚未通过验证，不能视为安装成功。修复网络后运行 sudo subboost restart；更换证书方式请重新运行安装脚本 --resume-https。不要再次 --restore。"
    exit 1
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
  trap 'if [ "${HTTPS_FILES_CREATED:-0}" = 1 ] && [ ! -f "$SUBBOOST_HOME/.env" ]; then sudo_do rm -f "$SUBBOOST_HOME/https-compose.yml"; sudo_do rm -rf "$SUBBOOST_HOME/https"; fi; rm -rf "$TMP_DIR"' EXIT
  DOCKER_RUNNER="docker"
  main "$@"
fi
