import { describe, expect, it } from "vitest";
import { resolveProxyGroupMembers } from "../../../packages/core/src/proxy-group-advanced";
import { withNodeSourceId } from "../../../packages/core/src/subscription/node-source-state";
import type { ParsedNode } from "../../../packages/core/src/types/node";

function node(name: string): ParsedNode {
  return { name, type: "ss", server: "example.com", port: 8388, cipher: "aes-128-gcm", password: "test" } as ParsedNode;
}

describe("manual proxy group members respect source selection", () => {
  it.each([
    { includeRegex: "美国|香港", excludeRegex: "", expected: ["US 美国01", "HK 香港01"] },
    { includeRegex: "", excludeRegex: "美国|香港", expected: ["JP 日本01"] },
    { includeRegex: "美国|香港", excludeRegex: "香港", expected: ["US 美国01"] },
  ])("matches Chinese regex alternatives for manually added nodes: $includeRegex / $excludeRegex", ({ includeRegex, excludeRegex, expected }) => {
    const nodes = [node("US 美国01"), node("HK 香港01"), node("JP 日本01")];
    const extraMembers = nodes.map((item) => ({ kind: "node" as const, name: item.name }));
    const options = { nodes, defaultProxyNames: nodes.map((item) => item.name) };
    expect(resolveProxyGroupMembers({
      ...options,
      advanced: { includeRegex, excludeRegex, extraMembers },
    }).proxyNames).toEqual(expected);
    expect(resolveProxyGroupMembers({
      ...options,
      advanced: { includeRegex: "", excludeRegex: "", extraMembers },
    }).proxyNames).toEqual(nodes.map((item) => item.name));
  });

  it.each([
    { sourceIds: ["source-a"], expected: ["Node A", "Shared"] },
    { sourceIds: ["source-b"], expected: ["Node B", "Shared"] },
    { sourceIds: ["source-a", "source-b"], expected: ["Node A", "Node B", "Shared"] },
    { sourceIds: ["missing"], expected: [] },
    { sourceIds: [], expected: ["Node A", "Node B", "Shared", "Untagged"] },
  ])("filters manually added nodes by sources: $sourceIds", ({ sourceIds, expected }) => {
    const nodes = [
      withNodeSourceId(node("Node A"), "source-a"),
      withNodeSourceId(node("Node B"), "source-b"),
      { ...node("Shared"), _sourceIds: ["source-a", "source-b"] },
      node("Untagged"),
    ];
    const result = resolveProxyGroupMembers({
      nodes,
      defaultProxyNames: nodes.map((item) => item.name),
      advanced: {
        sourceIds,
        extraMembers: nodes.map((item) => ({ kind: "node", name: item.name })),
      },
    });
    expect(result.proxyNames).toEqual(expected);
    expect(result.excluded.map((item) => item.name)).toEqual(
      nodes.map((item) => item.name).filter((name) => !expected.includes(name)),
    );
  });

  it("preserves non-node members and order while filtering manual nodes", () => {
    const result = resolveProxyGroupMembers({
      nodes: [
        withNodeSourceId(node("Node A"), "source-a"),
        withNodeSourceId(node("Node B"), "source-a"),
      ],
      defaultProxyNames: [],
      moduleNames: { auto: "Auto" },
      customProxyGroups: [{ id: "custom", name: "Custom", emoji: "", groupType: "select" }],
      advanced: {
        sourceIds: ["source-a"],
        regions: ["kr"],
        includeRegex: "does-not-match",
        excludeRegex: "Node",
        extraMembers: [
          { kind: "node", name: "Node A" },
          { kind: "node", name: "Node B" },
          { kind: "node", name: "Deleted" },
          { kind: "direct" },
          { kind: "reject" },
          { kind: "module", id: "auto" },
          { kind: "custom", id: "custom" },
        ],
        excludedMembers: [{ kind: "node", name: "Node B" }],
        memberOrder: [{ kind: "custom", id: "custom" }, { kind: "node", name: "Node A" }],
      },
    });
    expect(result.proxyNames).toEqual(["Custom", "DIRECT", "REJECT", "Auto"]);
  });

});
