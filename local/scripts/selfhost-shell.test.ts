import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const publicRoot = path.resolve(__dirname, "../..");
const BASH_NON_INTERACTIVE_COMMAND = "exec \"$BASH\" -s";
const POSIX_BACKUP_MODE_ASSERTIONS = process.platform === "win32"
  ? ": # NTFS permissions are verified by Windows ACL checks, not POSIX mode bits"
  : `
      [ "$unsafe_files" = "0" ]
      [ "$unsafe_dirs" = "0" ]`;

function runBash(script: string) {
  return spawnSync("bash", ["-lc", BASH_NON_INTERACTIVE_COMMAND], {
    cwd: publicRoot,
    encoding: "utf8",
    input: script,
    timeout: 30_000,
    detached: true,
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
    },
  });
}

describe("self-host shell scripts", () => {
  it("preserves an explicit Docker config when Docker requires sudo", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      export DOCKER_CONFIG=/tmp/subboost-isolated-docker-config
      DOCKER_RUNNER="sudo docker"
      sudo() { printf 'sudo-call=%s\\n' "$*"; }
      docker_cmd info
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "sudo-call=env DOCKER_CONFIG=/tmp/subboost-isolated-docker-config docker info",
    );
  });

  it("uses prompt defaults without /dev/tty errors in non-interactive mode", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      export SUBBOOST_ASSUME_YES=0
      value="$(prompt 'Question: ' 'default-value')"
      printf 'value=%s\\n' "$value"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("value=default-value");
    expect(result.stderr).not.toContain("/dev/tty");
  });

  it("does not report Doctor OK when health checks fail", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 1; }
      set +e
      output="$(doctor_cmd 2>&1)"
      status=$?
      set -e
      printf 'status=%s\\n%s\\n' "$status" "$output"
      [ "$status" -ne 0 ]
      case "$output" in *"Doctor: OK"*) exit 44 ;; esac
      case "$output" in *"健康检查: 异常"*) exit 0 ;; *) exit 45 ;; esac
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).toContain("健康检查: 异常");
    expect(result.stdout).not.toContain("Doctor: OK");
    expect(result.stdout).toContain("ERROR: Health check failed: app is not responding.");
  });

  it("reports Doctor OK only after health checks pass", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      doctor_cmd
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("健康检查: 正常");
    expect(result.stdout).toContain("Doctor: OK");
  });

  it("loads SUBBOOST_PORT from .env before doctor health checks", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31041
SUBBOOST_PORT=31041
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      unset SUBBOOST_PORT APP_URL
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl_urls="$home/curl-urls"
      : > "$curl_urls"
      curl() {
        printf '%s\\n' "$*" >> "$curl_urls"
        case "$*" in
          *"http://127.0.0.1:31041/api/health/"*) return 0 ;;
        esac
        return 1
      }
      doctor_cmd
      cat "$curl_urls"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Doctor: OK");
    expect(result.stdout).toContain("http://127.0.0.1:31041/api/health/live");
    expect(result.stdout).toContain("http://127.0.0.1:31041/api/health/ready");
    expect(result.stdout).not.toContain("http://127.0.0.1:3000/api/health");
  });

  it("waits for health before reporting update status", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=3
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_calls_file="$home/docker-calls"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          printf '%s\\n' "$*" >> "$docker_calls_file"
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull") return 0 ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl_count_file="$home/curl-count"
      ready_threshold=5
      printf '0\\n' > "$curl_count_file"
      curl() {
        count="$(cat "$curl_count_file")"
        count=$((count + 1))
        printf '%s\\n' "$count" > "$curl_count_file"
        case "$*" in
          *"/api/health/live"*) return 0 ;;
          *"/api/health/ready"*) [ "$count" -ge "$ready_threshold" ]; return $? ;;
        esac
        return 1
      }
      update_cmd
      printf 'curl_count=%s\\n' "$(cat "$curl_count_file")"
      cat "$docker_calls_file"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("健康检查: 正常");
    expect(result.stdout).not.toContain("健康检查: 异常");
    // wait_for_health checks live once per attempt, then status_cmd performs one final live+ready check.
    expect(result.stdout).toContain("curl_count=8");
    expect(result.stdout).toContain("up -d --no-deps --force-recreate cron");
  }, 10_000);

  it("restarts rollback cron without recreating the healthy old app", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      release_dir="$home/release"
      mkdir -p "$release_dir" "$home/bin"
      cat > "$release_dir/release.json" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
      printf 'services:\n  app:\n    image: \${SUBBOOST_IMAGE}\n' > "$release_dir/docker-compose.image.yml"
      printf '#!/usr/bin/env bash\necho new-manager\n' > "$release_dir/subboost-manager"
      printf '#!/usr/bin/env bash\necho old-manager\n' > "$home/bin/subboost"
      cat > "$home/.env" <<ENV
SUBBOOST_RELEASE_URL=file://$release_dir/release.json
SUBBOOST_IMAGE=old-image
SUBBOOST_CANDIDATE_IMAGE=old-candidate-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_calls_file="$home/docker-calls"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          printf '%s\\n' "$*" >> "$docker_calls_file"
          printf 'image=%s candidate_image=%s command=%s\\n' "\${SUBBOOST_IMAGE:-}" "\${SUBBOOST_CANDIDATE_IMAGE:-}" "$*" >> "$docker_calls_file"
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config" | *" pull" | *" stop cron app") return 0 ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"* | *"pg_restore --clean"*) cat >/dev/null; return 0 ;;
            *"candidate-compose.yml up -d --no-deps --force-recreate cron") return 1 ;;
            *" up -d "*) return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
          printf 'sha256:old-image\\n'
        fi
        return 0
      }
      curl() { return 0; }
      update_status=0
      if update_cmd; then
        :
      else
        update_status=$?
      fi
      printf 'update_status=%s parent_image=%s parent_candidate_image=%s\\n' "$update_status" "$SUBBOOST_IMAGE" "$SUBBOOST_CANDIDATE_IMAGE"
      cat "$docker_calls_file"
      [ "$update_status" -eq 1 ]
    `;

    const result = runBash(script);

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Candidate update failed: candidate cron startup failed");
    expect(result.stdout).toContain("Previous version restored successfully.");
    expect(result.stdout).toContain(
      "update_status=1 parent_image=old-image parent_candidate_image=old-candidate-image",
    );
    expect(result.stdout).toMatch(/image=new-image candidate_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps --force-recreate cron$/m);
    expect(result.stdout).toMatch(/image=new-image candidate_image=new-image command=compose.*candidate-compose\.yml stop cron app$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d db$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d app$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d --no-deps --force-recreate cron$/m);
    expect(result.stdout).not.toMatch(/old-compose\.yml.*up -d cron(?:\s|$)/);
  }, 10_000);

  it("uses refreshed release metadata before pulling during update", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      release_dir="$home/release"
      mkdir -p "$release_dir" "$home/bin"
      cat > "$release_dir/release.json" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
      printf 'services:\\n  app:\\n    image: \${SUBBOOST_IMAGE}\\n' > "$release_dir/docker-compose.image.yml"
      printf '#!/usr/bin/env bash\\necho manager\\n' > "$release_dir/subboost-manager"
      cat > "$home/.env" <<ENV
SUBBOOST_RELEASE_URL=file://$release_dir/release.json
SUBBOOST_IMAGE=old-image
SUBBOOST_CANDIDATE_IMAGE=old-candidate-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      install_secret_file() { cp "$1" "$2"; }
      read_env_file() { cat "$ENV_FILE"; }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        printf 'command=%s\n' "$*" >> "$docker_log"
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *"candidate-compose.yml"*)
              printf 'candidate_image=%s candidate_release_image=%s command=%s\n' "\${SUBBOOST_IMAGE:-}" "\${SUBBOOST_CANDIDATE_IMAGE:-}" "$*" >> "$docker_log"
              ;;
          esac
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull")
              printf 'pull_image=%s\\n' "\${SUBBOOST_IMAGE:-}" >> "$docker_log"
              return 0
              ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      update_cmd
      cat "$docker_log"
      cat "$home/.env"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pull_image=new-image");
    expect(result.stdout).not.toContain("candidate_image=old-image");
    expect(result.stdout).not.toContain("candidate_release_image=old-candidate-image");
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml config$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml config --services$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml pull$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d db$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps --force-recreate app$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps --force-recreate cron$/m);
    expect(result.stdout).toContain("SUBBOOST_IMAGE=new-image");
    expect(result.stdout).toContain("SUBBOOST_CANDIDATE_IMAGE=new-image");
    expect(result.stdout).toContain("SUBBOOST_COMPOSE_URL=file://");
    expect(result.stdout).toContain("SUBBOOST_MANAGER_URL=file://");
    const pullIndex = result.stdout.search(/^command=compose.* pull$/m);
    const pauseIndex = result.stdout.indexOf(" stop cron app");
    const dumpIndex = result.stdout.indexOf("pg_dump -Fc");
    const candidateStartIndex = result.stdout.indexOf("candidate-compose.yml", dumpIndex);
    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(pauseIndex).toBeGreaterThan(pullIndex);
    expect(dumpIndex).toBeGreaterThan(pauseIndex);
    expect(candidateStartIndex).toBeGreaterThan(dumpIndex);
  }, 10_000);

  it("migrates old fixed official update sources to stable latest", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/bin"
      cat > "$home/.env" <<'ENV'
SUBBOOST_RELEASE_URL=https://github.com/Iwithyou2025/subboost/releases/download/v2.4.0/release.json
SUBBOOST_IMAGE=old-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      install_secret_file() { cp "$1" "$2"; }
      read_env_file() { cat "$ENV_FILE"; }
      download_log="$home/download-log"
      : > "$download_log"
      download_to_temp() {
        printf '%s\\n' "$1" >> "$download_log"
        case "$1" in
          *release.json)
            cat > "$2" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
            ;;
          *)
            printf 'asset\\n' > "$2"
            ;;
        esac
      }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull")
              printf 'pull_image=%s\\n' "\${SUBBOOST_IMAGE:-}" >> "$docker_log"
              return 0
              ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      update_cmd
      cat "$download_log"
      cat "$docker_log"
      cat "$home/.env"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Detected old fixed release update source");
    expect(result.stdout).toContain("https://github.com/Iwithyou2025/subboost/releases/latest/download/release.json");
    expect(result.stdout).toContain("pull_image=new-image");
    expect(result.stdout).toContain(
      "SUBBOOST_RELEASE_URL=https://github.com/Iwithyou2025/subboost/releases/latest/download/release.json"
    );
  }, 10_000);

  it("updates exact env keys without removing similarly prefixed names", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      install_secret_file() {
        cp "$1" "$2"
      }
      read_env_file() {
        cat "$ENV_FILE"
      }
      cat > "$ENV_FILE" <<'ENV'
SUBBOOST_PORT_EXTRA=keep
SUBBOOST_PORT=3000
APP_URL=http://old.example
ENV
      write_env_value SUBBOOST_PORT 31000
      cat "$ENV_FILE"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SUBBOOST_PORT_EXTRA=keep");
    expect(result.stdout).toContain("SUBBOOST_PORT=31000");
    expect(result.stdout).not.toContain("SUBBOOST_PORT=3000");
  });

  it("prunes old backups without parsing ls output", () => {
    const script = `
      set -Eeuo pipefail
      base="$(mktemp -d)"
      home="$base/subboost home"
      mkdir -p "$home/backups"
      trap 'rm -rf "$base"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      load_env() { :; }
      compose() {
        case "$*" in
          *"pg_dump -Fc"*) printf 'custom-dump' ;;
          *"pg_restore --list"*) cat >/dev/null ;;
        esac
      }
      cat > "$ENV_FILE" <<'ENV'
POSTGRES_DB=subboost
POSTGRES_USER=subboost
ENV
      for i in $(seq -w 1 12); do
        : > "$BACKUP_DIR/subboost-20240101T0000\${i}Z.dump"
        : > "$BACKUP_DIR/subboost-20240101T0000\${i}Z.env"
      done
      backup_cmd >/dev/null
      sql_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'subboost-*.dump' | wc -l | tr -d '[:space:]')"
      env_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'subboost-*.env' | wc -l | tr -d '[:space:]')"
      unsafe_files="$(find "$BACKUP_DIR" -maxdepth 1 -type f ! -perm 600 | wc -l | tr -d '[:space:]')"
      unsafe_dirs="$(find "$BACKUP_DIR" -maxdepth 0 -type d ! -perm 700 | wc -l | tr -d '[:space:]')"
      printf 'sql=%s env=%s unsafe_files=%s unsafe_dirs=%s\\n' "$sql_count" "$env_count" "$unsafe_files" "$unsafe_dirs"
      [ "$sql_count" = "10" ]
      [ "$env_count" = "10" ]
      ${POSIX_BACKUP_MODE_ASSERTIONS}
      [ ! -e "$BACKUP_DIR/subboost-20240101T000001Z.dump" ]
      [ ! -e "$BACKUP_DIR/subboost-20240101T000001Z.env" ]
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sql=10 env=10");
    if (process.platform !== "win32") {
      expect(result.stdout).toContain("unsafe_files=0 unsafe_dirs=0");
    }
  });

  it("restores a backup while preserving current deployment and session secrets", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/backups"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=current-image
SUBBOOST_CANDIDATE_IMAGE=current-image
SUBBOOST_RELEASE_URL=https://example.test/latest/release.json
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=current-password
DATABASE_URL=postgresql://subboost:current-password@db:5432/subboost?schema=public
ENCRYPTION_KEY=current-encryption-key-123456
JWT_SECRET=current-jwt-secret-123456
CRON_SECRET=current-cron-secret-123456
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      printf 'backup-dump' > "$home/backup.dump"
      cat > "$home/backup.env" <<'ENV'
SUBBOOST_IMAGE=old-image
POSTGRES_PASSWORD=old-password
ENCRYPTION_KEY=backup-encryption-key-123456
JWT_SECRET=old-jwt-secret-123456
CRON_SECRET=old-cron-secret-123456
ENV
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *"pg_dump -Fc"*) printf 'safety-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *"psql -v ON_ERROR_STOP=1"*) printf 'schema-reset\\n' >> "$home/docker-log"; return 0 ;;
            *"pg_restore --clean"*) cat >/dev/null; printf 'restore-clean\\n' >> "$home/docker-log"; return 0 ;;
            *" up -d --no-deps --force-recreate app") printf 'candidate-key=%s\\n' "$ENCRYPTION_KEY" >> "$home/docker-log"; return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
            *) return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      : > "$home/docker-log"
      restore_cmd "$home/backup.dump" "$home/backup.env"
      cat "$home/.env"
      cat "$home/docker-log"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Restore completed successfully.");
    expect(result.stdout).toContain("ENCRYPTION_KEY=backup-encryption-key-123456");
    expect(result.stdout).toContain("SUBBOOST_IMAGE=current-image");
    expect(result.stdout).toContain("POSTGRES_PASSWORD=current-password");
    expect(result.stdout).toContain("JWT_SECRET=current-jwt-secret-123456");
    expect(result.stdout).toContain("CRON_SECRET=current-cron-secret-123456");
    expect(result.stdout).not.toContain("SUBBOOST_IMAGE=old-image");
    expect(result.stdout).toContain("schema-reset");
    expect(result.stdout).toContain("restore-clean");
    expect(result.stdout).toContain("candidate-key=backup-encryption-key-123456");
  });

  it("rolls back the database and environment when a restored app fails health checks", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/backups"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=current-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=current-password
DATABASE_URL=postgresql://subboost:current-password@db:5432/subboost?schema=public
ENCRYPTION_KEY=current-encryption-key-123456
JWT_SECRET=current-jwt-secret-123456
CRON_SECRET=current-cron-secret-123456
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      printf 'backup-dump' > "$home/backup.dump"
      printf 'ENCRYPTION_KEY=backup-encryption-key-123456\\n' > "$home/backup.env"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      printf '0\n' > "$home/restore-count"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *"pg_dump -Fc"*) printf 'safety-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *"pg_restore --clean"*)
              cat >/dev/null
              restore_count="$(cat "$home/restore-count")"
              restore_count=$((restore_count + 1))
              printf '%s\\n' "$restore_count" > "$home/restore-count"
              return 0
              ;;
            *) return 0 ;;
          esac
        fi
        return 0
      }
      printf '0\\n' > "$home/health-count"
      curl() {
        count="$(cat "$home/health-count")"
        count=$((count + 1))
        printf '%s\\n' "$count" > "$home/health-count"
        if [ "$count" -le 1 ]; then return 1; fi
        return 0
      }
      set +e
      output="$(restore_cmd "$home/backup.dump" "$home/backup.env" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\\n%s\\n' "$status" "$output"
      cat "$home/.env"
      cat "$home/restore-count"
      [ "$status" -ne 0 ]
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Restore failed: health check failed");
    expect(result.stdout).toContain("Previous data and environment restored successfully.");
    expect(result.stdout).toContain("ENCRYPTION_KEY=current-encryption-key-123456");
    expect(result.stdout).toMatch(/\n2\n/);
  });

  it("pauses writers before the safety snapshot and resumes services when that snapshot fails", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/backups"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=current-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=current-password
DATABASE_URL=postgresql://subboost:current-password@db:5432/subboost?schema=public
ENCRYPTION_KEY=current-encryption-key-123456
JWT_SECRET=current-jwt-secret-123456
CRON_SECRET=current-cron-secret-123456
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      printf 'backup-dump' > "$home/backup.dump"
      printf 'ENCRYPTION_KEY=backup-encryption-key-123456\\n' > "$home/backup.env"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *" stop cron app") printf 'stop\\n' >> "$home/order"; return 0 ;;
            *"pg_dump -Fc"*) printf 'pgdump\\n' >> "$home/order"; return 1 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d app") printf 'resume-app\\n' >> "$home/order"; return 0 ;;
            *" up -d --no-deps --force-recreate cron") printf 'resume-cron\\n' >> "$home/order"; return 0 ;;
            *) return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      : > "$home/order"
      set +e
      output="$(restore_cmd "$home/backup.dump" "$home/backup.env" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\\n%s\\n' "$status" "$output"
      cat "$home/order"
      [ "$status" -ne 0 ]
      [ "$(sed -n '1p' "$home/order")" = "stop" ]
      [ "$(sed -n '2p' "$home/order")" = "pgdump" ]
      grep -Fxq resume-app "$home/order"
      grep -Fxq resume-cron "$home/order"
      grep -q '^ENCRYPTION_KEY=current-encryption-key-123456$' "$home/.env"
    `;

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Restore aborted because the safety database backup failed.");
    expect(result.stdout).toContain("stop\npgdump\nresume-app\nresume-cron");
  });

  it("rejects unsafe encryption keys from uploaded backup environments", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
ENCRYPTION_KEY=current-encryption-key-123456
ENV
      printf 'ENCRYPTION_KEY=$(touch /tmp/should-not-run)\\n' > "$home/backup.env"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      set +e
      output="$(build_restore_env "$home/backup.env" "$home/candidate.env" 2>&1)"
      status=$?
      set -e
      printf 'status=%s\\n%s\\n' "$status" "$output"
      [ "$status" -ne 0 ]
    `;

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backup ENCRYPTION_KEY contains unsupported characters.");
  });

  it("creates and safely extracts ZIP backup bundles", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      mkdir -p "$home/source" "$home/out"
      printf 'dump' > "$home/source/subboost-test.dump"
      printf 'ENCRYPTION_KEY=backup-encryption-key-123456\\n' > "$home/source/subboost-test.env"
      write_backup_manifest "$home/source/manifest.json" subboost-test.dump subboost-test.env
      create_zip_from_directory "$home/source" "$home/backup.zip" subboost-test.dump subboost-test.env manifest.json
      extract_backup_zip "$home/backup.zip" "$home/out"
      printf 'dump=%s env=%s\\n' "$(basename "$RESTORE_DUMP")" "$(basename "$RESTORE_ENV")"
      [ "$(cat "$RESTORE_DUMP")" = "dump" ]
    `;

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dump=subboost-test.dump env=subboost-test.env");
  });

  it("uses a readable date and time for default ZIP backup filenames", () => {
    const result = runBash(`
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/backups"
      printf 'DUMMY=value\\n' > "$home/.env"
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      TMP_DIR="$home/tmp"
      backup_filename_stamp() { printf '2026-09-16-11-27-57\\n'; }
      create_backup_pair() {
        BACKUP_DB_OUT="$home/backups/database.dump"
        BACKUP_ENV_OUT="$home/backups/subboost.env"
        printf 'dump' > "$BACKUP_DB_OUT"
        printf 'env' > "$BACKUP_ENV_OUT"
      }
      prune_backups() { :; }
      create_zip_from_directory() { printf 'zip' > "$2"; }

      backup_zip_cmd
      [ -f "$home/backups/subboost-backup-2026-09-16-11-27-57.zip" ]
    `);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("subboost-backup-2026-09-16-11-27-57.zip");
  });

  it("processes web export and restore jobs without accepting arbitrary paths", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      TMP_DIR="$home/agent-tmp"
      data="$home/manager-data"
      mkdir -p "$data/jobs" "$data/uploads" "$data/exports" "$data/status"
      id=123e4567-e89b-12d3-a456-426614174000
      backup_zip_cmd() { printf 'zip' > "$1"; }
      backup_filename_stamp() { printf '2026-09-16-11-27-57\\n'; }
      restore_cmd() { printf '%s %s\\n' "$*" > "$home/restore-args"; return 0; }
      migrate_cmd() { printf '%s\\n' "$*" > "$home/migrate-args"; return 0; }

      printf '{"id":"%s","action":"export"}\\n' "$id" > "$home/export.json"
      process_manager_job "$data" "$home/export.json"
      cat "$data/status/$id.json"
      [ -f "$data/exports/subboost-backup-2026-09-16-11-27-57.zip" ]
      grep -Fq '"outputFile":"subboost-backup-2026-09-16-11-27-57.zip"' "$data/status/$id.json"
      [ ! -e "$TMP_DIR/job-$id" ]

      printf 'dump' > "$data/uploads/$id.dump"
      printf 'env' > "$data/uploads/$id.env"
      printf '{"id":"%s","action":"restore","inputDump":"%s.dump","inputEnv":"%s.env"}\\n' "$id" "$id" "$id" > "$home/restore.json"
      process_manager_job "$data" "$home/restore.json"
      cat "$data/status/$id.json"
      cat "$home/restore-args"
      [ ! -e "$data/uploads/$id.dump" ]
      [ ! -e "$data/uploads/$id.env" ]
      [ ! -e "$TMP_DIR/job-$id" ]

      printf 'zip' > "$data/uploads/$id.zip"
      printf '{"id":"%s","action":"migrate","inputZip":"%s.zip"}\\n' "$id" "$id" > "$home/migrate.json"
      process_manager_job "$data" "$home/migrate.json"
      cat "$data/status/$id.json"
      cat "$home/migrate-args"
      [ ! -e "$data/uploads/$id.zip" ]
      [ ! -e "$TMP_DIR/job-$id" ]

      printf '{"id":"%s","action":"restore","inputZip":"../bad.zip"}\\n' "$id" > "$home/bad.json"
      set +e
      process_manager_job "$data" "$home/bad.json"
      bad_status=$?
      set -e
      cat "$data/status/$id.json"
      [ "$bad_status" -ne 0 ]
    `;

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"state":"succeeded"');
    expect(result.stdout).toContain("/uploads/123e4567-e89b-12d3-a456-426614174000.dump");
    expect(result.stdout).toContain("/uploads/123e4567-e89b-12d3-a456-426614174000.zip");
    expect(result.stdout).toContain("完整迁移成功");
    expect(result.stdout).toContain('"state":"failed"');
    expect(result.stdout).toContain("备份文件名无效");
  });

  it("installs a restricted systemd backup manager agent service", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/bin" "$home/systemd"
      cp local/scripts/subboost.sh "$home/bin/subboost"
      chmod +x "$home/bin/subboost"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_SYSTEMD_UNIT_DIR="$home/systemd"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      systemctl() { printf 'systemctl=%s\\n' "$*" >> "$home/systemctl.log"; }
      : > "$home/systemctl.log"
      agent_install_cmd
      cat "$home/systemctl.log"
      cat "$home/systemd/subboost-manager-agent.service"
    `;

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("systemctl=daemon-reload");
    expect(result.stdout).toContain("systemctl=enable subboost-manager-agent.service");
    expect(result.stdout).toContain("systemctl=restart subboost-manager-agent.service");
    expect(result.stdout).toContain("ExecStart=\"");
    expect(result.stdout).toContain(" agent");
  });

});
