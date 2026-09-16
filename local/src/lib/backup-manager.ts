import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANAGER_DATA_CONTAINER_DIR = "/var/lib/subboost-manager";
export const MANAGER_AGENT_HEARTBEAT_MAX_AGE_MS = 15_000;
export const MAX_BACKUP_UPLOAD_BYTES = 256 * 1024 * 1024;

export type BackupJobAction = "export" | "restore" | "migrate";
export type BackupJobState = "queued" | "running" | "succeeded" | "failed";
export type RestoreMode = "data" | "full";

export type BackupJobStatus = {
  id: string;
  action: BackupJobAction;
  state: BackupJobState;
  message?: string;
  outputFile?: string;
  updatedAt: string;
};

type BackupJobRequest = {
  id: string;
  action: BackupJobAction;
  requestedBy: string;
  inputZip?: string;
  inputDump?: string;
  inputEnv?: string;
  createdAt: string;
};

type UploadFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function managerRoot(): string {
  const configured = process.env.SUBBOOST_MANAGER_DATA_DIR?.trim();
  return configured || MANAGER_DATA_CONTAINER_DIR;
}

export function backupManagerPaths(root = managerRoot()) {
  return {
    root,
    jobs: path.join(root, "jobs"),
    uploads: path.join(root, "uploads"),
    exports: path.join(root, "exports"),
    status: path.join(root, "status"),
    heartbeat: path.join(root, "agent-heartbeat"),
  };
}

export function isBackupJobId(value: string): boolean {
  return /^[a-f0-9-]{36}$/.test(value);
}

function isSafeManagerFilename(value: string): boolean {
  return value.length > 0 && value === path.basename(value) && !value.includes("\\") && !value.includes("/");
}

async function ensureManagerDirectories() {
  const paths = backupManagerPaths();
  await Promise.all([
    mkdir(paths.jobs, { recursive: true }),
    mkdir(paths.uploads, { recursive: true }),
    mkdir(paths.exports, { recursive: true }),
    mkdir(paths.status, { recursive: true }),
  ]);
  return paths;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function managerAgentAvailable(now = Date.now()): Promise<boolean> {
  try {
    const info = await stat(backupManagerPaths().heartbeat);
    return now - info.mtimeMs <= MANAGER_AGENT_HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function createExportJob(requestedBy: string): Promise<string> {
  const paths = await ensureManagerDirectories();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const request: BackupJobRequest = { id, action: "export", requestedBy, createdAt };
  const status: BackupJobStatus = { id, action: "export", state: "queued", updatedAt: createdAt };
  await writeJsonAtomic(path.join(paths.status, `${id}.json`), status);
  await writeJsonAtomic(path.join(paths.jobs, `${id}.json`), request);
  return id;
}

type RestoreFileSelection =
  | { kind: "zip"; zip: UploadFile }
  | { kind: "pair"; dump: UploadFile; env: UploadFile };

function classifyRestoreFiles(files: UploadFile[]): RestoreFileSelection {
  const nonEmptyFiles = files.filter((file) => file.size > 0);
  if (nonEmptyFiles.length === 1 && nonEmptyFiles[0].name.toLowerCase().endsWith(".zip")) {
    return { kind: "zip", zip: nonEmptyFiles[0] };
  }

  if (nonEmptyFiles.length === 2) {
    const dump = nonEmptyFiles.find((file) => file.name.toLowerCase().endsWith(".dump"));
    const env = nonEmptyFiles.find((file) => file.name.toLowerCase().endsWith(".env"));
    if (dump && env) return { kind: "pair", dump, env };
  }

  throw new Error("请选择一个 .zip，或同时选择一个 .dump 和一个 .env 文件。");
}

export async function createRestoreJob(requestedBy: string, files: UploadFile[], mode: RestoreMode = "data"): Promise<string> {
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  if (totalBytes <= 0) throw new Error("备份文件不能为空。");
  if (totalBytes > MAX_BACKUP_UPLOAD_BYTES) throw new Error("备份文件总大小不能超过 256 MiB。");

  const selection = classifyRestoreFiles(files);
  if (mode === "full" && selection.kind !== "zip") {
    throw new Error("完整迁移仅支持完整备份 ZIP 文件。");
  }
  const paths = await ensureManagerDirectories();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const action: BackupJobAction = mode === "full" ? "migrate" : "restore";
  const request: BackupJobRequest = { id, action, requestedBy, createdAt };

  if (selection.kind === "zip") {
    const fileName = `${id}.zip`;
    await writeFile(path.join(paths.uploads, fileName), Buffer.from(await selection.zip.arrayBuffer()), { mode: 0o600 });
    request.inputZip = fileName;
  } else {
    const dumpName = `${id}.dump`;
    const envName = `${id}.env`;
    await writeFile(path.join(paths.uploads, dumpName), Buffer.from(await selection.dump.arrayBuffer()), { mode: 0o600 });
    await writeFile(path.join(paths.uploads, envName), Buffer.from(await selection.env.arrayBuffer()), { mode: 0o600 });
    request.inputDump = dumpName;
    request.inputEnv = envName;
  }

  const status: BackupJobStatus = { id, action, state: "queued", updatedAt: createdAt };
  await writeJsonAtomic(path.join(paths.status, `${id}.json`), status);
  await writeJsonAtomic(path.join(paths.jobs, `${id}.json`), request);
  return id;
}

export async function readBackupJobStatus(id: string): Promise<BackupJobStatus | null> {
  if (!isBackupJobId(id)) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(backupManagerPaths().status, `${id}.json`), "utf8")) as Partial<BackupJobStatus>;
    if (
      parsed.id !== id ||
      (parsed.action !== "export" && parsed.action !== "restore" && parsed.action !== "migrate") ||
      !["queued", "running", "succeeded", "failed"].includes(String(parsed.state)) ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as BackupJobStatus;
  } catch {
    return null;
  }
}

export async function getExportDownload(id: string): Promise<{ filePath: string; fileName: string } | null> {
  const status = await readBackupJobStatus(id);
  if (!status || status.action !== "export" || status.state !== "succeeded" || !status.outputFile) return null;
  if (!isSafeManagerFilename(status.outputFile) || !status.outputFile.toLowerCase().endsWith(".zip")) return null;
  const filePath = path.join(backupManagerPaths().exports, status.outputFile);
  try {
    const info = await stat(filePath);
    return info.isFile() ? { filePath, fileName: status.outputFile } : null;
  } catch {
    return null;
  }
}
