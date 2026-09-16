#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_HOME="/opt/subboost"
DEFAULT_STABLE_RELEASE_URL="https://github.com/Iwithyou2025/subboost/releases/latest/download/release.json"
DEFAULT_BACKUP_RETENTION_COUNT="10"
SUBBOOST_HOME="${SUBBOOST_HOME:-$DEFAULT_HOME}"
ENV_FILE="$SUBBOOST_HOME/.env"
COMPOSE_FILE="$SUBBOOST_HOME/docker-compose.yml"
BACKUP_DIR="$SUBBOOST_HOME/backups"
TMP_DIR="${TMPDIR:-/tmp}/subboost-manager.$$"
AGENT_SERVICE_NAME="subboost-manager-agent.service"
SYSTEMD_UNIT_DIR="${SUBBOOST_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

is_root() {
  [ "$(id -u)" = "0" ]
}

sudo_do() {
  if is_root; then "$@"; else sudo "$@"; fi
}

prepare_private_directory() {
  local directory="$1"
  sudo_do mkdir -p "$directory"
  sudo_do chmod 700 "$directory"
  if ! is_root; then sudo_do chown "$(id -u):$(id -g)" "$directory"; fi
}

install_secret_file() {
  local source="$1"
  local destination="$2"
  sudo_do install -m 600 "$source" "$destination"
  if ! is_root; then
    sudo_do chown "$(id -u):$(id -g)" "$destination"
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

ensure_docker_runner() {
  if [ -z "${DOCKER_RUNNER:-}" ]; then
    DOCKER_RUNNER="$(docker_runner)"
  fi
}

docker_cmd() {
  ensure_docker_runner
  if [ "$DOCKER_RUNNER" = "sudo docker" ]; then sudo docker "$@"; else docker "$@"; fi
}

compose() {
  compose_files "$ENV_FILE" "$COMPOSE_FILE" "$@"
}

compose_files() {
  local env_file="$1"
  local compose_file="$2"
  shift 2
  [ -f "$compose_file" ] || die "Missing $compose_file"
  [ -f "$env_file" ] || die "Missing $env_file"
  (cd "$SUBBOOST_HOME" && docker_cmd compose --project-directory "$SUBBOOST_HOME" --env-file "$env_file" -f "$compose_file" "$@")
}

compose_files_with_image() {
  local image="$1"
  shift
  SUBBOOST_IMAGE="$image" SUBBOOST_CANDIDATE_IMAGE="$image" compose_files "$@"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

download_to_temp() {
  local url="$1"
  local output="$2"
  case "$url" in
    file://*) cp "${url#file://}" "$output" ;;
    /*) cp "$url" "$output" ;;
    http://*|https://*) curl -fsSL "$url" -o "$output" ;;
    *) cp "$url" "$output" ;;
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
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

resolve_url() {
  local base="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  case "$value" in
    http://*|https://*|file://*|/*) printf '%s\n' "$value" ;;
    *)
      case "$base" in
        file://*) printf 'file://%s/%s\n' "$(dirname "${base#file://}")" "$value" ;;
        http://*|https://*) printf '%s/%s\n' "${base%/*}" "$value" ;;
        *) printf '%s/%s\n' "$(dirname "$base")" "$value" ;;
      esac
      ;;
  esac
}

read_env_file() {
  sudo_do cat "$ENV_FILE"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local tmp="$TMP_DIR/env"
  mkdir -p "$TMP_DIR"
  read_env_file | awk -F= -v key="$key" '$1 != key { print }' > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install_secret_file "$tmp" "$ENV_FILE"
}

write_runtime_env_value() {
  local key="$1"
  local value="$2"
  write_env_value "$key" "$value"
  export "$key=$value"
}

is_official_fixed_release_url() {
  case "$1" in
    https://github.com/Iwithyou2025/subboost/releases/download/v[0-9]*.[0-9]*.[0-9]*/release.json) return 0 ;;
    *) return 1 ;;
  esac
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
  fi
}

set_file_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp="$TMP_DIR/env.$key"
  awk -F= -v key="$key" '$1 != key { print }' "$file" > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

atomic_install_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  stage_install_file "$source" "$destination" "$mode"
  activate_staged_file "$destination"
}

stage_install_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local staged="${destination}.candidate.$$"
  sudo_do install -m "$mode" "$source" "$staged" || return 1
  if [ "$mode" = "600" ] && ! is_root; then
    sudo_do chown "$(id -u):$(id -g)" "$staged" || return 1
  fi
}

activate_staged_file() {
  local destination="$1"
  sudo_do mv -f "${destination}.candidate.$$" "$destination"
}

install_file_from_url() {
  local url="$1"
  local destination="$2"
  local mode="$3"
  local tmp="$TMP_DIR/download"
  mkdir -p "$TMP_DIR"
  download_to_temp "$url" "$tmp"
  sudo_do install -m "$mode" "$tmp" "$destination"
}

create_verified_dump() {
  local output="$1"
  local partial="${output}.partial"
  local -a dump_status verify_status
  prepare_private_directory "$(dirname "$output")"
  sudo_do install -m 600 /dev/null "$partial"
  set +e
  compose exec -T db pg_dump -Fc -U "${POSTGRES_USER:-subboost}" -d "${POSTGRES_DB:-subboost}" | sudo_do tee "$partial" >/dev/null
  dump_status=("${PIPESTATUS[@]}")
  set -e
  if (( dump_status[0] != 0 || dump_status[1] != 0 )) || [ ! -s "$partial" ]; then
    sudo_do rm -f -- "$partial"
    say "Backup failed: pg_dump=${dump_status[0]} write=${dump_status[1]}"
    return 1
  fi
  set +e
  sudo_do cat "$partial" | compose exec -T db pg_restore --list >/dev/null
  verify_status=("${PIPESTATUS[@]}")
  set -e
  if (( verify_status[0] != 0 || verify_status[1] != 0 )); then
    sudo_do rm -f -- "$partial"
    say "Backup verification failed: read=${verify_status[0]} pg_restore=${verify_status[1]}"
    return 1
  fi
  sudo_do mv "$partial" "$output"
}


env_file_value() {
  local file="$1"
  local key="$2"
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

verify_dump_file() {
  local dump_file="$1"
  local -a verify_status
  [ -s "$dump_file" ] || { say "Restore verification failed: dump file is empty."; return 1; }
  set +e
  sudo_do cat "$dump_file" | compose exec -T db pg_restore --list >/dev/null
  verify_status=("${PIPESTATUS[@]}")
  set -e
  if (( verify_status[0] != 0 || verify_status[1] != 0 )); then
    say "Restore verification failed: read=${verify_status[0]} pg_restore=${verify_status[1]}"
    return 1
  fi
}

restore_dump_with_files() {
  local dump_file="$1"
  local env_file="$2"
  local compose_file="$3"
  local db_user db_name
  local -a restore_status
  db_user="$(env_file_value "$env_file" POSTGRES_USER)"
  db_name="$(env_file_value "$env_file" POSTGRES_DB)"
  [ -n "$db_user" ] && [ -n "$db_name" ] || return 1
  if ! compose_files "$env_file" "$compose_file" exec -T db psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION CURRENT_USER;'; then
    return 1
  fi
  set +e
  sudo_do cat "$dump_file" | compose_files "$env_file" "$compose_file" exec -T db pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges -U "$db_user" -d "$db_name"
  restore_status=("${PIPESTATUS[@]}")
  set -e
  (( restore_status[0] == 0 && restore_status[1] == 0 ))
}

wait_for_database_with_files() {
  local env_file="$1"
  local compose_file="$2"
  local db_user db_name index stable_checks
  db_user="$(env_file_value "$env_file" POSTGRES_USER)"
  db_name="$(env_file_value "$env_file" POSTGRES_DB)"
  [ -n "$db_user" ] && [ -n "$db_name" ] || return 1
  # The PostgreSQL image briefly accepts connections during initdb, stops that
  # temporary server, and then starts the final server. Require a stable-ready
  # window so a restore cannot begin during that shutdown gap.
  stable_checks=0
  for index in $(seq 1 120); do
    if compose_files "$env_file" "$compose_file" exec -T db pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      stable_checks=$((stable_checks + 1))
      if [ "$stable_checks" -ge 3 ]; then
        return 0
      fi
    else
      stable_checks=0
    fi
    sleep 1
  done
  return 1
}

compose_files_with_encryption_key() {
  local env_file="$1"
  local compose_file="$2"
  local encryption_key
  shift 2
  encryption_key="$(env_file_value "$env_file" ENCRYPTION_KEY)"
  [ -n "$encryption_key" ] || die "ENCRYPTION_KEY is missing from $env_file"
  ENCRYPTION_KEY="$encryption_key" compose_files "$env_file" "$compose_file" "$@"
}

BACKUP_DB_OUT=""
BACKUP_ENV_OUT=""

create_backup_pair() {
  local stamp="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  prepare_private_directory "$BACKUP_DIR"
  BACKUP_DB_OUT="$BACKUP_DIR/subboost-$stamp.dump"
  BACKUP_ENV_OUT="$BACKUP_DIR/subboost-$stamp.env"
  create_verified_dump "$BACKUP_DB_OUT"
  sudo_do install -m 600 "$ENV_FILE" "$BACKUP_ENV_OUT"
}

prune_backups() {
  local -a sql_backups env_backups
  local i backup_retention_count
  backup_retention_count="${SUBBOOST_BACKUP_RETENTION_COUNT:-$DEFAULT_BACKUP_RETENTION_COUNT}"
  if ! [[ "$backup_retention_count" =~ ^[0-9]+$ ]] || (( backup_retention_count < 1 )); then
    die "SUBBOOST_BACKUP_RETENTION_COUNT must be a positive integer"
  fi

  shopt -s nullglob
  sql_backups=("$BACKUP_DIR"/subboost-*.dump)
  env_backups=("$BACKUP_DIR"/subboost-*.env)
  shopt -u nullglob

  if ((${#sql_backups[@]} > 0)); then sudo_do chmod 600 "${sql_backups[@]}"; fi
  if ((${#env_backups[@]} > 0)); then sudo_do chmod 600 "${env_backups[@]}"; fi

  for ((i = 0; i < ${#sql_backups[@]} - backup_retention_count; i++)); do
    sudo_do rm -f -- "${sql_backups[$i]}"
  done
  for ((i = 0; i < ${#env_backups[@]} - backup_retention_count; i++)); do
    sudo_do rm -f -- "${env_backups[$i]}"
  done
}

write_backup_manifest() {
  local output="$1"
  local dump_name="$2"
  local env_name="$3"
  cat > "$output" <<EOF
{"formatVersion":1,"createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","databaseFile":"$dump_name","environmentFile":"$env_name"}
EOF
}

create_zip_from_directory() {
  local source_dir="$1"
  local output="$2"
  shift 2
  local -a names=("$@")
  mkdir -p "$(dirname "$output")"
  if command -v zip >/dev/null 2>&1; then
    (cd "$source_dir" && zip -q "$output" "${names[@]}")
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$source_dir" "$output" "${names[@]}" <<'PYZIP'
import os
import sys
import zipfile
source, output, *names = sys.argv[1:]
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in names:
        archive.write(os.path.join(source, name), arcname=name)
PYZIP
    return
  fi
  die "Creating ZIP backups requires zip or python3."
}

extract_backup_zip() {
  local archive="$1"
  local output_dir="$2"
  local listing name dump_name="" env_name="" dump_count=0 env_count=0
  mkdir -p "$output_dir"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$archive" "$output_dir" <<'PYZIP'
import os
import stat
import sys
import zipfile
archive_path, output_dir = sys.argv[1:]
with zipfile.ZipFile(archive_path, "r") as archive:
    infos = archive.infolist()
    dump_count = 0
    env_count = 0
    manifest_count = 0
    for info in infos:
        name = info.filename
        if not name or name != os.path.basename(name) or "\\" in name or "/" in name:
            raise SystemExit("unsafe ZIP entry")
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise SystemExit("symlink ZIP entries are not allowed")
        if name.endswith(".dump"):
            dump_count += 1
        elif name.endswith(".env"):
            env_count += 1
        elif name == "manifest.json":
            manifest_count += 1
        else:
            raise SystemExit("unexpected ZIP entry")
    if dump_count != 1 or env_count != 1 or manifest_count > 1:
        raise SystemExit("ZIP must contain exactly one dump and one env file")
    for info in infos:
        with archive.open(info, "r") as src, open(os.path.join(output_dir, info.filename), "wb") as dst:
            dst.write(src.read())
PYZIP
  elif command -v unzip >/dev/null 2>&1; then
    listing="$(unzip -Z1 "$archive")" || return 1
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      case "$name" in
        */*|*\\*) say "Restore ZIP contains an unsafe path."; return 1 ;;
        *.dump) dump_name="$name"; dump_count=$((dump_count + 1)) ;;
        *.env) env_name="$name"; env_count=$((env_count + 1)) ;;
        manifest.json) ;;
        *) say "Restore ZIP contains an unexpected file: $name"; return 1 ;;
      esac
    done <<< "$listing"
    [ "$dump_count" = "1" ] && [ "$env_count" = "1" ] || { say "Restore ZIP must contain exactly one .dump and one .env file."; return 1; }
    unzip -p "$archive" "$dump_name" > "$output_dir/$dump_name"
    unzip -p "$archive" "$env_name" > "$output_dir/$env_name"
    if printf '%s\n' "$listing" | grep -Fxq manifest.json; then unzip -p "$archive" manifest.json > "$output_dir/manifest.json"; fi
  else
    die "Restoring ZIP backups requires unzip or python3."
  fi

  shopt -s nullglob
  local -a dumps=("$output_dir"/*.dump) envs=("$output_dir"/*.env)
  shopt -u nullglob
  [ "${#dumps[@]}" = "1" ] && [ "${#envs[@]}" = "1" ] || { say "Restore ZIP must contain exactly one .dump and one .env file."; return 1; }
  RESTORE_DUMP="${dumps[0]}"
  RESTORE_ENV="${envs[0]}"
}

RESTORE_DUMP=""
RESTORE_ENV=""

resolve_restore_inputs() {
  RESTORE_DUMP=""
  RESTORE_ENV=""
  if [ "$#" = "1" ]; then
    [ -f "$1" ] || die "Restore archive not found: $1"
    case "$1" in
      *.zip) extract_backup_zip "$1" "$TMP_DIR/restore-input" || die "Restore ZIP validation failed." ;;
      *) die "Single-file restore requires a .zip backup." ;;
    esac
  elif [ "$#" = "2" ]; then
    [ -f "$1" ] || die "Restore dump not found: $1"
    [ -f "$2" ] || die "Restore environment file not found: $2"
    case "$1" in *.dump) ;; *) die "First restore file must end in .dump." ;; esac
    case "$2" in *.env) ;; *) die "Second restore file must end in .env." ;; esac
    RESTORE_DUMP="$1"
    RESTORE_ENV="$2"
  else
    die "Usage: subboost restore <backup.zip> OR subboost restore <backup.dump> <backup.env>"
  fi
}

is_safe_env_secret_value() {
  [[ "$1" =~ ^[A-Za-z0-9._~:/+=-]{16,512}$ ]]
}

build_restore_env() {
  local backup_env="$1"
  local output_env="$2"
  local encryption_key
  encryption_key="$(env_file_value "$backup_env" ENCRYPTION_KEY)"
  [ -n "$encryption_key" ] || die "Backup environment is missing ENCRYPTION_KEY."
  is_safe_env_secret_value "$encryption_key" || die "Backup ENCRYPTION_KEY contains unsupported characters."
  read_env_file > "$output_env"
  set_file_env_value "$output_env" ENCRYPTION_KEY "$encryption_key"
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

service_container_id() {
  compose ps -q "$1" 2>/dev/null | head -n 1 || true
}

container_state() {
  local container_id="$1"
  [ -n "$container_id" ] || return 0
  docker_cmd inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true
}

container_health() {
  local container_id="$1"
  [ -n "$container_id" ] || return 0
  docker_cmd inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true
}

service_status_text() {
  local service="$1"
  local container_id state health
  container_id="$(service_container_id "$service")"
  if [ -z "$container_id" ]; then
    printf '未创建\n'
    return 0
  fi

  state="$(container_state "$container_id")"
  case "$state" in
    running)
      if [ "$service" = "db" ]; then
        health="$(container_health "$container_id")"
        case "$health" in
          healthy) printf '运行中，健康\n' ;;
          starting) printf '运行中，健康检查中\n' ;;
          unhealthy) printf '运行中，未健康\n' ;;
          *) printf '运行中\n' ;;
        esac
      else
        printf '运行中\n'
      fi
      ;;
    exited) printf '已停止\n' ;;
    restarting) printf '正在重启\n' ;;
    dead) printf '异常停止\n' ;;
    *) printf '%s\n' "${state:-未知}" ;;
  esac
}

health_status_text() {
  health_status_label "$(health_status_code)"
}

health_status_code() {
  local port base live_ok
  port="$(port_number "${SUBBOOST_PORT:-3000}")"
  base="http://127.0.0.1:$port"
  if ! command -v curl >/dev/null 2>&1; then
    printf 'curl-missing\n'
  else
    if curl -fsS "$base/api/health/live" >/dev/null 2>&1; then
      live_ok=1
    else
      live_ok=0
    fi

    if [ "$live_ok" = "1" ] && curl -fsS "$base/api/health/ready" >/dev/null 2>&1; then
      printf 'ok\n'
    elif [ "$live_ok" = "1" ]; then
      printf 'not-ready\n'
    else
      printf 'unhealthy\n'
    fi
  fi
}

health_status_label() {
  case "$1" in
    ok) printf '正常\n' ;;
    not-ready) printf '应用已启动，数据库未就绪\n' ;;
    curl-missing) printf '缺少 curl\n' ;;
    *) printf '异常\n' ;;
  esac
}

wait_for_health() {
  # Default max wait is about 30 seconds: 15 attempts with a 2-second interval.
  local attempts="${SUBBOOST_DOCTOR_HEALTH_ATTEMPTS:-15}"
  local interval="${SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS:-2}"
  local index status
  for index in $(seq 1 "$attempts"); do
    status="$(health_status_code)"
    if [ "$status" = "ok" ]; then
      return 0
    fi
    if [ "$index" != "$attempts" ]; then
      sleep "$interval"
    fi
  done
  return 1
}

doctor_health_failure_message() {
  local status="$1"
  case "$status" in
    not-ready) printf 'Health check failed: database is not ready.' ;;
    curl-missing) printf 'Health check failed: curl command is missing.' ;;
    *) printf 'Health check failed: app is not responding.' ;;
  esac
}

status_cmd() {
  load_env
  say "SubBoost 状态"
  say "访问地址: ${APP_URL:-未配置}"
  say "安装目录: $SUBBOOST_HOME"
  say ""
  say "服务状态:"
  say "应用: $(service_status_text app)"
  say "数据库: $(service_status_text db)"
  say "定时任务: $(service_status_text cron)"
  say ""
  say "健康检查: $(health_status_text)"
  say "备份目录: $BACKUP_DIR"
  say ""
  say "常用命令: subboost logs / subboost backup / subboost restore / subboost update / subboost restart / subboost doctor"
}

update_cmd() {
  load_env
  local release_url="${SUBBOOST_RELEASE_URL:-}"
  local release_file="$TMP_DIR/release.json"
  local candidate_env="$TMP_DIR/candidate.env"
  local candidate_compose="$TMP_DIR/candidate-compose.yml"
  local candidate_manager="$TMP_DIR/candidate-manager"
  local old_env="$TMP_DIR/old.env"
  local old_compose="$TMP_DIR/old-compose.yml"
  local old_manager="$TMP_DIR/old-manager"
  local rollback_dump="$BACKUP_DIR/update-rollback-$(date -u +%Y%m%dT%H%M%SZ).dump"
  local image="${SUBBOOST_IMAGE:-}" compose_url="" manager_url="" services=""
local app_id old_image_id rollback_tag old_image_ref
local update_error restore_error db_ready activated_image
  local manager_present=0 old_manager_present=0
  local -a restore_status
  mkdir -p "$TMP_DIR"
  if is_official_fixed_release_url "$release_url"; then
    say "Detected old fixed release update source; switching updates to stable latest."
    release_url="$DEFAULT_STABLE_RELEASE_URL"
  fi
if [ -n "$release_url" ]; then
  if ! download_to_temp "$release_url" "$release_file"; then
    die "Release manifest unavailable: $release_url"
  fi

  image="$(json_get image "$release_file" || true)"
  compose_url="$(resolve_url "$release_url" "$(json_get composeUrl "$release_file" || true)")"
  manager_url="$(resolve_url "$release_url" "$(json_get managerUrl "$release_file" || true)")"

  [ -n "$image" ] &&
    [ -n "$compose_url" ] &&
    [ -n "$manager_url" ] ||
    die "Release manifest is missing image, composeUrl, or managerUrl."

  download_to_temp "$compose_url" "$candidate_compose"
  download_to_temp "$manager_url" "$candidate_manager"

  [ -s "$candidate_manager" ] &&
    bash -n "$candidate_manager" ||
    die "Candidate manager is invalid."
else
  say "No release manifest configured; updating current image and compose only."

  cp "$COMPOSE_FILE" "$candidate_compose"

  if [ -f "${SUBBOOST_BIN:-/usr/local/bin/subboost}" ]; then
    sudo_do cp \
      "${SUBBOOST_BIN:-/usr/local/bin/subboost}" \
      "$candidate_manager"
    manager_present=1
  fi
fi
  [ -n "$manager_url" ] && manager_present=1
  [ -n "$image" ] || die "SUBBOOST_IMAGE is missing."
  read_env_file > "$candidate_env"
  cp "$candidate_env" "$old_env"
  cp "$COMPOSE_FILE" "$old_compose"
  if [ -f "${SUBBOOST_BIN:-/usr/local/bin/subboost}" ]; then
    sudo_do cp "${SUBBOOST_BIN:-/usr/local/bin/subboost}" "$old_manager"
    old_manager_present=1
  fi
  set_file_env_value "$candidate_env" SUBBOOST_IMAGE "$image"
  set_file_env_value "$candidate_env" SUBBOOST_CANDIDATE_IMAGE "$image"
  set_file_env_value "$candidate_env" SUBBOOST_RELEASE_URL "$release_url"
  [ -n "$compose_url" ] && set_file_env_value "$candidate_env" SUBBOOST_COMPOSE_URL "$compose_url"
  [ -n "$manager_url" ] && set_file_env_value "$candidate_env" SUBBOOST_MANAGER_URL "$manager_url"
  if ! grep -q '^LOCAL_SETUP_TOKEN=.' "$candidate_env"; then
    set_file_env_value "$candidate_env" LOCAL_SETUP_TOKEN "$(random_hex 32)"
  fi
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" config >/dev/null
  services="$(compose_files_with_image "$image" "$candidate_env" "$candidate_compose" config --services)"
  for service in app db cron; do
    printf '%s\n' "$services" | grep -Fxq "$service" || die "Candidate Compose is missing service: $service"
  done
  say "Pulling candidate image before the maintenance window..."
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" pull

  app_id="$(service_container_id app)"
  [ -n "$app_id" ] || die "Cannot identify the current app container for rollback."
  old_image_id="$(docker_cmd inspect -f '{{.Image}}' "$app_id" 2>/dev/null || true)"
  [ -n "$old_image_id" ] || die "Cannot identify the current app image for rollback."
  old_image_ref="${SUBBOOST_IMAGE:-}"
  rollback_tag="subboost-rollback:update-$$"
  if ! stage_install_file "$candidate_env" "$ENV_FILE" 600 \
    || ! stage_install_file "$candidate_compose" "$COMPOSE_FILE" 644 \
    || { [ "$manager_present" = "1" ] && ! stage_install_file "$candidate_manager" "${SUBBOOST_BIN:-/usr/local/bin/subboost}" 755; }; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    die "Candidate metadata could not be staged safely."
  fi
  if ! docker_cmd tag "$old_image_id" "$rollback_tag"; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    die "Could not create the rollback image tag."
  fi

  say "Pausing app and cron for a stable database snapshot..."
  if ! compose stop cron app; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    die "Update aborted because app and cron could not be paused safely."
  fi
  if ! create_verified_dump "$rollback_dump"; then
    compose up -d app cron || true
    wait_for_health || true
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    die "Update aborted because a verified rollback dump could not be created."
  fi

  update_error=""
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d db || update_error="candidate database startup failed"
  if [ -z "$update_error" ]; then
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d --no-deps --force-recreate app || update_error="candidate app startup or migration failed"
  fi
  if [ -z "$update_error" ] && ! wait_for_health; then
    update_error="candidate health check failed"
  fi
  if [ -z "$update_error" ]; then
    activate_staged_file "$ENV_FILE" || update_error="candidate environment activation failed"
  fi
  if [ -z "$update_error" ]; then
    activated_image="$(
      sudo_do sed -n 's/^SUBBOOST_IMAGE=//p' "$ENV_FILE" |
        tail -n 1
    )"

    [ "$activated_image" = "$image" ] ||
      update_error="candidate environment image activation did not persist"
  fi

  if [ -z "$update_error" ]; then
    activate_staged_file "$COMPOSE_FILE" || update_error="candidate Compose activation failed"
  fi
  if [ -z "$update_error" ] && [ "$manager_present" = "1" ]; then
    activate_staged_file "${SUBBOOST_BIN:-/usr/local/bin/subboost}" || update_error="candidate manager activation failed"
  fi
  if [ -z "$update_error" ]; then
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d --no-deps --force-recreate cron || update_error="candidate cron startup failed"
  fi
  if [ -z "$update_error" ] && [ "$manager_present" = "1" ] && command -v systemctl >/dev/null 2>&1; then
    if ! sudo_do env SUBBOOST_HOME="$SUBBOOST_HOME" SUBBOOST_BIN="${SUBBOOST_BIN:-/usr/local/bin/subboost}" "${SUBBOOST_BIN:-/usr/local/bin/subboost}" agent-install >/dev/null 2>&1; then
      say "Warning: web backup manager agent could not be installed automatically. Run: sudo subboost agent-install"
    fi
  fi

  if [ -n "$update_error" ]; then
    say "Candidate update failed: $update_error"
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" stop cron app >/dev/null 2>&1 || true
    docker_cmd tag "$rollback_tag" "$old_image_ref" || true
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    restore_error=""
    atomic_install_file "$old_env" "$ENV_FILE" 600 || restore_error="old environment metadata restore failed"
    atomic_install_file "$old_compose" "$COMPOSE_FILE" 644 || restore_error="old Compose metadata restore failed"
    if [ "$old_manager_present" = "1" ]; then
      atomic_install_file "$old_manager" "${SUBBOOST_BIN:-/usr/local/bin/subboost}" 755 || restore_error="old manager metadata restore failed"
    fi
    db_ready=1
    compose_files "$old_env" "$old_compose" up -d db || { restore_error="old database container did not start"; db_ready=0; }
    if [ "$db_ready" = "1" ]; then
      set +e
      sudo_do cat "$rollback_dump" | compose_files "$old_env" "$old_compose" exec -T db pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges -U "${POSTGRES_USER:-subboost}" -d "${POSTGRES_DB:-subboost}"
      restore_status=("${PIPESTATUS[@]}")
      set -e
      if (( restore_status[0] != 0 || restore_status[1] != 0 )); then restore_error="database restore failed"; fi
    fi
    if [ -n "$restore_error" ]; then
      compose_files "$old_env" "$old_compose" stop cron app >/dev/null 2>&1 || true
      say "Automatic rollback stopped: $restore_error"
      say "Rollback dump preserved at: $rollback_dump"
      say "Keep app and cron stopped. Restore manually with pg_restore before restarting them."
      return 1
    fi
    compose_files "$old_env" "$old_compose" up -d app
    if ! wait_for_health; then
      compose_files "$old_env" "$old_compose" stop cron app >/dev/null 2>&1 || true
      say "Database and old image were restored, but the old app did not become healthy."
      say "Rollback dump preserved at: $rollback_dump"
      return 1
    fi
    compose_files "$old_env" "$old_compose" up -d --no-deps --force-recreate cron
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    say "Previous version restored successfully."
    return 1
  fi

  docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
  load_env
  status_cmd
}

logs_cmd() {
  compose logs -f --tail="${SUBBOOST_LOG_TAIL:-200}" "$@"
}

backup_filename_stamp() {
  date -u +%Y-%m-%d-%H-%M-%S
}

backup_zip_cmd() {
  local output="${1:-}"
  umask 077
  local stamp archive_stamp work_dir manifest
  load_env
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  archive_stamp="$(backup_filename_stamp)"
  create_backup_pair "$stamp"
  prune_backups
  work_dir="$TMP_DIR/backup-zip-$stamp"
  mkdir -p "$work_dir"
  sudo_do cp "$BACKUP_DB_OUT" "$work_dir/$(basename "$BACKUP_DB_OUT")"
  sudo_do cp "$BACKUP_ENV_OUT" "$work_dir/$(basename "$BACKUP_ENV_OUT")"
  manifest="$work_dir/manifest.json"
  write_backup_manifest "$manifest" "$(basename "$BACKUP_DB_OUT")" "$(basename "$BACKUP_ENV_OUT")"
  if [ -z "$output" ]; then output="$BACKUP_DIR/subboost-backup-$archive_stamp.zip"; fi
  output="$(cd "$(dirname "$output")" 2>/dev/null && pwd)/$(basename "$output")" || die "Backup ZIP output directory does not exist."
  create_zip_from_directory "$work_dir" "$output" "$(basename "$BACKUP_DB_OUT")" "$(basename "$BACKUP_ENV_OUT")" manifest.json
  sudo_do chmod 600 "$output"
  say "Backup ZIP written:"
  say "  $output"
}

backup_cmd() {
  load_env
  if [ "${1:-}" = "--zip" ]; then
    [ "$#" -le 2 ] || die "Usage: subboost backup --zip [output.zip]"
    backup_zip_cmd "${2:-}"
    return
  fi
  [ "$#" = "0" ] || die "Usage: subboost backup [--zip [output.zip]]"
  create_backup_pair
  prune_backups
  say "Backup written:"
  say "  $BACKUP_DB_OUT"
  say "  $BACKUP_ENV_OUT"
}

restore_cmd() {
  umask 077
  load_env
  mkdir -p "$TMP_DIR"
  resolve_restore_inputs "$@"
  local old_env="$TMP_DIR/restore-old.env"
  local candidate_env="$TMP_DIR/restore-candidate.env"
  local safety_stamp safety_dump safety_env restore_error rollback_error
  safety_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  safety_dump="$BACKUP_DIR/restore-safety-$safety_stamp.dump"
  safety_env="$BACKUP_DIR/restore-safety-$safety_stamp.env"

  compose up -d db
  verify_dump_file "$RESTORE_DUMP" || die "Backup database dump is invalid."
  build_restore_env "$RESTORE_ENV" "$candidate_env"
  read_env_file > "$old_env"
  prepare_private_directory "$BACKUP_DIR"

  sudo_do install -m 600 "$ENV_FILE" "$safety_env"
  stage_install_file "$candidate_env" "$ENV_FILE" 600 || die "Restore environment could not be staged safely."

  say "Pausing app and cron for a stable safety snapshot..."
  if ! compose stop cron app; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$"
    compose_files "$old_env" "$COMPOSE_FILE" up -d app >/dev/null 2>&1 || true
    compose_files "$old_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate cron >/dev/null 2>&1 || true
    die "Restore aborted because app and cron could not be paused safely."
  fi

  say "Creating a verified safety backup before restore..."
  if ! create_verified_dump "$safety_dump"; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$"
    if ! compose_files "$old_env" "$COMPOSE_FILE" up -d app || ! wait_for_health; then
      compose_files "$old_env" "$COMPOSE_FILE" stop cron app >/dev/null 2>&1 || true
      die "Restore aborted because the safety database backup failed, and the original app could not be resumed safely."
    fi
    compose_files "$old_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate cron >/dev/null 2>&1 || true
    die "Restore aborted because the safety database backup failed."
  fi

  restore_error=""
  restore_dump_with_files "$RESTORE_DUMP" "$old_env" "$COMPOSE_FILE" || restore_error="database restore failed"
  if [ -z "$restore_error" ]; then
    activate_staged_file "$ENV_FILE" || restore_error="restored environment activation failed"
  fi
  if [ -z "$restore_error" ]; then
    compose_files_with_encryption_key "$candidate_env" "$COMPOSE_FILE" up -d db || restore_error="database startup failed"
  fi
  if [ -z "$restore_error" ]; then
    compose_files_with_encryption_key "$candidate_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate app || restore_error="app startup or migration failed"
  fi
  if [ -z "$restore_error" ] && ! wait_for_health; then
    restore_error="health check failed"
  fi
  if [ -z "$restore_error" ]; then
    compose_files_with_encryption_key "$candidate_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate cron || restore_error="cron startup failed"
  fi

  if [ -n "$restore_error" ]; then
    say "Restore failed: $restore_error"
    compose_files "$candidate_env" "$COMPOSE_FILE" stop cron app >/dev/null 2>&1 || true
    sudo_do rm -f "${ENV_FILE}.candidate.$$"
    rollback_error=""
    atomic_install_file "$old_env" "$ENV_FILE" 600 || rollback_error="original environment restore failed"
    compose_files "$old_env" "$COMPOSE_FILE" up -d db || rollback_error="database container did not start for rollback"
    if [ -z "$rollback_error" ]; then
      restore_dump_with_files "$safety_dump" "$old_env" "$COMPOSE_FILE" || rollback_error="safety database restore failed"
    fi
    if [ -n "$rollback_error" ]; then
      compose_files "$old_env" "$COMPOSE_FILE" stop cron app >/dev/null 2>&1 || true
      say "Automatic rollback stopped: $rollback_error"
      say "Safety dump preserved at: $safety_dump"
      say "Safety environment preserved at: $safety_env"
      return 1
    fi
    compose_files "$old_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate app
    if ! wait_for_health; then
      compose_files "$old_env" "$COMPOSE_FILE" stop cron app >/dev/null 2>&1 || true
      say "Safety database and environment were restored, but the app did not become healthy."
      say "Safety dump preserved at: $safety_dump"
      return 1
    fi
    compose_files "$old_env" "$COMPOSE_FILE" up -d --no-deps --force-recreate cron
    say "Previous data and environment restored successfully."
    return 1
  fi

  load_env
  say "Restore completed successfully."
  say "Safety backup retained: $safety_dump"
  status_cmd
}

manager_data_host_dir() {
  local app_id source
  app_id="$(service_container_id app)"
  [ -n "$app_id" ] || return 1
  source="$(docker_cmd inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/subboost-manager"}}{{.Source}}{{end}}{{end}}' "$app_id" 2>/dev/null || true)"
  [ -n "$source" ] && [ -d "$source" ] || return 1
  printf '%s\n' "$source"
}

manager_prepare_data_dirs() {
  local data_dir="$1"
  local dir
  for dir in jobs uploads exports status; do
    sudo_do mkdir -p "$data_dir/$dir"
    sudo_do chown --reference="$data_dir" "$data_dir/$dir" 2>/dev/null || true
    sudo_do chmod 700 "$data_dir/$dir"
  done
}

json_escape_line() {
  printf '%s' "$1" | tr '\t\r\n' '   ' | LC_ALL=C tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

manager_write_status() {
  local data_dir="$1" id="$2" action="$3" state="$4" message="${5:-}" output_file="${6:-}"
  local status_file="$data_dir/status/$id.json"
  local tmp="$status_file.tmp.$$"
  printf '{"id":"%s","action":"%s","state":"%s","message":"%s","outputFile":"%s","updatedAt":"%s"}\n' \
    "$(json_escape_line "$id")" \
    "$(json_escape_line "$action")" \
    "$(json_escape_line "$state")" \
    "$(json_escape_line "$message")" \
    "$(json_escape_line "$output_file")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  sudo_do chown --reference="$data_dir" "$tmp" 2>/dev/null || true
  sudo_do chmod 600 "$tmp"
  sudo_do mv -f "$tmp" "$status_file"
}

manager_write_heartbeat() {
  local data_dir="$1"
  local tmp="$data_dir/agent-heartbeat.tmp.$$"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  sudo_do chown --reference="$data_dir" "$tmp" 2>/dev/null || true
  sudo_do chmod 600 "$tmp"
  sudo_do mv -f "$tmp" "$data_dir/agent-heartbeat"
}

safe_manager_filename() {
  case "$1" in
    ""|*/*|*\\*) return 1 ;;
    *) return 0 ;;
  esac
}

process_manager_job() {
  local data_dir="$1" job_file="$2"
  local id action input_zip input_dump input_env output_file output_path output status=0 job_tmp
  id="$(json_get id "$job_file" || true)"
  action="$(json_get action "$job_file" || true)"
  [[ "$id" =~ ^[a-f0-9-]{36}$ ]] || return 1
  case "$action" in export|restore) ;; *) return 1 ;; esac
  manager_write_status "$data_dir" "$id" "$action" running "任务正在执行。"

  if [ "$action" = "export" ]; then
    output_file="subboost-backup-$(backup_filename_stamp).zip"
    output_path="$data_dir/exports/$output_file"
    job_tmp="$TMP_DIR/job-$id"
    prepare_private_directory "$job_tmp"
    set +e
    output="$(
      TMP_DIR="$job_tmp"
      backup_zip_cmd "$output_path" 2>&1
    )"
    status=$?
    set -e
    sudo_do rm -rf -- "$job_tmp"
    if [ "$status" = "0" ]; then
      sudo_do chown --reference="$data_dir" "$output_path" 2>/dev/null || true
      sudo_do chmod 600 "$output_path"
      manager_write_status "$data_dir" "$id" "$action" succeeded "备份已生成。" "$output_file"
    else
      manager_write_status "$data_dir" "$id" "$action" failed "${output:-备份导出失败。}"
    fi
    return "$status"
  fi

  input_zip="$(json_get inputZip "$job_file" || true)"
  input_dump="$(json_get inputDump "$job_file" || true)"
  input_env="$(json_get inputEnv "$job_file" || true)"
  job_tmp="$TMP_DIR/job-$id"
  prepare_private_directory "$job_tmp"
  if [ -n "$input_zip" ]; then
    safe_manager_filename "$input_zip" || { sudo_do rm -rf -- "$job_tmp"; manager_write_status "$data_dir" "$id" "$action" failed "备份文件名无效。"; return 1; }
    set +e
    output="$(
      TMP_DIR="$job_tmp"
      restore_cmd "$data_dir/uploads/$input_zip" 2>&1
    )"
    status=$?
    set -e
    sudo_do rm -f -- "$data_dir/uploads/$input_zip"
  else
    safe_manager_filename "$input_dump" && safe_manager_filename "$input_env" || { sudo_do rm -rf -- "$job_tmp"; manager_write_status "$data_dir" "$id" "$action" failed "备份文件名无效。"; return 1; }
    set +e
    output="$(
      TMP_DIR="$job_tmp"
      restore_cmd "$data_dir/uploads/$input_dump" "$data_dir/uploads/$input_env" 2>&1
    )"
    status=$?
    set -e
    sudo_do rm -f -- "$data_dir/uploads/$input_dump" "$data_dir/uploads/$input_env"
  fi
  sudo_do rm -rf -- "$job_tmp"
  if [ "$status" = "0" ]; then
    manager_write_status "$data_dir" "$id" "$action" succeeded "恢复成功，SubBoost 已重新启动。"
  else
    manager_write_status "$data_dir" "$id" "$action" failed "${output:-恢复失败。}"
  fi
  return "$status"
}

agent_cmd() {
  load_env
  local data_dir="" interval="${SUBBOOST_AGENT_POLL_SECONDS:-2}" job working
  while true; do
    data_dir="$(manager_data_host_dir || true)"
    if [ -z "$data_dir" ]; then
      sleep "$interval"
      continue
    fi
    manager_prepare_data_dirs "$data_dir"
    manager_write_heartbeat "$data_dir"
    shopt -s nullglob
    local -a jobs=("$data_dir"/jobs/*.json)
    shopt -u nullglob
    for job in "${jobs[@]}"; do
      working="${job}.working.$$"
      sudo_do mv "$job" "$working" 2>/dev/null || continue
      process_manager_job "$data_dir" "$working" || true
      sudo_do rm -f -- "$working"
      manager_write_heartbeat "$data_dir"
    done
    sleep "$interval"
  done
}

agent_install_cmd() {
  command -v systemctl >/dev/null 2>&1 || die "systemd is required for the web backup manager agent."
  local manager_bin unit_tmp unit_file
  manager_bin="${SUBBOOST_BIN:-}"
  if [ -z "$manager_bin" ]; then
    manager_bin="$(command -v subboost || true)"
  fi
  [ -n "$manager_bin" ] && [ -x "$manager_bin" ] || die "Cannot locate the installed subboost manager binary."
  unit_file="$SYSTEMD_UNIT_DIR/$AGENT_SERVICE_NAME"
  unit_tmp="$TMP_DIR/$AGENT_SERVICE_NAME"
  mkdir -p "$TMP_DIR"
  cat > "$unit_tmp" <<EOF
[Unit]
Description=SubBoost backup and restore manager agent
After=docker.service
Wants=docker.service

[Service]
Type=simple
Environment="SUBBOOST_HOME=$SUBBOOST_HOME"
Environment="SUBBOOST_BIN=$manager_bin"
ExecStart="$manager_bin" agent
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  sudo_do mkdir -p "$SYSTEMD_UNIT_DIR"
  sudo_do install -m 644 "$unit_tmp" "$unit_file"
  sudo_do systemctl daemon-reload
  sudo_do systemctl enable "$AGENT_SERVICE_NAME" >/dev/null
  sudo_do systemctl restart "$AGENT_SERVICE_NAME"
  say "Backup manager agent installed and started."
}

validate_delete_targets() {
  [ -n "$SUBBOOST_HOME" ] && [[ "$SUBBOOST_HOME" = /* ]] || die "SUBBOOST_HOME must be an absolute path."
  case "$SUBBOOST_HOME" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      die "Refusing to delete unsafe SUBBOOST_HOME: $SUBBOOST_HOME"
      ;;
  esac
}

delete_compose_project_name() {
  local container_id project_name
  container_id="$(compose ps -q -a 2>/dev/null | head -n 1 || true)"
  if [ -n "$container_id" ]; then
    project_name="$(docker_cmd inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_id" 2>/dev/null || true)"
    if [ -n "$project_name" ]; then
      printf '%s\n' "$project_name"
      return 0
    fi
  fi
  basename "$SUBBOOST_HOME" | LC_ALL=C tr '[:upper:]' '[:lower:]' | sed 's/^[^a-z0-9]*//; s/[^a-z0-9_-]//g'
}

delete_docker_residuals() {
  local project_name="$1"
  local image residuals=""
  shift

  if [ -n "$(docker_cmd ps -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)" ]; then
    residuals="${residuals} containers"
  fi
  if [ -n "$(docker_cmd volume ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)" ]; then
    residuals="${residuals} volumes"
  fi
  if [ -n "$(docker_cmd network ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)" ]; then
    residuals="${residuals} networks"
  fi
  for image in "$@"; do
    if docker_cmd image inspect "$image" >/dev/null 2>&1; then
      residuals="${residuals} image:$image"
    fi
  done

  [ -z "$residuals" ] || die "SubBoost Docker resources remain:$residuals"
}

delete_cmd() {
  local confirmation="" project_name manager_bin unit_file image key rollback_image
  local seen_images=" "
  local -a images=()

  validate_delete_targets
  load_env
  manager_bin="${SUBBOOST_BIN:-/usr/local/bin/subboost}"
  unit_file="$SYSTEMD_UNIT_DIR/$AGENT_SERVICE_NAME"

  say "警告：此操作将永久删除 SubBoost 的数据库、配置、备份、容器、数据卷和应用镜像。"
  printf '请输入 DELETE 确认删除，其他输入将取消: '
  IFS= read -r confirmation || confirmation=""
  if [ "$confirmation" != "DELETE" ]; then
    say "已取消删除。"
    return 0
  fi

  for key in SUBBOOST_IMAGE SUBBOOST_CANDIDATE_IMAGE; do
    image="$(env_file_value "$ENV_FILE" "$key")"
    [ -n "$image" ] || continue
    case "$seen_images" in
      *" $image "*) ;;
      *) images+=("$image"); seen_images="${seen_images}${image} " ;;
    esac
  done
  while IFS= read -r rollback_image; do
    [ -n "$rollback_image" ] || continue
    case "$seen_images" in
      *" $rollback_image "*) ;;
      *) images+=("$rollback_image"); seen_images="${seen_images}${rollback_image} " ;;
    esac
  done < <(docker_cmd image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=subboost-rollback:update-*' 2>/dev/null || true)

  project_name="$(delete_compose_project_name)"
  [ -n "$project_name" ] || die "Unable to determine the SubBoost Docker Compose project name."

  if command -v systemctl >/dev/null 2>&1; then
    sudo_do systemctl disable --now "$AGENT_SERVICE_NAME" >/dev/null 2>&1 || true
  fi

  say "正在删除 SubBoost 容器、网络和数据卷..."
  compose down --volumes --remove-orphans || die "Docker Compose cleanup failed; installation files were retained."

  say "正在删除 SubBoost 应用镜像..."
  for image in "${images[@]}"; do
    docker_cmd image rm "$image" >/dev/null 2>&1 || true
  done
  delete_docker_residuals "$project_name" "${images[@]}"

  sudo_do rm -f -- "$unit_file"
  if command -v systemctl >/dev/null 2>&1; then
    sudo_do systemctl daemon-reload >/dev/null 2>&1 || true
    sudo_do systemctl reset-failed "$AGENT_SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  sudo_do rm -f -- "$manager_bin"
  sudo_do rm -rf -- "$SUBBOOST_HOME"

  [ ! -e "$SUBBOOST_HOME" ] || die "SubBoost installation directory remains: $SUBBOOST_HOME"
  [ ! -e "$manager_bin" ] || die "SubBoost manager remains: $manager_bin"
  [ ! -e "$unit_file" ] || die "SubBoost manager service remains: $unit_file"
  if command -v systemctl >/dev/null 2>&1 && sudo_do systemctl is-active --quiet "$AGENT_SERVICE_NAME"; then
    die "SubBoost manager service is still active."
  fi
  delete_docker_residuals "$project_name" "${images[@]}"

  say "SubBoost 的所有数据、服务和应用镜像均已删除。"
}

restart_cmd() {
  compose up -d --remove-orphans
  compose up -d --no-deps --force-recreate app
  status_cmd
}

doctor_cmd() {
  command -v docker >/dev/null 2>&1 || die "docker command is missing"
  docker_cmd compose version >/dev/null 2>&1 || die "docker compose plugin is missing"
  [ -d "$SUBBOOST_HOME" ] || die "Missing $SUBBOOST_HOME"
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
  [ -f "$COMPOSE_FILE" ] || die "Missing $COMPOSE_FILE"
  load_env
  for key in SUBBOOST_IMAGE POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL ENCRYPTION_KEY JWT_SECRET CRON_SECRET APP_URL SUBBOOST_PORT; do
    grep -q "^$key=" "$ENV_FILE" || die "Missing $key in $ENV_FILE"
  done
  compose config >/dev/null
  if ! wait_for_health; then
    local health_status
    health_status="$(health_status_code)"
    status_cmd
    die "$(doctor_health_failure_message "$health_status")"
  fi
  status_cmd
  say "Doctor: OK"
}

menu_cmd() {
  say "SubBoost"
  say "1) Status"
  say "2) Update"
  say "3) Logs"
  say "4) Backup"
  say "5) Restore"
  say "6) Restart"
  say "7) Doctor"
  say "8) Delete SubBoost"
  say "0) Exit"
  local choice="" restore_path=""
  if [ -t 0 ]; then
    printf 'Choose: '
    IFS= read -r choice || choice=""
  fi
  case "$choice" in
    1) status_cmd ;;
    2) update_cmd ;;
    3) logs_cmd ;;
    4) backup_cmd ;;
    5)
      printf 'Backup ZIP path: '
      IFS= read -r restore_path || restore_path=""
      [ -n "$restore_path" ] || die "Backup path is required."
      restore_cmd "$restore_path"
      ;;
    6) restart_cmd ;;
    7) doctor_cmd ;;
    8) delete_cmd ;;
    0|"") exit 0 ;;
    *) die "Unknown menu choice: $choice" ;;
  esac
}

main() {
  local command="${1:-menu}"
  if [ "$#" -gt 0 ]; then shift; fi
  case "$command" in
    menu) menu_cmd ;;
    status) status_cmd ;;
    update) update_cmd ;;
    logs) logs_cmd "$@" ;;
    backup) backup_cmd "$@" ;;
    restore) restore_cmd "$@" ;;
    restart) restart_cmd ;;
    doctor) doctor_cmd ;;
    agent) agent_cmd ;;
    agent-install) agent_install_cmd ;;
    delete) delete_cmd ;;
    *) die "Unknown command: $command" ;;
  esac
}

if [ "${SUBBOOST_SCRIPT_SOURCE_ONLY:-0}" != "1" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
  DOCKER_RUNNER=""
  main "$@"
fi
