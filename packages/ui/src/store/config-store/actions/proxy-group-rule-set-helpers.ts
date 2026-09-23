import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { getModuleRuleOrderKey } from "@subboost/core/generator/module-rules";
import {
  EXPERIMENTAL_CN_RULE,
  getCustomRuleSetOrderKey,
  normalizePersistedRuleOrder,
  resolveAppliedRuleOrder,
} from "@subboost/core/generator/rules";
import { resolveProxyGroupModuleName } from "@subboost/core/proxy-group-name";
import { normalizeProxyGroupTargetRef } from "@subboost/core/proxy-group-targets";
import {
  buildRuleSetUrlFromPath,
  isValidRuleSetFormatBehavior,
  isValidRuleSetPathOrUrl,
  normalizeRuleSetPathInput,
} from "@subboost/core/rules/rule-model";
import {
  canonicalRuleSetUrl,
  createManualRuleSetId,
  MANUAL_RULE_SET_NAME_CONFLICT_ERROR,
  MANUAL_RULE_SET_URL_CONFLICT_ERROR,
} from "@subboost/core/rules/manual-rule-set";
import type {
  BuiltinRuleEdits,
  CustomProxyGroup,
  CustomRuleSet,
  ProxyGroupRuleTarget,
  ProxyGroupTargetRef,
  RuleSetBehavior,
} from "@subboost/core/types/config";
import type { RuleSetDraft } from "../definitions";

type ManualRuleSetConflictState = {
  enabledProxyGroups: string[];
  customProxyGroups: CustomProxyGroup[];
  customRuleSets: CustomRuleSet[];
  builtinRuleEdits: BuiltinRuleEdits;
  proxyGroupNameOverrides: Record<string, string>;
  ruleProviderBaseUrl: string;
  experimentalCnUseCnRuleSet: boolean;
};

type ManualRuleSetConflictInput = {
  name: string;
  url: string;
  target: ProxyGroupTargetRef;
  excludeId?: string;
};

export function normalizeRuleSetDraft(rule: RuleSetDraft): RuleSetDraft | null {
  if (!rule || typeof rule.id !== "string" || typeof rule.path !== "string") return null;
  const id = rule.id.trim();
  const path = normalizeRuleSetPathInput(rule.path);
  if (!id || !path || !isValidRuleSetPathOrUrl(path)) return null;
  const behavior: RuleSetBehavior = rule.behavior === "ipcidr" || path.toLowerCase().startsWith("geoip/")
    ? "ipcidr"
    : rule.behavior === "classical" ? "classical" : "domain";
  if (!isValidRuleSetFormatBehavior(rule.format, behavior)) return null;
  return {
    id,
    name: typeof rule.name === "string" && rule.name.trim() ? rule.name.trim() : id,
    behavior,
    ...(rule.format !== undefined ? { format: rule.format } : {}),
    path,
    ...(rule.format !== undefined && typeof rule.noResolve === "boolean"
      ? { noResolve: rule.noResolve }
      : rule.noResolve || behavior === "ipcidr" ? { noResolve: true } : {}),
  };
}

export function normalizeRuleOrderForState(state: {
  enabledProxyGroups: string[];
  customProxyGroups: CustomProxyGroup[];
  customRules: Parameters<typeof normalizePersistedRuleOrder>[0]["customRules"];
  customRuleSets: Parameters<typeof normalizePersistedRuleOrder>[0]["customRuleSets"];
  builtinRuleEdits: Parameters<typeof normalizePersistedRuleOrder>[0]["builtinRuleEdits"];
  proxyGroupNameOverrides: Record<string, string>;
  experimentalCnUseCnRuleSet: boolean;
  cnIpNoResolve: boolean;
  ruleOrder: string[];
}): string[] {
  return normalizePersistedRuleOrder({
    enabledModules: state.enabledProxyGroups,
    customProxyGroups: state.customProxyGroups,
    customRules: state.customRules,
    customRuleSets: state.customRuleSets,
    builtinRuleEdits: state.builtinRuleEdits,
    proxyGroupNameOverrides: state.proxyGroupNameOverrides,
    experimentalCnUseCnRuleSet: state.experimentalCnUseCnRuleSet,
    cnIpNoResolve: state.cnIpNoResolve,
    ruleOrder: state.ruleOrder,
  });
}

export function placeManualRuleSetFirst(
  state: Parameters<typeof normalizeRuleOrderForState>[0],
  ruleSetId: string,
): string[] {
  const key = getCustomRuleSetOrderKey(ruleSetId);
  const order = resolveAppliedRuleOrder({
    enabledModules: state.enabledProxyGroups,
    customProxyGroups: state.customProxyGroups,
    customRules: state.customRules,
    customRuleSets: state.customRuleSets,
    builtinRuleEdits: state.builtinRuleEdits,
    proxyGroupNameOverrides: state.proxyGroupNameOverrides,
    experimentalCnUseCnRuleSet: state.experimentalCnUseCnRuleSet,
    cnIpNoResolve: state.cnIpNoResolve,
    ruleOrder: state.ruleOrder,
  }).filter((entry) => entry !== key);
  const firstRuleSetIndex = order.findIndex(
    (entry) =>
      entry.startsWith("module:") ||
      entry.startsWith("custom-rule-set:") ||
      entry === "special:experimental-cn",
  );
  order.splice(firstRuleSetIndex < 0 ? order.length : firstRuleSetIndex, 0, key);
  return order;
}

export function resolveModuleTargetName(moduleId: string, overrides?: Record<string, string>): string | null {
  const proxyModule = PROXY_GROUP_MODULES.find((item) => item.id === moduleId);
  if (!proxyModule) return null;
  return resolveProxyGroupModuleName(proxyModule, overrides?.[moduleId]);
}

export function resolveMoveTargetName(
  target: { kind: "module" | "custom"; id: string },
  customProxyGroups: CustomProxyGroup[],
  proxyGroupNameOverrides?: Record<string, string>
): string | null {
  if (target.kind === "module") return resolveModuleTargetName(target.id, proxyGroupNameOverrides);
  const group = customProxyGroups.find((item) => item.id === target.id);
  return group?.name?.trim() || null;
}

export function resolveRuleSetContainerTargetName(
  id: string,
  customProxyGroups: CustomProxyGroup[],
  proxyGroupNameOverrides?: Record<string, string>
): string | null {
  return (
    resolveModuleTargetName(id, proxyGroupNameOverrides) ||
    customProxyGroups.find((group) => group.id === id)?.name?.trim() ||
    null
  );
}

export function findManualRuleSetConflict(
  state: ManualRuleSetConflictState,
  input: ManualRuleSetConflictInput,
): string | null {
  const targetName = resolveRuleSetContainerTargetName(
    input.target.id,
    state.customProxyGroups,
    state.proxyGroupNameOverrides,
  );
  const sourceUrl = canonicalRuleSetUrl(input.url);
  if (!targetName || !sourceUrl) return null;

  const normalizedName = createManualRuleSetId(input.name);
  let nameConflict = false;
  let urlConflict = false;

  for (const ruleSet of state.customRuleSets) {
    if (ruleSet.id === input.excludeId) continue;
    if (!ruleTargetMatchesContainer(ruleSet.target, input.target, targetName)) continue;
    if (createManualRuleSetId(ruleSet.name || ruleSet.id) === normalizedName) nameConflict = true;
    if (
      canonicalRuleSetUrl(buildRuleSetUrlFromPath(ruleSet.path, state.ruleProviderBaseUrl)) === sourceUrl
    ) {
      urlConflict = true;
    }
  }

  const enabledModules = new Set(state.enabledProxyGroups);
  if (input.target.kind === "module") enabledModules.add(input.target.id);
  for (const proxyModule of PROXY_GROUP_MODULES) {
    if (!enabledModules.has(proxyModule.id)) continue;
    for (const rule of proxyModule.rules) {
      const edit = state.builtinRuleEdits?.[getModuleRuleOrderKey(proxyModule.id, rule.id)];
      if (edit?.enabled === false) continue;
      const effectiveTarget: ProxyGroupRuleTarget = edit?.target || {
        kind: "module",
        id: proxyModule.id,
      };
      if (!ruleTargetMatchesContainer(effectiveTarget, input.target, targetName)) continue;
      if (createManualRuleSetId(rule.id) === normalizedName) nameConflict = true;
      if (
        canonicalRuleSetUrl(buildRuleSetUrlFromPath(rule.path, state.ruleProviderBaseUrl)) === sourceUrl
      ) {
        urlConflict = true;
      }
    }
  }

  if (
    state.experimentalCnUseCnRuleSet &&
    enabledModules.has("cn") &&
    ruleTargetMatchesContainer({ kind: "module", id: "cn" }, input.target, targetName)
  ) {
    if (createManualRuleSetId(EXPERIMENTAL_CN_RULE.id) === normalizedName) nameConflict = true;
    if (
      canonicalRuleSetUrl(
        buildRuleSetUrlFromPath(EXPERIMENTAL_CN_RULE.path, state.ruleProviderBaseUrl),
      ) === sourceUrl
    ) {
      urlConflict = true;
    }
  }

  if (nameConflict) return MANUAL_RULE_SET_NAME_CONFLICT_ERROR;
  if (urlConflict) return MANUAL_RULE_SET_URL_CONFLICT_ERROR;
  return null;
}

export function compactBuiltinRuleEdits(edits: BuiltinRuleEdits): BuiltinRuleEdits {
  const next: BuiltinRuleEdits = {};
  for (const [key, edit] of Object.entries(edits || {})) {
    const target = normalizeProxyGroupTargetRef(edit?.target) ??
      (typeof edit?.target === "string" ? edit.target.trim() : "");
    const enabled = edit?.enabled === false ? false : undefined;
    if (!target && enabled !== false) continue;
    next[key] = {
      ...(target ? { target } : {}),
      ...(enabled === false ? { enabled: false } : {}),
    };
  }
  return next;
}

export function updateBuiltinRuleEdit(
  edits: BuiltinRuleEdits,
  key: string,
  patch: { target?: ProxyGroupRuleTarget | null; enabled?: false | true | null }
): BuiltinRuleEdits {
  const prev = edits?.[key] || {};
  const next = { ...prev };
  if ("target" in patch) {
    const target = normalizeProxyGroupTargetRef(patch.target) ??
      (typeof patch.target === "string" ? patch.target.trim() : "");
    if (target) next.target = target;
    else delete next.target;
  }
  if ("enabled" in patch) {
    if (patch.enabled === false) next.enabled = false;
    else delete next.enabled;
  }
  return compactBuiltinRuleEdits({ ...(edits || {}), [key]: next });
}

export function retargetBuiltinRuleEdits(edits: BuiltinRuleEdits, from: string, to: string): BuiltinRuleEdits {
  if (!from || from === to) return edits;
  let changed = false;
  const next: BuiltinRuleEdits = {};
  for (const [key, edit] of Object.entries(edits || {})) {
    if (edit?.target === from) {
      next[key] = { ...edit, target: to };
      changed = true;
    } else {
      next[key] = edit;
    }
  }
  return changed ? compactBuiltinRuleEdits(next) : edits;
}

export function findBuiltinRuleEditKeyByTarget(
  edits: BuiltinRuleEdits,
  target: ProxyGroupTargetRef,
  legacyTargetName: string,
  ruleId: string
): string | null {
  if (!target.id || !legacyTargetName || !ruleId) return null;
  for (const [key, edit] of Object.entries(edits || {})) {
    if (!ruleTargetMatchesContainer(edit?.target, target, legacyTargetName)) continue;
    const parts = key.split(":");
    if (parts.length !== 3 || parts[0] !== "module") continue;
    if (parts[2] === ruleId) return key;
  }
  return null;
}

export function appendUniqueCustomRuleSets(
  existing: CustomRuleSet[],
  drafts: RuleSetDraft[],
  target: ProxyGroupRuleTarget
): CustomRuleSet[] {
  const seen = new Set(existing.map((item) => item.id));
  const next = [...existing];
  for (const draft of drafts) {
    const ruleSet = normalizeRuleSetDraft(draft);
    if (!ruleSet || seen.has(ruleSet.id)) continue;
    seen.add(ruleSet.id);
    next.push({ ...ruleSet, target });
  }
  return next;
}

export function ruleTargetMatchesContainer(
  target: ProxyGroupRuleTarget | undefined,
  container: ProxyGroupTargetRef,
  legacyTargetName: string
): boolean {
  const ref = normalizeProxyGroupTargetRef(target);
  if (ref) return ref.kind === container.kind && ref.id === container.id;
  return typeof target === "string" && target.trim() === legacyTargetName.trim();
}
