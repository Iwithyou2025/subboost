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

export function createManualRuleSet(input: ManualRuleSetInput, usedIds: Set<string>): CustomRuleSet {
  const id = createManualRuleSetId(input.name);
  if (usedIds.has(id)) throw new Error(MANUAL_RULE_SET_NAME_CONFLICT_ERROR);
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
