import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const publicRoot = path.resolve(__dirname, "../..");

function runBash(script: string) {
  return spawnSync("bash", ["-s"], {
    cwd: publicRoot,
    encoding: "utf8",
    input: script,
    timeout: 30_000,
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
    },
  });
}

describe("fresh-install restore migration", () => {
  it("reports every missing required setting before Docker installation", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      mkdir -p "$work/source"
      cat > "$work/source/database.dump" <<'DUMP'
dump
DUMP
      cat > "$work/source/subboost.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/example/subboost:1.1.0
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=database-password
DATABASE_URL=postgresql://subboost:database-password@db:5432/subboost?schema=public
ENCRYPTION_KEY=encryption-key
APP_URL=http://127.0.0.1:32123
SUBBOOST_PORT=32123
ENV
      cat > "$work/source/manifest.json" <<'JSON'
{"formatVersion":1,"databaseFile":"database.dump","environmentFile":"subboost.env"}
JSON
      python3 - "$work/source" "$work/backup.zip" <<'PY'
import pathlib
import sys
import zipfile

source = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w") as archive:
    for name in ("database.dump", "subboost.env", "manifest.json"):
        archive.write(source / name, name)
PY

      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$work/install"
      export SUBBOOST_BIN="$work/bin/subboost"
      source local/scripts/install.sh
      ensure_docker() { : > "$work/docker-called"; }

      set +e
      output="$(main --restore "$work/backup.zip" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      [ ! -e "$work/docker-called" ]
      case "$output" in
        *"Missing: JWT_SECRET CRON_SECRET"*) ;;
        *) exit 41 ;;
      esac
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Missing: JWT_SECRET CRON_SECRET");
  });

  it("rejects ZIP traversal entries", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      python3 - "$work/unsafe.zip" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("../database.dump", "dump")
    archive.writestr("subboost.env", "SUBBOOST_IMAGE=image\n")
    archive.writestr("manifest.json", "{}")
PY
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      set +e
      output="$(extract_restore_archive "$work/unsafe.zip" "$work/output" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      case "$output" in *"unsafe ZIP entry"*) exit 0 ;; *) exit 42 ;; esac
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unsafe ZIP entry");
  });

  it("resets restored administrator passwords with PostgreSQL bcrypt", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      cat > "$work/.env" <<'ENV'
POSTGRES_DB=subboost
POSTGRES_USER=subboost
ENV
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$work"
      source local/scripts/install.sh
      MIGRATION_ADMIN_PASSWORD='NewPassword123!'
      sql_file="$work/reset.sql"
      compose() {
        case "$*" in
          *'SELECT "username"'*) printf 'alice\nbob\n' ;;
          *) cat > "$sql_file" ;;
        esac
      }
      reset_restored_admin_password
      printf 'users=%s\n' "$MIGRATION_ADMIN_USERNAME"
      cat "$sql_file"
      grep -Fq 'CREATE EXTENSION IF NOT EXISTS pgcrypto;' "$sql_file"
      grep -Fq 'crypt('\''NewPassword123!'\'', gen_salt('\''bf'\'', 12))' "$sql_file"
      [ "$MIGRATION_ADMIN_USERNAME" = "alice,bob" ]
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("users=alice,bob");
    expect(result.stdout).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  });

  it("fails clearly when an administrator password cannot be prompted", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      read_secret_from_tty() { return 1; }
      set +e
      output="$(collect_migration_admin_password 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      case "$output" in
        *"set SUBBOOST_MIGRATION_ADMIN_PASSWORD"*) exit 0 ;;
        *) exit 43 ;;
      esac
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("set SUBBOOST_MIGRATION_ADMIN_PASSWORD");
  });

  it("installs a full backup in migration order and preserves its environment", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      source_dir="$work/source"
      install_dir="$work/install"
      bin_dir="$work/bin"
      mkdir -p "$source_dir" "$bin_dir"
      export TEST_LOG="$work/trace.log"
      : > "$TEST_LOG"

      cat > "$source_dir/docker-compose.yml" <<'COMPOSE'
services:
  app: { image: app }
  db: { image: postgres }
  cron: { image: cron }
COMPOSE
      cat > "$bin_dir/subboost" <<'MANAGER'
#!/usr/bin/env bash
printf 'manager:%s\n' "$*" >> "$TEST_LOG"
MANAGER
      chmod +x "$bin_dir/subboost"
      cat > "$source_dir/database.dump" <<'DUMP'
valid-database-dump
DUMP
      cat > "$source_dir/subboost.env" <<ENV
SUBBOOST_IMAGE=ghcr.io/example/subboost:1.1.0
SUBBOOST_CANDIDATE_IMAGE=ghcr.io/example/subboost:1.1.0
SUBBOOST_RELEASE_URL=file://$source_dir/release.json
SUBBOOST_COMPOSE_URL=file://$source_dir/docker-compose.yml
SUBBOOST_MANAGER_URL=file://$bin_dir/subboost
POSTGRES_DB=source_database
POSTGRES_USER=source_user
POSTGRES_PASSWORD=source_database_password
DATABASE_URL=postgresql://source_user:source_database_password@db:5432/source_database?schema=public
ENCRYPTION_KEY=source-encryption-key
JWT_SECRET=source-jwt-secret
CRON_SECRET=source-cron-secret
LOCAL_SETUP_TOKEN=source-setup-token
APP_URL=https://migrated.example:32123
SUBBOOST_PORT=32123
ENV
      cat > "$source_dir/manifest.json" <<'JSON'
{"formatVersion":1,"databaseFile":"database.dump","environmentFile":"subboost.env"}
JSON
      cat > "$source_dir/release.json" <<JSON
{"version":"1.1.0","image":"ignored-image","composeUrl":"file://$source_dir/docker-compose.yml","managerUrl":"file://$bin_dir/subboost"}
JSON
      python3 - "$source_dir" "$work/backup.zip" <<'PY'
import pathlib
import sys
import zipfile

source = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w") as archive:
    for name in ("database.dump", "subboost.env", "manifest.json"):
        archive.write(source / name, name)
PY

      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$install_dir"
      export SUBBOOST_BIN="$bin_dir/subboost"
      export SUBBOOST_RELEASE_URL="file://$source_dir/release.json"
      export SUBBOOST_UPDATE_RELEASE_URL="file://$source_dir/release.json"
      export SUBBOOST_MIGRATION_ADMIN_PASSWORD='NewPassword123!'
      source local/scripts/install.sh

      require_curl() { :; }
      ensure_docker() { DOCKER_RUNNER=docker; }
      docker_login_if_needed() { :; }
      run_root() { "$@"; }
      port_is_free() { return 0; }
      systemctl() { :; }
      docker_cmd() {
        case "$*" in
          "volume ls -q") return 0 ;;
          *) return 0 ;;
        esac
      }
      compose() {
        printf 'compose:%s\n' "$*" >> "$TEST_LOG"
        case "$*" in
          "config --services") printf 'app\ndb\ncron\n' ;;
          "config") return 0 ;;
          *) return 0 ;;
        esac
      }
      wait_for_database() { printf 'wait-db\n' >> "$TEST_LOG"; }
      verify_restore_dump() { printf 'verify-dump\n' >> "$TEST_LOG"; }
      restore_database_dump() {
        printf 'restore-dump\n' >> "$TEST_LOG"
        grep -Fq 'valid-database-dump' "$RESTORE_DUMP"
      }
      reset_restored_admin_password() {
        printf 'reset-admin:%s\n' "$MIGRATION_ADMIN_PASSWORD" >> "$TEST_LOG"
        MIGRATION_ADMIN_USERNAME=alice
      }
      wait_for_health() { printf 'health:%s\n' "$1" >> "$TEST_LOG"; }

      output="$(main --restore "$work/backup.zip")"
      printf '%s\n' "$output"

      cat > "$work/expected-trace" <<'TRACE'
compose:config
compose:config --services
compose:pull
compose:up -d db
wait-db
verify-dump
restore-dump
reset-admin:NewPassword123!
compose:up -d app
health:32123
compose:up -d cron
manager:agent-install
TRACE
      diff -u "$work/expected-trace" "$TEST_LOG"
      cmp "$source_dir/subboost.env" "$install_dir/.env"
      grep -Fq '访问地址: https://migrated.example:32123' <<< "$output"
      grep -Fq '管理员账号: alice' <<< "$output"
      grep -Fq '管理员密码: NewPassword123!' <<< "$output"
      grep -Fq 'POSTGRES_PASSWORD=source_database_password' "$install_dir/.env"
      grep -Fq 'JWT_SECRET=source-jwt-secret' "$install_dir/.env"
      grep -Fq 'CRON_SECRET=source-cron-secret' "$install_dir/.env"
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("完整迁移已完成");
    expect(result.stdout).toContain("管理员账号: alice");
    expect(result.stdout).toContain("管理员密码: NewPassword123!");
  });
});
