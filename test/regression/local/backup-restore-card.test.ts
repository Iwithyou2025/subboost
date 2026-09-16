import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  effects: [] as React.EffectCallback[],
  overrides: {} as Record<number, unknown>,
  ref: { current: { click: vi.fn(), value: "selected" } } as { current: { click: ReturnType<typeof vi.fn>; value: string } | null },
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: React.EffectCallback) => {
      harness.effects.push(effect);
    },
    useRef: () => harness.ref,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++;
      const value = Object.prototype.hasOwnProperty.call(harness.overrides, index) ? harness.overrides[index] : initial;
      const setter = vi.fn();
      harness.setters[index] = setter;
      return [value, setter];
    },
  };
});

vi.mock("lucide-react", () => ({
  ArchiveRestore: "i",
  Download: "i",
  LoaderCircle: "i",
  Upload: "i",
}));

vi.mock("@subboost/ui/components/ui/button", () => ({ Button: "button" }));
vi.mock("@subboost/ui/components/ui/card", () => ({
  Card: "section",
  CardContent: "div",
  CardHeader: "header",
  CardTitle: "h2",
}));

import { BackupRestoreCard } from "../../../local/src/components/backup-restore-card";

type ElementLike = React.ReactElement<Record<string, any>>;

function renderCard(overrides: Record<number, unknown> = {}, enabled = true) {
  harness.effects = [];
  harness.overrides = overrides;
  harness.setters = [];
  harness.stateIndex = 0;
  harness.ref = { current: { click: vi.fn(), value: "selected" } };
  const tree = BackupRestoreCard({ enabled }) as ElementLike;
  return { tree, effects: [...harness.effects], setters: [...harness.setters], ref: harness.ref };
}

function elements(root: React.ReactNode): ElementLike[] {
  const result: ElementLike[] = [];
  const visit = (value: React.ReactNode) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!React.isValidElement(value)) return;
    const element = value as ElementLike;
    result.push(element);
    visit(element.props.children);
  };
  visit(root);
  return result;
}

function textOf(value: React.ReactNode): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (React.isValidElement(value)) return textOf((value as ElementLike).props.children);
  return "";
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: vi.fn(async () => body) } as unknown as Response;
}

describe("BackupRestoreCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("window", {
      confirm: vi.fn(() => true),
      location: { href: "" },
    });
  });

  it("renders disabled controls and skips agent lookup when no admin is available", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard({}, false);
    const buttons = elements(view.tree).filter((element) => element.type === "button");
    expect(textOf(view.tree)).toContain("备份与恢复");
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.props.disabled)).toBe(true);
    const cleanup = view.effects[0]();
    expect(view.setters[0]).toHaveBeenCalledWith(null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(typeof cleanup).toBe("function");
    cleanup?.();
  });

  it.each([
    ["available", jsonResponse({ available: true }), true],
    ["unavailable", jsonResponse({ available: false }), false],
    ["invalid", jsonResponse({ available: "yes" }), false],
    ["failed", jsonResponse({}, false), false],
  ])("loads agent status for %s responses", async (_label, response, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const view = renderCard();
    const cleanup = view.effects[0]();
    await flush();
    expect(view.setters[0]).toHaveBeenLastCalledWith(expected);
    cleanup?.();
  });

  it("handles rejected agent status requests and ignores results after cleanup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    let view = renderCard();
    view.effects[0]();
    await flush();
    expect(view.setters[0]).toHaveBeenCalledWith(false);

    let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    view = renderCard();
    const cleanup = view.effects[0]();
    cleanup?.();
    resolve(jsonResponse({ available: true }));
    await flush();
    expect(view.setters[0]).not.toHaveBeenCalled();
  });

  it("queues export jobs and reports export request failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: "job-1" }))
      .mockResolvedValueOnce(jsonResponse({ error: "export failed" }, false));
    vi.stubGlobal("fetch", fetchMock);
    let view = renderCard({ 0: true });
    const exportButton = elements(view.tree).find((element) => element.type === "button" && textOf(element).includes("导出 ZIP"));
    await exportButton?.props.onClick();
    await flush();
    expect(view.setters[2]).toHaveBeenCalledWith("export");
    expect(view.setters[1]).toHaveBeenCalledWith("job-1");

    view = renderCard({ 0: true });
    const failedButton = elements(view.tree).find((element) => element.type === "button" && textOf(element).includes("导出 ZIP"));
    await failedButton?.props.onClick();
    await flush();
    expect(view.setters[2]).toHaveBeenLastCalledWith(null);
    expect(view.setters[3]).toHaveBeenCalledWith("export failed");
  });

  it("opens the file picker and uploads a confirmed ZIP restore", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobId: "restore-job" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard({ 0: true });
    const nodes = elements(view.tree);
    const restoreButton = nodes.find((element) => element.type === "button" && textOf(element).includes("选择备份"));
    restoreButton?.props.onClick();
    expect(view.ref.current?.click).toHaveBeenCalledTimes(1);

    const input = nodes.find((element) => element.type === "input");
    const file = new File(["zip"], "backup.zip");
    await input?.props.onChange({ currentTarget: { files: [file] } });
    await flush();
    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/backups/restore", expect.objectContaining({ method: "POST" }));
    expect(view.setters[1]).toHaveBeenCalledWith("restore-job");
    expect(view.setters[3]).toHaveBeenCalledWith(expect.stringContaining("恢复任务已开始"));
    expect(view.ref.current?.value).toBe("");
  });

  it("does not upload empty or cancelled restore selections and reports upload failures", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad restore" }, false));
    vi.stubGlobal("fetch", fetchMock);
    let view = renderCard({ 0: true });
    let input = elements(view.tree).find((element) => element.type === "input");
    await input?.props.onChange({ currentTarget: { files: [] } });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await input?.props.onChange({ currentTarget: { files: [new File(["zip"], "backup.zip")] } });
    expect(fetchMock).not.toHaveBeenCalled();

    view = renderCard({ 0: true });
    input = elements(view.tree).find((element) => element.type === "input");
    await input?.props.onChange({ currentTarget: { files: [new File(["zip"], "backup.zip")] } });
    await flush();
    expect(view.setters[2]).toHaveBeenLastCalledWith(null);
    expect(view.setters[3]).toHaveBeenCalledWith("bad restore");
  });

  it("uploads full migrations as a distinct confirmed mode", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobId: "migration-job" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderCard({ 0: true });
    const nodes = elements(view.tree);
    const migrateButton = nodes.find((element) => element.type === "button" && textOf(element).includes("选择完整备份"));
    migrateButton?.props.onClick();
    expect(view.ref.current?.click).toHaveBeenCalled();

    const inputs = nodes.filter((element) => element.type === "input");
    const migrationInput = inputs.find((element) => element.props.accept === ".zip");
    await migrationInput?.props.onChange({ currentTarget: { files: [new File(["zip"], "complete.zip")] } });
    await flush();

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("替换当前数据库、密钥、端口、访问地址及全部配置"));
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/backups/restore")?.[1] as RequestInit;
    expect((request.body as FormData).get("mode")).toBe("full");
    expect(view.setters[2]).toHaveBeenCalledWith("migrate");
    expect(view.setters[1]).toHaveBeenCalledWith("migration-job");
    expect(view.setters[3]).toHaveBeenCalledWith(expect.stringContaining("APP_URL"));
  });

  it("polls failed, completed export, and completed restore jobs", async () => {
    const setTimeoutMock = vi.fn(() => 11 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutMock = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutMock);
    vi.stubGlobal("clearTimeout", clearTimeoutMock);

    let fetchMock = vi.fn(async () => jsonResponse({ id: "job", action: "restore", state: "failed", message: "restore failed" }));
    vi.stubGlobal("fetch", fetchMock);
    let view = renderCard({ 0: true, 1: "job", 2: "restore" });
    const cleanupFailed = view.effects[1]();
    await flush();
    expect(view.setters[3]).toHaveBeenCalledWith("restore failed");
    expect(view.setters[1]).toHaveBeenCalledWith(null);
    cleanupFailed?.();

    fetchMock = vi.fn(async () => jsonResponse({ id: "job", action: "export", state: "succeeded", downloadUrl: "/download/job" }));
    vi.stubGlobal("fetch", fetchMock);
    view = renderCard({ 0: true, 1: "job", 2: "export" });
    view.effects[1]();
    await flush();
    expect(window.location.href).toBe("/download/job");
    expect(view.setters[3]).toHaveBeenCalledWith("备份已生成，正在下载。");

    fetchMock = vi.fn(async () => jsonResponse({ id: "job", action: "restore", state: "succeeded" }));
    vi.stubGlobal("fetch", fetchMock);
    view = renderCard({ 0: true, 1: "job", 2: "restore" });
    view.effects[1]();
    await flush();
    expect(view.setters[3]).toHaveBeenCalledWith("恢复成功，SubBoost 已重新启动。");

    fetchMock = vi.fn(async () => jsonResponse({ id: "job", action: "migrate", state: "succeeded" }));
    vi.stubGlobal("fetch", fetchMock);
    view = renderCard({ 0: true, 1: "job", 2: "migrate" });
    view.effects[1]();
    await flush();
    expect(view.setters[3]).toHaveBeenCalledWith("完整迁移成功，请使用来源环境的访问地址和管理员账号登录。");
  });

  it("keeps polling through non-success responses and temporary disconnects", async () => {
    const setTimeoutMock = vi.fn(() => 12 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutMock = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutMock);
    vi.stubGlobal("clearTimeout", clearTimeoutMock);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false)));
    let view = renderCard({ 0: true, 1: "job", 2: "restore" });
    const cleanup = view.effects[1]();
    await flush();
    expect(setTimeoutMock).toHaveBeenCalled();
    cleanup?.();
    expect(clearTimeoutMock).toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("restarting"); }));
    view = renderCard({ 0: true, 1: "job", 2: "restore" });
    view.effects[1]();
    await flush();
    expect(setTimeoutMock).toHaveBeenCalled();
  });

  it("shows unavailable, loading, busy, and informational states", () => {
    expect(textOf(renderCard({ 0: null }).tree)).toContain("正在检查备份管理服务");
    expect(textOf(renderCard({ 0: false }).tree)).toContain("sudo subboost agent-install");
    const busy = renderCard({ 0: true, 1: "job", 2: "export", 3: "working" });
    const buttons = elements(busy.tree).filter((element) => element.type === "button");
    expect(buttons.every((button) => button.props.disabled)).toBe(true);
    expect(textOf(busy.tree)).toContain("working");
  });
});
