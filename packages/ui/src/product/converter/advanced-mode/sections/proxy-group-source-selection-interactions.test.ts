import * as React from "react";
import { expect, it, vi } from "vitest";
import { withNodeSourceId } from "@subboost/core/subscription/node-source-state";
import type { ParsedNode } from "@subboost/core/types/node";

const mocks = vi.hoisted(() => ({
  draggingKey: null as string | null,
  formFields: [] as any[],
  generatedProxyGroups: [] as Array<{ name: string; proxies: string[] }>,
  stateSetters: [] as Array<ReturnType<typeof vi.fn>>,
  store: {} as Record<string, any>,
  toast: vi.fn(),
  confirmDialog: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const value = initial === null ? mocks.draggingKey : initial;
      const setter = vi.fn();
      mocks.stateSetters.push(setter);
      return [value, setter];
    },
  };
});

vi.mock("lucide-react", () => ({
  QrCode: () => null,
  Plus: () => React.createElement("span", null, "plus-icon"),
  RotateCcw: () => React.createElement("span", null, "restore-icon"),
  X: () => React.createElement("span", null, "x-icon"),
}));

vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({
  confirmDialog: mocks.confirmDialog,
}));

vi.mock("@subboost/ui/components/ui/badge", () => ({
  Badge: (props: any) => React.createElement("span", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: any) => React.createElement("button", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/form-field", () => ({
  FormField: (props: any) => {
    mocks.formFields.push(props);
    return React.createElement("div", null, props.children);
  },
}));

vi.mock("@subboost/ui/components/ui/choice-group", () => ({
  ChoiceGroup: (props: any) => React.createElement("div", null, props.children),
  ChoiceChip: ({ label, selected, ...props }: any) => React.createElement("button", { ...props, "aria-pressed": selected }, label),
}));

vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: any) => React.createElement("input", props),
}));

vi.mock("@subboost/ui/components/ui/toaster", () => ({
  toast: mocks.toast,
}));

vi.mock("@subboost/ui/lib/utils", () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
}));

vi.mock("@subboost/ui/store/config-store", () => ({
  useConfigStore: () => mocks.store,
}));

import { ProxyGroupAdvancedPanel } from "./proxy-group-advanced-panel";

function node(name: string): ParsedNode {
  return {
    name,
    type: "ss",
    server: `${name.toLowerCase().replace(/\s+/g, "-")}.example.com`,
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
  } as ParsedNode;
}

type TestElement = React.ReactElement<Record<string, any>>;

function flattenElements(value: React.ReactNode): TestElement[] {
  const out: TestElement[] = [];
  const visit = (item: React.ReactNode): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!React.isValidElement(item)) return;
    if (typeof item.type === "function") {
      visit((item.type as (props: unknown) => React.ReactNode)(item.props));
      return;
    }
    out.push(item as TestElement);
    visit((item.props as { children?: React.ReactNode }).children);
  };
  visit(value);
  return out;
}

import { initialState } from "@subboost/ui/store/config-store/definitions";
import { normalizeProxyGroupAdvancedConfig } from "@subboost/core/proxy-group-advanced";
import { generateProxyGroups } from "@subboost/core/generator/proxy-groups";

function reset(sourceIds: string[] = []) {
  mocks.store = {
    ...structuredClone(initialState),
    nodes: [withNodeSourceId(node("Node A"), "s1"), withNodeSourceId(node("Node B"), "s2")],
    sources: [{ id: "s1", type: "url" }, { id: "s2", type: "url" }],
    enabledProxyGroups: ["select", "auto", "youtube"],
    proxyGroupAdvanced: { youtube: { sourceIds, excludedMembers: [{ kind: "module", id: "select" }, { kind: "module", id: "auto" }] } },
  };
}
function render() {
  return flattenElements(ProxyGroupAdvancedPanel({
    target: { kind: "module", id: "youtube", name: "📹 油管视频" },
    advanced: mocks.store.proxyGroupAdvanced.youtube,
    onChange: (patch) => {
      mocks.store.proxyGroupAdvanced = { ...mocks.store.proxyGroupAdvanced,
        youtube: normalizeProxyGroupAdvancedConfig({ ...mocks.store.proxyGroupAdvanced.youtube, ...patch }) };
    }, rulesCount: 0, rulesContent: null,
  }));
}
function click(title: string) {
  const button = render().find(e => e.type === "button" && e.props.title === title);
  expect(button, title).toBeDefined();
  expect(button!.props.disabled, title).not.toBe(true);
  button!.props.onClick();
}
function toggle(index: number) {
  render().filter(e => e.type === "input" && e.props.type === "checkbox")[index].props.onChange();
}
function names() {
  return generateProxyGroups({ ...mocks.store, enabledModules: mocks.store.enabledProxyGroups })
    .find(g => g.name === "📹 油管视频")!.proxies!;
}
function selectedNodes() { return names().filter(n => n === "Node A" || n === "Node B"); }

it("runs the six reported interactions through actual UI callbacks and real generator", () => {
  reset();
  toggle(0); expect(selectedNodes()).toEqual(["Node A"]);
  toggle(0); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  click("移除全部节点"); expect(selectedNodes()).toEqual([]);
  click("添加全部节点"); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  click("移除全部节点"); click("Node B"); expect(selectedNodes()).toEqual(["Node B"]);
  click("添加全部代理组"); expect(names()).toContain("🚀 节点选择");
  click("移除全部代理组"); expect(names()).not.toContain("🚀 节点选择");
});
it.each(["toggle", "bulk", "single"])("recovers stale source selection through %s", (operation) => {
  reset(["deleted-source"]);
  const checkboxes = render().filter(e => e.type === "input" && e.props.type === "checkbox");
  expect(checkboxes).toHaveLength(3);
  expect(checkboxes[2].props.checked).toBe(true);
  if (operation === "toggle") {
    toggle(0); expect(selectedNodes()).toEqual(["Node A"]);
    toggle(0); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  } else if (operation === "bulk") {
    click("添加全部节点"); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  } else {
    click("Node A"); expect(selectedNodes()).toContain("Node A");
  }
  expect(mocks.store.proxyGroupAdvanced.youtube.sourceIds).toBeUndefined();
  click("移除全部节点"); expect(selectedNodes()).toEqual([]);
  click("Node B"); expect(selectedNodes()).toEqual(["Node B"]);
  click("添加全部节点"); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  toggle(0); expect(selectedNodes()).toEqual(["Node A"]);
  toggle(0); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
  click("添加全部代理组"); expect(names()).toContain("🚀 节点选择");
  click("移除全部代理组"); expect(names()).not.toContain("🚀 节点选择");
});
it("keeps an existing source with no nodes visible and selected", () => {
  reset(["empty"]);
  mocks.store.sources.push({ id: "empty", type: "url" });
  const boxes = render().filter(e => e.type === "input" && e.props.type === "checkbox");
  expect(boxes).toHaveLength(3);
  expect(boxes[2].props.checked).toBe(true);
  click("添加全部节点"); expect(selectedNodes()).toEqual([]);
  expect(mocks.store.proxyGroupAdvanced.youtube.sourceIds).toEqual(["empty"]);
  toggle(2); expect(selectedNodes()).toEqual(["Node A", "Node B"]);
});

function setRegex(kind: "include" | "exclude", value: string) {
  const placeholder = kind === "include" ? "例如: IEPL|专线|家宽" : "例如: 测试|过期";
  const input = render().find(e => e.type === "input" && e.props.placeholder === placeholder);
  expect(input).toBeDefined();
  input!.props.onChange({ target: { value } });
}

it("combines regex, source selection and manual node actions", () => {
  reset();
  click("移除全部节点"); click("添加全部节点");
  setRegex("include", "Node A"); expect(selectedNodes()).toEqual(["Node A"]);
  click("Node B"); expect(selectedNodes()).toEqual(["Node A"]);
  setRegex("include", ""); expect(selectedNodes().sort()).toEqual(["Node A", "Node B"]);
  setRegex("exclude", "Node A"); expect(selectedNodes()).toEqual(["Node B"]);
  click("添加全部节点"); expect(selectedNodes()).toEqual(["Node B"]);
  setRegex("include", "Node A"); expect(selectedNodes()).toEqual([]);
  setRegex("exclude", ""); expect(selectedNodes()).toEqual(["Node A"]);
  setRegex("include", ""); expect(selectedNodes().sort()).toEqual(["Node A", "Node B"]);
  click("移除全部节点"); click("Node A");
  setRegex("exclude", "Node A"); expect(selectedNodes()).toEqual([]);
  setRegex("exclude", ""); expect(selectedNodes()).toEqual(["Node A"]);
  click("添加全部节点");
  toggle(0); setRegex("exclude", "Node A"); expect(selectedNodes()).toEqual([]);
  setRegex("exclude", ""); expect(selectedNodes()).toEqual(["Node A"]);
  toggle(0); expect(selectedNodes().sort()).toEqual(["Node A", "Node B"]);
  setRegex("include", "["); setRegex("exclude", "[");
  expect(selectedNodes().sort()).toEqual(["Node A", "Node B"]);
  setRegex("include", ""); setRegex("exclude", "");
  click("添加全部代理组"); setRegex("include", "no-node-matches");
  expect(selectedNodes()).toEqual([]);
  expect(names()).toContain("🚀 节点选择"); expect(names()).toContain("DIRECT"); expect(names()).toContain("REJECT");
  click("移除全部代理组"); expect(names()).not.toContain("🚀 节点选择");
});

it("filters manually added nodes by region and restores on clear", () => {
  reset();
  mocks.store.nodes = [withNodeSourceId(node("US Node"), "s1"), withNodeSourceId(node("SG Node"), "s2")];
  click("移除全部节点"); click("添加全部节点");
  const region = () => render().find(e => e.type === "button" && e.props.children === "🇺🇸 美国")!;
  region().props.onClick();
  expect(names()).toContain("US Node"); expect(names()).not.toContain("SG Node");
  region().props.onClick();
  expect(names()).toContain("US Node"); expect(names()).toContain("SG Node");
});
