import type { ParsedNode } from "@subboost/core/types/node";

export interface NodeContentKeyOptions {
  ignoreServer?: boolean;
  ignorePort?: boolean;
  ignoreSni?: boolean;
  ignoreServername?: boolean;
}

export function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalize = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (seen.has(input as object)) return null;
    seen.add(input as object);

    if (Array.isArray(input)) return input.map(normalize);

    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      // 与 buildNodeContentKey 顶层行为一致：递归忽略 SubBoost 内部 _ 前缀字段
      // （如 reality-opts._spider-x，机场每次更新轮换会导致内容指纹变化、节点匹配失败）
      if (key.startsWith("_")) continue;
      out[key] = normalize(obj[key]);
    }
    return out;
  };

  return JSON.stringify(normalize(value));
}

export function buildNodeContentKey(
  node: ParsedNode,
  opts?: NodeContentKeyOptions
): string {
  const record = node as unknown as Record<string, unknown>;
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => {
      if (key === "name" || key === "_meta" || key.startsWith("_")) return false;
      if (opts?.ignoreServer && key === "server") return false;
      if (opts?.ignorePort && key === "port") return false;
      if (opts?.ignoreSni && key === "sni") return false;
      if (opts?.ignoreServername && key === "servername") return false;
      return true;
    })
  );

  return stableJsonStringify(filtered);
}

export function buildScopedNodeIdentityKey(scope: string, node: ParsedNode): string {
  return `${scope.trim()}\u0000${buildNodeContentKey(node)}`;
}
