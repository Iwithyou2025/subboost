import { describe, expect, it } from "vitest";
import { resolveProxyGroupMembers } from "../../../packages/core/src/proxy-group-advanced";
import { withNodeSourceId } from "../../../packages/core/src/subscription/node-source-state";
import type { ParsedNode } from "../../../packages/core/src/types/node";

function node(name: string): ParsedNode {
  return { name, type: "ss", server: "example.com", port: 8388, cipher: "aes-128-gcm", password: "test" } as ParsedNode;
}

describe("manual proxy group members respect source selection", () => {
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

  it("preserves manual filter overrides, non-node members, exclusions and order", () => {
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
    expect(result.proxyNames).toEqual(["Custom", "Node A", "DIRECT", "REJECT", "Auto"]);
  });

});
