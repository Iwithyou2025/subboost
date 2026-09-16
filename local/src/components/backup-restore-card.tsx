"use client";

import * as React from "react";
import { ArchiveRestore, Download, LoaderCircle, Upload } from "lucide-react";

import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";

type JobState = "queued" | "running" | "succeeded" | "failed";

type JobStatus = {
  id: string;
  action: "export" | "restore" | "migrate";
  state: JobState;
  message?: string;
  downloadUrl?: string;
};

type BackupRestoreCardProps = {
  enabled: boolean;
};

const POLL_INTERVAL_MS = 1500;

export function BackupRestoreCard({ enabled }: BackupRestoreCardProps) {
  const restoreInputRef = React.useRef<HTMLInputElement>(null);
  const migrateInputRef = React.useRef<HTMLInputElement>(null);
  const [agentAvailable, setAgentAvailable] = React.useState<boolean | null>(null);
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
  const [activeAction, setActiveAction] = React.useState<"export" | "restore" | "migrate" | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setAgentAvailable(null);
      return () => {
        cancelled = true;
      };
    }

    void fetch("/api/backups/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("status unavailable");
        const body = (await response.json()) as { available?: unknown };
        if (typeof body.available !== "boolean") throw new Error("invalid status");
        if (!cancelled) setAgentAvailable(body.available);
      })
      .catch(() => {
        if (!cancelled) setAgentAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/backups/jobs/${encodeURIComponent(activeJobId)}`, { cache: "no-store" });
        if (response.ok) {
          const job = (await response.json()) as JobStatus;
          if (cancelled) return;
          if (job.state === "failed") {
            setMessage(job.message || "操作失败，请查看服务器日志。");
            setActiveJobId(null);
            setActiveAction(null);
            return;
          }
          if (job.state === "succeeded") {
            setActiveJobId(null);
            setActiveAction(null);
            if (job.action === "export" && job.downloadUrl) {
              setMessage("备份已生成，正在下载。");
              window.location.href = job.downloadUrl;
            } else if (job.action === "migrate") {
              setMessage("完整迁移成功，请使用来源环境的访问地址和管理员账号登录。");
            } else {
              setMessage("恢复成功，SubBoost 已重新启动。");
            }
            return;
          }
        }
      } catch {
        // Restore intentionally restarts the app; keep polling through the temporary disconnect.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId]);

  const startExport = async () => {
    setMessage(null);
    setActiveAction("export");
    try {
      const response = await fetch("/api/backups/export", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { jobId?: unknown; error?: unknown };
      if (!response.ok || typeof body.jobId !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "无法创建备份任务。");
      }
      setActiveJobId(body.jobId);
    } catch (error) {
      setActiveAction(null);
      setMessage(error instanceof Error ? error.message : "无法创建备份任务。");
    }
  };

  const startRestore = async (files: File[], mode: "data" | "full") => {
    if (files.length === 0) return;
    const fullMigration = mode === "full";
    const confirmation = fullMigration
      ? "完整迁移会替换当前数据库、密钥、端口、访问地址及全部配置。系统会先自动创建安全备份，确定继续吗？"
      : "恢复会覆盖当前数据库内容。系统会先自动创建安全备份，确定继续吗？";
    if (!window.confirm(confirmation)) return;

    setMessage(null);
    setActiveAction(fullMigration ? "migrate" : "restore");
    const formData = new FormData();
    formData.append("mode", mode);
    for (const file of files) formData.append("files", file);

    try {
      const response = await fetch("/api/backups/restore", { method: "POST", body: formData });
      const body = (await response.json().catch(() => ({}))) as { jobId?: unknown; error?: unknown };
      if (!response.ok || typeof body.jobId !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "无法创建恢复任务。");
      }
      setActiveJobId(body.jobId);
      setMessage(
        fullMigration
          ? "完整迁移已开始。若端口或访问地址发生变化，请使用备份中的 APP_URL 重新登录。"
          : "恢复任务已开始，期间网页可能短暂断开，请勿关闭页面。",
      );
    } catch (error) {
      setActiveAction(null);
      setMessage(error instanceof Error ? error.message : "无法创建恢复任务。");
    } finally {
      if (fullMigration && migrateInputRef.current) migrateInputRef.current.value = "";
      if (!fullMigration && restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  const busy = activeJobId !== null || activeAction !== null;
  const unavailable = enabled && agentAvailable === false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="rounded-lg bg-amber-500/20 p-2 text-amber-300">
          <ArchiveRestore className="h-5 w-5" />
        </div>
        <CardTitle className="text-base">备份与恢复</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-white/90">完整备份</p>
            <p className="mt-1 text-xs text-white/45">导出数据库和恢复所需配置为 ZIP。</p>
          </div>
          <Button className="gap-2" variant="outline" disabled={!enabled || agentAvailable !== true || busy} onClick={() => void startExport()}>
            {activeAction === "export" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            导出 ZIP
          </Button>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-white/90">仅恢复数据</p>
            <p className="mt-1 text-xs text-white/45">替换数据库数据，保留当前端口、地址、数据库账号及服务配置。</p>
          </div>
          <input
            ref={restoreInputRef}
            type="file"
            className="hidden"
            accept=".zip,.dump,.env"
            multiple
            disabled={!enabled || agentAvailable !== true || busy}
            onChange={(event) => void startRestore(Array.from(event.currentTarget.files || []), "data")}
          />
          <Button
            className="gap-2"
            variant="outline"
            disabled={!enabled || agentAvailable !== true || busy}
            onClick={() => restoreInputRef.current?.click()}
          >
            {activeAction === "restore" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            选择备份
          </Button>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-white/90">完整迁移</p>
            <p className="mt-1 text-xs text-white/45">使用完整备份 ZIP 替换数据库、密钥、端口、访问地址及全部配置。</p>
          </div>
          <input
            ref={migrateInputRef}
            type="file"
            className="hidden"
            accept=".zip"
            disabled={!enabled || agentAvailable !== true || busy}
            onChange={(event) => void startRestore(Array.from(event.currentTarget.files || []), "full")}
          />
          <Button
            className="gap-2"
            variant="outline"
            disabled={!enabled || agentAvailable !== true || busy}
            onClick={() => migrateInputRef.current?.click()}
          >
            {activeAction === "migrate" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            选择完整备份
          </Button>
        </div>

        {agentAvailable === null && enabled && <p className="text-xs text-white/40">正在检查备份管理服务…</p>}
        {unavailable && (
          <p className="text-xs text-amber-300">
            备份管理服务未运行，请执行一次 sudo subboost agent-install。
          </p>
        )}
        {message && <p className="text-xs text-white/60">{message}</p>}
      </CardContent>
    </Card>
  );
}
