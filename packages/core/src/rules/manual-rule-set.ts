import type { CustomRuleSet, ProxyGroupTargetRef, RuleSetBehavior, RuleSetFormat } from "@subboost/core/types/config";
import { isValidRuleSetFormatBehavior } from "./rule-model";

export type ManualRuleSetInput = {
  name: string;
  url: string;
  format: RuleSetFormat;
  behavior: RuleSetBehavior;
  target: ProxyGroupTargetRef;
};

export type ManualRuleSetImportResult = { ok: true; id: string } | { ok: false; error: string };
export const MANUAL_RULE_SET_NAME_CONFLICT_ERROR = "规则集名称已存在或与内置规则集冲突，请更换名称";
export const MANUAL_RULE_SET_URL_CONFLICT_ERROR = "此规则集 URL 已存在，请在已有规则集中调整目标代理组";
export const MANUAL_RULE_SET_URL_SUFFIX_ERROR = "规则集 URL 必须以 .mrs 或 .yaml 结尾";

export function canonicalRuleSetUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function inferRuleSetFormat(value: string): RuleSetFormat | null {
  try {
    const path = new URL(value.trim()).pathname;
    if (/\.mrs$/i.test(path)) return "mrs";
    if (/\.yaml$/i.test(path)) return "yaml";
  } catch {
    // Allow typing an incomplete URL; validation happens when importing.
  }
  return null;
}

export function validateManualRuleSetInput(input: ManualRuleSetInput): string | null {
  if (!input.name.trim()) return "请填写规则集名称";
  if (!canonicalRuleSetUrl(input.url)) return "请填写有效的 HTTP/HTTPS 规则集 URL（不支持 URL 内嵌用户名密码）";
  const inferred = inferRuleSetFormat(input.url);
  if (!inferred) return MANUAL_RULE_SET_URL_SUFFIX_ERROR;
  if (!isValidRuleSetFormatBehavior(input.format, input.behavior) || input.format === undefined) {
    return "规则集格式或类型无效：MRS 仅支持 domain/ipcidr，classical 请使用 YAML";
  }
  if (inferred !== input.format) return "规则集格式与 URL 后缀不一致";
  if (!input.target?.id || (input.target.kind !== "module" && input.target.kind !== "custom")) {
    return "请选择目标代理组";
  }
  return null;
}

export function createManualRuleSetId(name: string): string {
  const normalizedName = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(normalizedName).slice(0, 64).join("") || "manual-rule-set";
}

function stableIdHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(-7);
}

function fitScopedId(base: string, scope: string, suffix = ""): string {
  const normalizedScope = Array.from(scope).slice(0, 32).join("");
  const tail = `--${normalizedScope}${suffix}`;
  const available = Math.max(1, 64 - Array.from(tail).length);
  return `${Array.from(base).slice(0, available).join("")}${tail}`;
}

function createUniqueManualRuleSetId(input: ManualRuleSetInput, usedIds: Set<string>): string {
  const base = createManualRuleSetId(input.name);
  const used = new Set(Array.from(usedIds, (id) => id.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;

  const scope = createManualRuleSetId(`${input.target.kind}-${input.target.id}`);
  const scoped = fitScopedId(base, scope);
  if (!used.has(scoped.toLowerCase())) return scoped;

  const seed = `${input.name}\n${input.url}\n${input.target.kind}:${input.target.id}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `-${stableIdHash(`${seed}\n${attempt}`)}`;
    const candidate = fitScopedId(base, scope, suffix);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("无法生成唯一规则集 ID，请更换名称后重试");
}

export function createManualRuleSet(input: ManualRuleSetInput, usedIds: Set<string>): CustomRuleSet {
  const id = createUniqueManualRuleSetId(input, usedIds);
  return {
    id,
    name: input.name.trim(),
    path: input.url.trim(),
    behavior: input.behavior,
    format: input.format,
    target: { ...input.target },
    noResolve: input.behavior === "ipcidr",
  };
}
