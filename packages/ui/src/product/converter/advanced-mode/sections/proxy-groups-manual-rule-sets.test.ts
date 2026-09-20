import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManualRuleSet, type ManualRuleSetInput } from "@subboost/core/rules/manual-rule-set";

const mocks = vi.hoisted(() => ({ store: {} as any, inputs: [] as any[], selects: [] as any[], buttons: [] as any[], toast: vi.fn() }));
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values[index] = initial;
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
}));
vi.mock("@subboost/ui/store/config-store", () => ({ useConfigStore: () => mocks.store }));
vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: any) => { mocks.inputs.push(props); return React.createElement("input", props); },
}));
vi.mock("@subboost/ui/components/ui/icon-button", () => ({
  IconButton: (props: any) => { mocks.buttons.push(props); return React.createElement("button", { ...props, "aria-label": props.label }, props.children); },
}));
vi.mock("@subboost/ui/components/ui/select", () => ({
  Select: (props: any) => { mocks.selects.push(props); return React.createElement("div", null, props.children); },
  SelectTrigger: (props: any) => React.createElement("div", props, props.children),
  SelectContent: (props: any) => React.createElement("div", null, props.children),
  SelectItem: (props: any) => React.createElement("span", { "data-value": props.value }, props.children),
  SelectValue: (props: any) => React.createElement("span", null, props.placeholder),
}));
vi.mock("./proxy-groups-rules-library", () => ({ ProxyGroupsRulesLibrary: () => React.createElement("div", null, "方法一：搜索规则集") }));
vi.mock("./proxy-groups-custom-rules", () => ({ ProxyGroupsCustomRules: () => React.createElement("div", null, "方法二：手动添加规则") }));

import { ProxyGroupsManualRuleSets } from "./proxy-groups-manual-rule-sets";
import { ProxyGroupsCustomRoutingRules } from "./proxy-groups-custom-routing-rules";

function render(component = ProxyGroupsManualRuleSets) {
  hooks.cursor = 0;
  mocks.inputs = [];
  mocks.selects = [];
  mocks.buttons = [];
  return renderToStaticMarkup(React.createElement(component));
}
function fill() {
  render();
  mocks.inputs[0].onChange({ target: { value: "Finance" } });
  mocks.inputs[1].onChange({ target: { value: "https://rules.example/finance.yml?token=1" } });
  mocks.selects[2].onValueChange("module:select");
  render();
  mocks.selects[1].onValueChange("classical");
  render();
}

describe("ProxyGroupsManualRuleSets", () => {
  beforeEach(() => {
    hooks.values = [];
    vi.clearAllMocks();
    mocks.store = {
      hiddenProxyGroups: [], customProxyGroups: [], customRuleSets: [], proxyGroupNameOverrides: {},
      importManualRuleSet: vi.fn((input: ManualRuleSetInput) => {
        const rule = createManualRuleSet(input, new Set());
        mocks.store.customRuleSets.push(rule);
        return { ok: true, id: rule.id };
      }),
    };
  });

  it("appends method three after methods one and two with an accessible check button", () => {
    const html = render(ProxyGroupsCustomRoutingRules);
    expect(html.indexOf("方法一")).toBeLessThan(html.indexOf("方法二"));
    expect(html.indexOf("方法二")).toBeLessThan(html.indexOf("方法三：手动添加规则集"));
    expect(html).toContain('aria-label="导入此源"');
    expect(mocks.buttons[0].disabled).toBe(true);
    expect(mocks.inputs[1].className).toContain("h-7 border-white/10 bg-white/5");
    expect(html).not.toContain('data-value="classical"');
  });

  it("imports YAML, shows green success, and clears that status after editing/deletion", () => {
    fill();
    expect(mocks.selects[0].value).toBe("yaml");
    expect(mocks.buttons[0].disabled).toBe(false);
    mocks.buttons[0].onClick();
    expect(mocks.store.importManualRuleSet).toHaveBeenCalledWith({ name: "Finance", url: "https://rules.example/finance.yml?token=1", format: "yaml", behavior: "classical", target: { kind: "module", id: "select" } });
    render();
    expect(mocks.buttons[0].className).toContain("text-green-400");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "已添加规则集" }));
    mocks.inputs[0].onChange({ target: { value: "Changed" } });
    render();
    expect(mocks.buttons[0].className).not.toContain("text-green-400");
    mocks.inputs[0].onChange({ target: { value: "Finance" } });
    mocks.store.customRuleSets = [];
    render();
    expect(mocks.buttons[0].className).not.toContain("text-green-400");
  });

  it("resets classical when switching to MRS and never fetches or parses remote nodes", () => {
    fill();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.inputs[1].onChange({ target: { value: "https://rules.example/domain.mrs" } });
    const html = render();
    expect(mocks.selects[0].value).toBe("mrs");
    expect(mocks.selects[1].value).toBe("domain");
    expect(html).not.toContain('data-value="classical"');
    mocks.buttons[0].onClick();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders validation errors and does not claim success for duplicates", () => {
    fill();
    mocks.store.importManualRuleSet.mockReturnValue({ ok: false, error: "此规则集 URL 已存在" });
    mocks.buttons[0].onClick();
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("此规则集 URL 已存在");
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.buttons[0].className).not.toContain("text-green-400");
  });

  it("disables import when a selected group is hidden/deleted and supports Enter", () => {
    fill();
    mocks.store.hiddenProxyGroups = ["select"];
    render();
    expect(mocks.buttons[0].disabled).toBe(true);
    mocks.buttons[0].onClick();
    expect(mocks.store.importManualRuleSet).not.toHaveBeenCalled();
    mocks.store.hiddenProxyGroups = [];
    render();
    const preventDefault = vi.fn();
    mocks.inputs[1].onKeyDown({ key: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(mocks.store.importManualRuleSet).toHaveBeenCalledTimes(1);
  });
});
