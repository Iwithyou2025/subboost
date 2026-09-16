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
    env: { ...process.env, LC_ALL: "C.UTF-8" },
  });
}

const fixture = String.raw`
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  home="$work/install"
  source_dir="$work/source"
  mkdir -p "$home" "$source_dir"
  : > "$home/docker-compose.yml"
  cat > "$home/.env" <<'OLD_ENV'
SUBBOOST_IMAGE=old-image
POSTGRES_DB=old_database
POSTGRES_USER=old_user
POSTGRES_PASSWORD=old_database_password
DATABASE_URL=postgresql://old_user:old_database_password@db:5432/old_database?schema=public
ENCRYPTION_KEY=old-encryption-key
JWT_SECRET=old-jwt-secret
CRON_SECRET=old-cron-secret
APP_URL=http://old.example:30000
SUBBOOST_PORT=30000
OLD_ONLY=preserved-before-migration
OLD_ENV
  cp "$home/.env" "$work/original.env"
  cat > "$source_dir/source.env" <<'SOURCE_ENV'
SUBBOOST_IMAGE=source-image
POSTGRES_DB=source_database
POSTGRES_USER=source_user
POSTGRES_PASSWORD=source_database_password
DATABASE_URL=postgresql://source_user:source_database_password@db:5432/source_database?schema=public
ENCRYPTION_KEY=source-encryption-key
JWT_SECRET=source-jwt-secret
CRON_SECRET=source-cron-secret
APP_URL=https://source.example:32123
SUBBOOST_PORT=32123
SOURCE_ONLY=installed-by-full-migration
SOURCE_ENV
  printf 'source-database-dump\n' > "$source_dir/source.dump"
  cat > "$source_dir/manifest.json" <<'JSON'
{"formatVersion":1,"databaseFile":"source.dump","environmentFile":"source.env"}
JSON
  python3 - "$source_dir" "$work/backup.zip" <<'PY'
import pathlib
import sys
import zipfile

source = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w") as archive:
    for name in ("source.dump", "source.env", "manifest.json"):
        archive.write(source / name, name)
PY

  export SUBBOOST_SCRIPT_SOURCE_ONLY=1
  export SUBBOOST_HOME="$home"
  source local/scripts/subboost.sh
  TMP_DIR="$work/tmp"
  trace="$work/trace"
  : > "$trace"
  sudo_do() { "$@"; }
  compose_files() {
    local env_file="$1"
    shift 2
    printf 'compose:%s:%s\n' "$(basename "$env_file")" "$*" >> "$trace"
  }
  compose() { compose_files "$ENV_FILE" "$COMPOSE_FILE" "$@"; }
  verify_dump_file() {
    printf 'verify:%s\n' "$(basename "$1")" >> "$trace"
    grep -Fq source-database-dump "$1"
  }
  port_is_free() { printf 'port-free:%s\n' "$1" >> "$trace"; }
  create_verified_dump() {
    printf 'safety-dump\n' >> "$trace"
    printf 'old-safety-dump\n' > "$1"
  }
  database_volume_name_with_files() {
    printf 'database-volume\n' >> "$trace"
    printf 'subboost-db-volume\n'
  }
  remove_database_volume_with_files() {
    printf 'remove-volume:%s:%s\n' "$(basename "$1")" "$3" >> "$trace"
  }
  wait_for_database_with_files() {
    printf 'wait-db:%s\n' "$(basename "$1")" >> "$trace"
  }
  restore_dump_with_files() {
    printf 'restore:%s:%s:%s\n' "$(basename "$2")" "$(env_file_value "$2" POSTGRES_USER)" "$(env_file_value "$2" POSTGRES_DB)" >> "$trace"
  }
  restored_admin_usernames_with_files() {
    printf 'admin-query:%s\n' "$(basename "$1")" >> "$trace"
    printf 'source-admin\n'
  }
`;

describe("existing-environment full migration", () => {
  it("waits through PostgreSQL's temporary init server before restoring", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      cat > "$work/source.env" <<'ENV'
POSTGRES_DB=subboost
POSTGRES_USER=subboost
ENV
      : > "$work/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      checks=0
      sleep() { :; }
      compose_files() {
        checks=$((checks + 1))
        case "$checks" in
          1|3|4|5) return 0 ;;
          *) return 1 ;;
        esac
      }

      wait_for_database_with_files "$work/source.env" "$work/docker-compose.yml"
      printf 'checks=%s\n' "$checks"
      [ "$checks" -eq 5 ]
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("checks=5");
  });

  it("replaces the database and complete environment while retaining a safety backup", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      wait_for_health() {
        printf 'health:%s\n' "$SUBBOOST_PORT" >> "$trace"
      }

      migrate_cmd "$work/backup.zip"
      cmp "$source_dir/source.env" "$home/.env"
      grep -Fq 'old-safety-dump' "$home"/backups/migrate-safety-*.dump
      cmp "$work/original.env" "$home"/backups/migrate-safety-*.env
      cat "$trace"
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Full migration completed successfully.");
    expect(result.stdout).toContain("访问地址: https://source.example:32123");
    expect(result.stdout).toContain("管理员账号: source-admin");
    expect(result.stdout).toContain("管理员密码: 请使用来源环境的管理员密码");
    expect(result.stdout).toContain("safety-dump");
    expect(result.stdout).toContain("remove-volume:migrate-old.env:subboost-db-volume");
    expect(result.stdout).toContain("restore:migrate-candidate.env:source_user:source_database");
    expect(result.stdout).toContain("health:32123");
  });

  it("restores the original environment and database when the migrated app is unhealthy", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      wait_for_health() {
        printf 'health:%s\n' "$SUBBOOST_PORT" >> "$trace"
        [ "$SUBBOOST_PORT" = "30000" ]
      }

      set +e
      output="$(migrate_cmd "$work/backup.zip" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      cmp "$work/original.env" "$home/.env"
      cat "$trace"
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Full migration failed: source app health check failed");
    expect(result.stdout).toContain("Previous complete environment restored successfully.");
    expect(result.stdout).toContain("restore:migrate-candidate.env:source_user:source_database");
    expect(result.stdout).toContain("restore:migrate-old.env:old_user:old_database");
    expect(result.stdout).toContain("health:32123");
    expect(result.stdout).toContain("health:30000");
  });

  it("stops before safety backup when the source configuration is incomplete", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      python3 - "$work/backup.zip" <<'PY'
import pathlib
import sys
import zipfile

archive_path = pathlib.Path(sys.argv[1])
source = archive_path.parent / "incomplete"
source.mkdir()
(source / "source.dump").write_text("dump", encoding="utf-8")
(source / "source.env").write_text("SUBBOOST_IMAGE=image\n", encoding="utf-8")
(source / "manifest.json").write_text(
    '{"formatVersion":1,"databaseFile":"source.dump","environmentFile":"source.env"}',
    encoding="utf-8",
)
with zipfile.ZipFile(archive_path, "w") as archive:
    for name in ("source.dump", "source.env", "manifest.json"):
        archive.write(source / name, name)
PY
      set +e
      output="$(migrate_cmd "$work/backup.zip" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      ! grep -Fq safety-dump "$trace"
      cmp "$work/original.env" "$home/.env"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backup configuration is incomplete. Missing:");
    expect(result.stdout).toContain("POSTGRES_DB");
    expect(result.stdout).toContain("JWT_SECRET");
  });

  it("rejects shell expressions in a complete environment before sourcing it", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      printf 'EVIL=$(touch %s)\n' "$work/executed" >> "$source_dir/source.env"
      set +e
      output="$(validate_full_migration_environment "$source_dir/source.env" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      [ ! -e "$work/executed" ]
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backup environment contains an unsafe value: EVIL");
  });
});
