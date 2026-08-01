import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireCjs = createRequire(import.meta.url);
const scriptPath = requireCjs.resolve("../../../scripts/check-ui-consistency.cjs");
const originalArgv = process.argv;
const originalCwd = process.cwd();
const originalExit = process.exit;
let tempRoot = "";

function writeSource(filePath: string, content: string): string {
  const absolute = join(tempRoot, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

function runCheck(args: string[] = []): void {
  process.argv = [process.execPath, scriptPath, ...args];
  delete (requireCjs as any).cache[scriptPath];
  requireCjs(scriptPath);
}

describe("public UI consistency checker", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "subboost-public-ui-check-"));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    delete (requireCjs as any).cache[scriptPath];
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("scans default roots while honoring wrapper and ignored-file exceptions", () => {
    writeSource(
      "packages/components/good.tsx",
      `export function Good() { return <><IconButton label="Add" /><Switch aria-label="Toggle" /></>; }`,
    );
    writeSource(
      "packages/components/ui/icon-button.tsx",
      `export function IconButton() { return <Button size="icon" />; }`,
    );
    writeSource(
      "packages/components/ui/switch-field.tsx",
      `export function SwitchField() { return <Switch />; }`,
    );
    writeSource(
      "packages/components/ui/radix-wrapper.tsx",
      `import * as Dialog from "@radix-ui/react-dialog"; export const Root = Dialog.Root;`,
    );
    writeSource("packages/components/ignored.test.tsx", `export const Ignored = () => <IconButton />;`);
    writeSource("packages/__tests__/ignored.tsx", `export const Ignored = () => <Switch />;`);
    writeSource("packages/node_modules/pkg/ignored.tsx", `export const Ignored = () => <Switch />;`);
    writeSource("local/components/good.tsx", `export const LocalGood = () => <a href="/">text</a>;`);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runCheck();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^UI consistency check passed \(4 source files scanned\)\.$/));
  });

  it("reports every guarded UI anti-pattern from a directly requested file", () => {
    const badFile = writeSource(
      "bad.tsx",
      [
        `import * as Popover from "@radix-ui/react-popover";`,
        `export function Bad() {`,
        `  return <>`,
        `    <Link><Button>nested</Button></Link>`,
        `    <a><button>nested</button></a>`,
        `    <Button size="icon" />`,
        `    <IconButton />`,
        `    <Switch />`,
        `    <Popover.Root />`,
        `  </>;`,
        `}`,
      ].join("\n"),
    );
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    process.exit = vi.fn((code?: string | number | null) => {
      throw new Error("exit:" + code);
    }) as never;

    expect(() => runCheck([badFile])).toThrow("exit:1");
    expect(errors.join("\n")).toContain("业务代码不得直接导入 @radix-ui/react-popover");
    expect(errors.join("\n")).toContain("Link 内不得嵌套 Button/button");
    expect(errors.join("\n")).toContain("a 内不得嵌套 Button/button");
    expect(errors.join("\n")).toContain('业务代码不得直接使用 Button size="icon"');
    expect(errors.join("\n")).toContain("IconButton 必须提供 label");
    expect(errors.join("\n")).toContain("裸 Switch 必须提供 aria-label 或 aria-labelledby");
    expect(errors.at(-1)).toContain("UI consistency check failed with 6 finding(s).");
  });

  it("accepts an explicit missing root as an empty scoped check", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runCheck([join(tempRoot, "missing")]);
    expect(log).toHaveBeenCalledWith("UI consistency check passed (0 source files scanned).");
  });
});
