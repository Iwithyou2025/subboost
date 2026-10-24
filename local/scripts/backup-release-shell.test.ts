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

describe("data-only backup release independence", () => {
  it.each(["pair", "zip", "web"])("exports %s data without deployment metadata and leaves the installed environment intact", (kind) => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      umask 077
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      cat > "$work/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/example/subboost:1.0.0
SUBBOOST_CANDIDATE_IMAGE=ghcr.io/example/subboost:1.0.0
SUBBOOST_RELEASE_URL=https://example.test/v1/release.json
SUBBOOST_COMPOSE_URL=https://example.test/v1/compose.yml
SUBBOOST_MANAGER_URL=https://example.test/v1/manager
FUTURE_APP_VERSION=1.0.0
LOCAL_SETUP_TOKEN=old-setup-token
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=database-password
DATABASE_URL=postgresql://subboost:database-password@db:5432/subboost?schema=public
ENCRYPTION_KEY=original-encryption-key-123456
JWT_SECRET=original-jwt-secret
CRON_SECRET=original-cron-secret
APP_URL=http://127.0.0.1:3000
SUBBOOST_PORT=3000
ENV
      cp "$work/.env" "$work/original.env"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1 SUBBOOST_HOME="$work"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      load_env() { :; }
      create_verified_dump() { printf 'verified-data' > "$1"; }
      prune_backups() { :; }
      backup_kind=BACKUP_KIND
      if [ "$backup_kind" = web ]; then
        data="$work/manager"
        mkdir -p "$data/status" "$data/exports"
        printf '{"id":"00000000-0000-0000-0000-000000000001","action":"export"}' > "$work/request.json"
        process_manager_job "$data" "$work/request.json"
        extract_backup_zip "$(printf '%s' "$data"/exports/*.zip)" "$work/extracted"
        exported_env="$RESTORE_ENV"
        grep -Fq '"state":"succeeded"' "$data/status/00000000-0000-0000-0000-000000000001.json"
      elif [ "$backup_kind" = zip ]; then
        backup_cmd --zip "$work/export.zip"
        extract_backup_zip "$work/export.zip" "$work/extracted"
        exported_env="$RESTORE_ENV"
        grep -Fq '"formatVersion":1' "$work/extracted/manifest.json"
      else
        backup_cmd
        exported_env="$BACKUP_ENV_OUT"
      fi
      grep -Fxq 'ENCRYPTION_KEY=original-encryption-key-123456' "$exported_env"
      grep -Fxq 'POSTGRES_PASSWORD=database-password' "$exported_env"
      grep -Fxq 'JWT_SECRET=original-jwt-secret' "$exported_env"
      grep -Fxq 'CRON_SECRET=original-cron-secret' "$exported_env"
      [ "$(wc -l < "$exported_env")" -eq 9 ]
      ! grep -Eq 'IMAGE|VERSION|RELEASE_URL|COMPOSE_URL|MANAGER_URL|LOCAL_SETUP_TOKEN' "$exported_env"
      [ "$(stat -c %a "$exported_env")" = 600 ]
      cmp "$work/.env" "$work/original.env"
    `.replace("BACKUP_KIND", kind));
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("uses the latest release manifest for a fresh installation", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      umask 077
      work="$(mktemp -d)"
      trap 'rm -rf "$work"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1 SUBBOOST_HOME="$work/install"
      export SUBBOOST_BIN="$work/bin/subboost" SUBBOOST_DRY_RUN=1
      source local/scripts/install.sh
      require_curl() { :; }
      fetch_release_manifest() {
        mkdir -p "$TMP_DIR"
        printf '{"version":"9.0.0","image":"latest-release-image","composeUrl":"latest-compose.yml","managerUrl":"latest-manager"}' > "$RELEASE_FILE"
      }
      output="$(main)"
      printf '%s\n' "$output"
      grep -Fq '[dry-run] image=latest-release-image' <<< "$output"
      grep -Fq '/releases/latest/download/latest-compose.yml' <<< "$output"
      grep -Fq '/releases/latest/download/latest-manager' <<< "$output"
    `);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
