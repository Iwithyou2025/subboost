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
    if (/\.ya?ml$/i.test(path)) return "yaml";
  } catch {
    // Allow typing an incomplete URL; validation happens when importing.
  }
  return null;
}

export function validateManualRuleSetInput(input: ManualRuleSetInput): string | null {
  if (!input.name.trim()) return "请填写规则集名称";
  if (!canonicalRuleSetUrl(input.url)) return "请填写有效的 HTTP/HTTPS 规则集 URL（不支持 URL 内嵌用户名密码）";
  if (!isValidRuleSetFormatBehavior(input.format, input.behavior) || input.format === undefined) {
    return "规则集格式或类型无效：MRS 仅支持 domain/ipcidr，classical 请使用 YAML";
  }
  const inferred = inferRuleSetFormat(input.url);
  if (inferred && inferred !== input.format) return "选择的格式与 URL 后缀不一致";
  if (!input.target?.id || (input.target.kind !== "module" && input.target.kind !== "custom")) {
    return "请选择目标代理组";
  }
  return null;
}

export function createManualRuleSet(input: ManualRuleSetInput, usedIds: Set<string>): CustomRuleSet {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const baseId = `manual-rule-set-${suffix}`;
  let id = baseId;
  for (let index = 2; usedIds.has(id); index += 1) id = `${baseId}-${index}`;
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
