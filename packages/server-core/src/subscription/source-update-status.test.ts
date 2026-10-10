import { describe, expect, it } from "vitest";
import { refreshNodeSnapshot } from "./refresh-node-snapshot";
import { summarizeSourceUpdates, withSourceUpdateResults } from "./source-update-status";

const sources = [
  { id: "a", type: "url", content: "https://a.example/sub" },
  { id: "b", type: "url", content: "https://b.example/sub" },
  { id: "yaml", type: "yaml", content: 'proxies: [{name: static, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: secret}]' },
  { id: "nodes", type: "nodes", content: "ss://YWVzLTEyOC1nY206c2VjcmV0@example.com:443#static" },
  { id: "provider", type: "url", content: "https://provider.example/sub", useProxyProviders: true },
];

describe("source update status", () => {
  it.each([ [true, true, 2, 0], [true, false, 1, 1], [false, false, 0, 2] ])(
    "counts real URL fetches (a=%s, b=%s), excluding static inputs and client-managed providers",
    async (a, b, succeeded, failed) => {
      const config = { sources };
      const snapshot = await refreshNodeSnapshot({
        config, urls: [], storedNodes: [],
        fetchUrlNodes: async (source) => ({
          ok: Boolean(source.id === "a" ? a : b),
          nodes: [{ name: source.id, type: "ss", server: "example.com", port: 443, cipher: "aes-128-gcm", password: "secret" }],
        }),
      });
      expect(snapshot.refreshedStaticSourceCount).toBe(2);
      const persisted = JSON.parse(JSON.stringify(withSourceUpdateResults(config, snapshot)));
      expect(summarizeSourceUpdates(persisted)).toEqual({ total: 2, succeeded, failed });
      expect(persisted.sourceUpdateResults).toHaveLength(2);
      expect(summarizeSourceUpdates({ ...persisted, sources: sources.slice(2) })).toEqual({ total: 0, succeeded: 0, failed: 0 });
      expect(summarizeSourceUpdates({ ...persisted, sources: [{ ...sources[0], content: "https://changed.example/sub" }] }))
        .toEqual({ total: 1, succeeded: 0, failed: 0 });
    }
  );
  it("does not invent successes for legacy or never-refreshed subscriptions", () => {
    expect(summarizeSourceUpdates({ sources })).toEqual({ total: 2, succeeded: 0, failed: 0 });
    expect(summarizeSourceUpdates({}, ["https://legacy.example/sub"])).toEqual({ total: 1, succeeded: 0, failed: 0 });
  });
});
