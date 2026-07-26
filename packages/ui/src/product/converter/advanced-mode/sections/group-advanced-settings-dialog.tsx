"use client";

import * as React from "react";
import { Button } from "@subboost/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@subboost/ui/components/ui/dialog";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { Input } from "@subboost/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@subboost/ui/components/ui/select";
import { Switch } from "@subboost/ui/components/ui/switch";
import {
  DEFAULT_LOAD_BALANCE_STRATEGY,
  LOAD_BALANCE_STRATEGIES,
  type GroupListenerBinding,
  type GroupListenerTarget,
  type LoadBalanceStrategy,
  type ProxyGroupGroupType,
} from "@subboost/core/types/config";
import { getLoadBalanceStrategyLabel, getProxyGroupTypeLabel } from "./proxy-group-type-menu";
import {
  validateGroupListenerPort,
  type GroupListenerConflictState,
} from "./group-listener-settings";

const GROUP_TYPE_OPTIONS: ProxyGroupGroupType[] = [
  "select",
  "url-test",
  "fallback",
  "load-balance",
  "direct-first",
  "reject-first",
];

export interface GroupAdvancedSettingsValue {
  groupType: ProxyGroupGroupType;
  strategy?: LoadBalanceStrategy;
  listener: { port: number; enabled: boolean; allowLan: boolean } | null;
}

interface GroupAdvancedSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  groupType: ProxyGroupGroupType;
  strategy?: LoadBalanceStrategy;
  listenerTarget: GroupListenerTarget;
  listenerBinding?: GroupListenerBinding;
  conflictState: GroupListenerConflictState;
  onSave: (value: GroupAdvancedSettingsValue) => void;
}

/**
 * 策略组统一高级设置弹窗：组类型、负载均衡策略（仅 load-balance）、监听端口。
 * 保存/取消语义：所有修改保存前只存在于本地 state，取消不落任何变更。
 */
export function GroupAdvancedSettingsDialog({
  open,
  onOpenChange,
  groupName,
  groupType,
  strategy,
  listenerTarget,
  listenerBinding,
  conflictState,
  onSave,
}: GroupAdvancedSettingsDialogProps) {
  const [draftType, setDraftType] = React.useState<ProxyGroupGroupType>(groupType);
  const [draftStrategy, setDraftStrategy] = React.useState<LoadBalanceStrategy>(
    strategy ?? DEFAULT_LOAD_BALANCE_STRATEGY
  );
  const [listenerOn, setListenerOn] = React.useState(false);
  const [portInput, setPortInput] = React.useState("");
  const [allowLan, setAllowLan] = React.useState(false);

  // 每次打开时从当前配置重建草稿，丢弃上次未保存的修改
  React.useEffect(() => {
    if (!open) return;
    setDraftType(groupType);
    setDraftStrategy(strategy ?? DEFAULT_LOAD_BALANCE_STRATEGY);
    setListenerOn(Boolean(listenerBinding && listenerBinding.enabled !== false));
    setPortInput(listenerBinding ? String(listenerBinding.port) : "");
    setAllowLan(listenerBinding?.allowLan === true);
  }, [open, groupType, strategy, listenerBinding]);

  // 开关关闭=暂停（保留配置不生成），端口只需格式合法、无需无冲突（与生成器一致）
  const portCheck = React.useMemo(
    () => validateGroupListenerPort(portInput, conflictState, listenerTarget, { checkConflict: listenerOn }),
    [portInput, conflictState, listenerTarget, listenerOn]
  );
  // 仅当监听开启，或关闭但保留了端口值时才需要端口合法（允许清空端口来彻底移除配置）
  const portRequired = listenerOn || portInput.trim() !== "";
  const portError = portRequired ? portCheck.error : null;
  const canSave = !portError;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      groupType: draftType,
      ...(draftType === "load-balance" ? { strategy: draftStrategy } : {}),
      listener: portRequired && portCheck.port !== null
        ? { port: portCheck.port, enabled: listenerOn, allowLan }
        : null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-words pr-6 text-white">{groupName} · 高级设置</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="代理组类型">
            <Select value={draftType} onValueChange={(value) => setDraftType(value as ProxyGroupGroupType)}>
              <SelectTrigger className="h-8 border-white/10 bg-white/5 text-xs text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUP_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option} className="text-xs">
                    {getProxyGroupTypeLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {draftType === "load-balance" && (
            <FormField label="负载均衡策略">
              <Select
                value={draftStrategy}
                onValueChange={(value) => setDraftStrategy(value as LoadBalanceStrategy)}
              >
                <SelectTrigger className="h-8 border-white/10 bg-white/5 text-xs text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOAD_BALANCE_STRATEGIES.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs">
                      {getLoadBalanceStrategyLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}

          <div className="space-y-3 rounded-lg border border-white/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-white">监听端口</div>
                <div className="text-[10px] leading-relaxed text-white/45">
                  为该策略组开一个本地 mixed 入站端口，流量固定走此组
                </div>
              </div>
              <Switch
                aria-label={`启用 ${groupName} 监听端口`}
                checked={listenerOn}
                onCheckedChange={setListenerOn}
              />
            </div>

            {(listenerOn || portInput.trim() !== "") && (
              <>
                <FormField label="端口" error={portError}>
                  <Input
                    value={portInput}
                    inputMode="numeric"
                    placeholder="例如 7891"
                    className="h-8 border-white/10 bg-white/5 text-xs"
                    onChange={(event) => setPortInput(event.target.value)}
                  />
                </FormField>

                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-white/65">允许局域网访问</div>
                  <Switch
                    aria-label={`允许局域网访问 ${groupName} 监听端口`}
                    checked={allowLan}
                    onCheckedChange={setAllowLan}
                  />
                </div>
                {allowLan && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-200">
                    开启后监听 0.0.0.0，局域网内任何设备都能通过该端口使用此代理，请确认所在网络可信。
                    默认仅本机（127.0.0.1）可访问。
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-3 text-xs text-white/65 hover:text-white"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={!canSave}
            onClick={handleSave}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
