import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("update image selection", () => {
  it.each([
    ["cached", "app"],
    ["missing", "app cron"],
    ["changed", "app db"],
    ["new-service", "app caddy"],
    ["offline", "app"],
  ])("selects images before maintenance: %s", (scenario, expected) => {
    const result = spawnSync("bash", ["-s"], {
      cwd: path.resolve(__dirname, "../.."), encoding: "utf8",
      env: { ...process.env, SUBBOOST_SCRIPT_SOURCE_ONLY: "1", SCENARIO: scenario },
      input: `
set -Eeuo pipefail
source local/scripts/subboost.sh
compose_files() {
  local env_file="$1"; shift 2
  case "$*" in
    "config --services")
      printf 'app\\ndb\\ncron\\n'
      if [ "$SCENARIO" != new-service ] || [ "$env_file" = candidate ]; then printf 'caddy\\n'; fi ;;
    "config --images "*)
      if [ "$SCENARIO" = changed ] && [ "$env_file" = candidate ] && [ "$3" = db ]; then
        echo postgres:17
      else echo "$3:cached"; fi ;;
    "pull "*)
      shift; echo "SELECTED=$*"
      [ "$SCENARIO" != offline ] ;;
    *) exit 91 ;;
  esac
}
docker_cmd() {
  [ "$1 $2" = 'image inspect' ] || exit 92
  [ "$SCENARIO" != missing ] || [ "$3" != cron:cached ]
}
pull_update_images new-app candidate compose old compose
`,
    });
    expect(result.status, result.stderr).toBe(scenario === "offline" ? 1 : 0);
    expect(result.stdout).toContain(`SELECTED=${expected}\n`);
  });
});
