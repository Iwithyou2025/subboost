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
  bin="$work/bin/subboost"
  units="$work/systemd"
  mkdir -p "$home/backups" "$(dirname "$bin")" "$units"
  cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/example/subboost@sha256:current
SUBBOOST_CANDIDATE_IMAGE=ghcr.io/example/subboost:candidate
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=encryption-key
JWT_SECRET=jwt-secret
CRON_SECRET=cron-secret
APP_URL=http://127.0.0.1:3000
SUBBOOST_PORT=3000
ENV
  : > "$home/docker-compose.yml"
  : > "$home/backups/backup.dump"
  : > "$bin"
  : > "$units/subboost-manager-agent.service"
  export SUBBOOST_SCRIPT_SOURCE_ONLY=1
  export SUBBOOST_HOME="$home"
  export SUBBOOST_BIN="$bin"
  export SUBBOOST_SYSTEMD_UNIT_DIR="$units"
  source local/scripts/subboost.sh
  sudo_do() { "$@"; }
`;

describe("subboost delete", () => {
  it("cancels without changing anything unless DELETE is entered", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      compose() { : > "$work/compose-was-called"; return 99; }
      docker_cmd() { : > "$work/docker-was-called"; return 99; }
      printf 'no\n' | delete_cmd
      [ -d "$home" ]
      [ -f "$bin" ]
      [ ! -e "$work/compose-was-called" ]
      [ ! -e "$work/docker-was-called" ]
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("已取消删除。");
  });

  it("removes all SubBoost resources and verifies that nothing remains", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      trace="$work/trace"
      resources="$work/resources"
      images="$work/images"
      service="$work/service"
      : > "$trace"
      printf 'present\n' > "$resources"
      printf 'present\n' > "$images"
      printf 'active\n' > "$service"

      compose() {
        printf 'compose:%s\n' "$*" >> "$trace"
        case "$*" in
          "ps -q -a") printf 'container-id\n' ;;
          "down --volumes --remove-orphans") rm -f "$resources" ;;
        esac
      }
      docker_cmd() {
        printf 'docker:%s\n' "$*" >> "$trace"
        case "$*" in
          "inspect -f "*) printf 'subboost\n' ;;
          "image ls "*) printf 'subboost-rollback:update-20260916\n' ;;
          "image inspect "*) [ -e "$images" ] ;;
          "image rm "*) rm -f "$images" ;;
          "ps -aq "*|"volume ls -q "*|"network ls -q "*) [ ! -e "$resources" ] ;;
        esac
      }
      systemctl() {
        printf 'systemctl:%s\n' "$*" >> "$trace"
        case "$*" in
          "disable --now "*) rm -f "$service" ;;
          "is-active --quiet "*) [ -e "$service" ] ;;
          *) return 0 ;;
        esac
      }

      printf 'DELETE\n' | main delete
      [ ! -e "$home" ]
      [ ! -e "$bin" ]
      [ ! -e "$units/subboost-manager-agent.service" ]
      cat "$trace"
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("SubBoost 的所有数据、服务和应用镜像均已删除。");
    expect(result.stdout).toContain("compose:down --volumes --remove-orphans");
    expect(result.stdout).toContain("docker:image rm ghcr.io/example/subboost@sha256:current");
    expect(result.stdout).toContain("docker:image rm ghcr.io/example/subboost:candidate");
    expect(result.stdout).toContain("docker:image rm subboost-rollback:update-20260916");
    expect(result.stdout).toContain("systemctl:disable --now subboost-manager-agent.service");
    expect(result.stdout).toContain("systemctl:daemon-reload");
  });

  it("fails verification and retains installation files when Docker data remains", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      ${fixture}
      compose() {
        case "$*" in
          "ps -q -a") printf 'container-id\n' ;;
          "down --volumes --remove-orphans") return 0 ;;
        esac
      }
      docker_cmd() {
        case "$*" in
          "inspect -f "*) printf 'subboost\n' ;;
          "image inspect "*) return 1 ;;
          "volume ls -q "*) printf 'leftover-volume\n' ;;
          *) return 0 ;;
        esac
      }
      systemctl() {
        case "$*" in "is-active --quiet "*) return 1 ;; *) return 0 ;; esac
      }

      set +e
      output="$(delete_cmd <<< 'DELETE' 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
      [ -d "$home" ]
      [ -f "$bin" ]
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("SubBoost Docker resources remain: volumes");
  });

  it("rejects dangerous installation roots before prompting", () => {
    const result = runBash(String.raw`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME=/opt
      source local/scripts/subboost.sh
      set +e
      output="$(delete_cmd <<< 'DELETE' 2>&1)"
      status=$?
      set -e
      printf 'status=%s\n%s\n' "$status" "$output"
      [ "$status" -ne 0 ]
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Refusing to delete unsafe SUBBOOST_HOME: /opt");
  });
});
