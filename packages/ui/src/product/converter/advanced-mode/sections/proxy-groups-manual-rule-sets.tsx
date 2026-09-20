"use client";

import * as React from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { resolveProxyGroupModuleName } from "@subboost/core/proxy-group-name";
import {
  inferRuleSetFormat,
  MANUAL_RULE_SET_URL_SUFFIX_ERROR,
} from "@subboost/core/rules/manual-rule-set";
import { parseRuleSetTargetValue } from "@subboost/core/rules/custom-routing-rule-sets";
import type { RuleSetBehavior } from "@subboost/core/types/config";
import { IconButton } from "@subboost/ui/components/ui/icon-button";
import { Input } from "@subboost/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@subboost/ui/components/ui/select";
import { toast } from "@subboost/ui/components/ui/toaster";
import { cn } from "@subboost/ui/lib/utils";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { ProxyGroupsAddedRuleSets } from "./proxy-groups-added-rule-sets";

export function ProxyGroupsManualRuleSets() {
  const {
    customRuleSets = [],
    customProxyGroups = [],
    hiddenProxyGroups = [],
    proxyGroupNameOverrides = {},
    importManualRuleSet,
  } = useConfigStore();
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [behavior, setBehavior] = React.useState<RuleSetBehavior | "">("");
  const [targetValue, setTargetValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [lastImport, setLastImport] = React.useState<{ id: string; fingerprint: string } | null>(null);
  const format = inferRuleSetFormat(url);
  const fingerprint = JSON.stringify([name.trim(), url.trim(), format, behavior, targetValue]);
  const target = parseRuleSetTargetValue(targetValue);
  const targetAvailable = target?.kind === "module"
    ? !hiddenProxyGroups.includes(target.id) && PROXY_GROUP_MODULES.some((module) => module.id === target.id)
    : target?.kind === "custom" && customProxyGroups.some((group) => group.id === target.id && group.enabled !== false);
  const imported = lastImport?.fingerprint === fingerprint && customRuleSets.some((rule) =>
    rule.id === lastImport.id && rule.name === name.trim() && rule.path === url.trim() &&
    rule.format === format && rule.behavior === behavior &&
    typeof rule.target === "object" && rule.target.kind === target?.kind && rule.target.id === target?.id
  );
  const ready = Boolean(name.trim() && url.trim() && behavior && targetAvailable);

  const handleImport = () => {
    if (!target || !behavior || !ready) return;
    if (!format) {
      setError(MANUAL_RULE_SET_URL_SUFFIX_ERROR);
      return;
    }
    const result = importManualRuleSet({ name, url, format, behavior, target });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setLastImport({ id: result.id, fingerprint });
    toast({
      title: "已添加规则集",
      description: "已加入当前配置，请保存/更新订阅。规则内容由客户端从 URL 下载。",
      variant: "success",
    });
  };

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-h-5 items-center gap-2">
        <span className="text-xs font-medium text-white/80">方法三：手动添加规则集</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Input
          aria-label="规则集名称"
          value={name}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          placeholder="规则集名称"
          className="h-7 min-w-0 flex-[1_1_8rem] border-white/10 bg-white/5 text-xs"
        />
        <Select value={behavior} onValueChange={(value) => { setBehavior(value as RuleSetBehavior); setError(null); }}>
          <SelectTrigger aria-label="规则集类型" className="h-7 w-[120px] shrink-0 text-xs"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="domain" className="text-xs">域名 / domain</SelectItem>
            <SelectItem value="ipcidr" className="text-xs">IP / ipcidr</SelectItem>
            <SelectItem value="classical" className="text-xs">Classical</SelectItem>
          </SelectContent>
        </Select>
        <Select value={targetAvailable ? targetValue : ""} onValueChange={(value) => { setTargetValue(value); setError(null); }}>
          <SelectTrigger aria-label="规则集目标代理组" className="h-7 min-w-0 flex-[1_1_8rem] text-xs"><SelectValue placeholder="选择目标代理组" /></SelectTrigger>
          <SelectContent>
            {PROXY_GROUP_MODULES.filter((module) => !hiddenProxyGroups.includes(module.id)).map((module) => (
              <SelectItem key={module.id} value={`module:${module.id}`} className="text-xs">
                {resolveProxyGroupModuleName(module, proxyGroupNameOverrides[module.id])}
              </SelectItem>
            ))}
            {customProxyGroups.filter((group) => group.enabled !== false).map((group) => (
              <SelectItem key={group.id} value={`custom:${group.id}`} className="text-xs">{group.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <LinkIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" aria-hidden="true" />
          <Input
            aria-label="规则集 URL"
            value={url}
            onChange={(event) => {
              const nextUrl = event.target.value;
              setUrl(nextUrl);
              setError(null);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); handleImport(); } }}
            placeholder="规则集 URL：支持 .mrs、.yaml"
            className="h-7 border-white/10 bg-white/5 pl-7 text-xs"
          />
        </div>
        <IconButton
          label="导入此源"
          variant="ghost"
          onClick={handleImport}
          disabled={!ready}
          title={imported ? "已导入" : "导入此源"}
          className={cn(
            "h-6 w-6 shrink-0 rounded p-1 transition-colors disabled:opacity-100",
            imported ? "text-green-400 hover:text-green-300" : ready
              ? "text-white/50 hover:bg-indigo-500/10 hover:text-indigo-400"
              : "cursor-not-allowed text-white/50",
          )}
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      {error && <p role="alert" className="break-words text-[10px] text-red-400">{error}</p>}
      <p className="text-[10px] leading-4 text-white/40">
        请按规则源说明选择类型。添加后在下方“已添加规则集”中管理，并保存/更新订阅；远程文件由客户端下载。
      </p>
      <ProxyGroupsAddedRuleSets
        totalRules={null}
        source="manual"
        display="name"
      />
    </div>
  );
}
