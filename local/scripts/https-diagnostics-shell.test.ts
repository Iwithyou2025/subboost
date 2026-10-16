import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cwd = path.resolve(__dirname, "../..");
function run(body: string, manager = false) {
  return spawnSync("bash", ["-s"], {
    cwd, encoding: "utf8", timeout: 30_000,
    input: `set -Eeuo pipefail
export SUBBOOST_SCRIPT_SOURCE_ONLY=1 SUBBOOST_ASSUME_YES=1
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export SUBBOOST_HOME="$work/home"
mkdir -p "$SUBBOOST_HOME"
source local/scripts/${manager ? "subboost" : "install"}.sh
TMP_DIR="$work/tmp"
mkdir -p "$TMP_DIR"
${body}`,
  });
}

describe("HTTPS failure diagnostics", () => {
  it("prints rate limit reason and Beijing retry time", () => {
    const r = run(`
compose() { printf '%s\\n' '{"level":"error","error":"HTTP 429 rateLimited - retry after 2026-10-17 03:04:21 UTC"}'; }
https_failure_details 2026-10-16T00:00:00Z rate
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("2026-10-17 11:04:21");
    expect(r.stderr).toContain("HTTP 429");
  });
  it("shows connection failure and Caddy logs on timeout", () => {
    const r = run(`
compose() { echo 'ACME connection refused'; }
printf 'curl: TLS handshake failed' > "$TMP_DIR/https-curl.err"
https_failure_details 2026-10-16T00:00:00Z timeout
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("TLS handshake failed");
    expect(r.stderr).toContain("ACME connection refused");
  });
  it("does not mistake staging or ordinary log errors for a production rate limit", () => {
    const r = run(`
compose() { printf '%s\\n' '{"level":"error","error":"acme-staging rateLimited"}'; }
if https_failure_details 2026-10-16T00:00:00Z rate; then exit 10; fi
`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });
});
