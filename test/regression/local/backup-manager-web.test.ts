import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@local/lib/api-auth", () => ({
  withCurrentAdmin: async (handler: (admin: { id: string; username: string }) => Response | Promise<Response>) =>
    handler({ id: "admin-1", username: "admin" }),
}));

import {
  backupManagerPaths,
  createExportJob,
  createRestoreJob,
  getExportDownload,
  isBackupJobId,
  managerAgentAvailable,
  MAX_BACKUP_UPLOAD_BYTES,
  readBackupJobStatus,
} from "../../../local/src/lib/backup-manager";
import { GET as statusGET } from "../../../local/app/api/backups/status/route";
import { POST as exportPOST } from "../../../local/app/api/backups/export/route";
import { POST as restorePOST } from "../../../local/app/api/backups/restore/route";
import { GET as jobGET } from "../../../local/app/api/backups/jobs/[id]/route";
import { GET as downloadGET } from "../../../local/app/api/backups/download/[id]/route";

async function jsonResponse(response: Response) {
  return { status: response.status, body: await response.json() };
}

function namedFile(name: string, content: string) {
  return new File([content], name, { type: "application/octet-stream" });
}

function createdAtForTest() {
  return "2026-09-15T00:00:00.000Z";
}

describe("web backup manager", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "subboost-manager-test-"));
    vi.stubEnv("SUBBOOST_MANAGER_DATA_DIR", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds manager paths, validates job ids, and detects heartbeat freshness", async () => {
    const paths = backupManagerPaths();
    expect(paths).toEqual({
      root,
      jobs: path.join(root, "jobs"),
      uploads: path.join(root, "uploads"),
      exports: path.join(root, "exports"),
      status: path.join(root, "status"),
      heartbeat: path.join(root, "agent-heartbeat"),
    });
    vi.stubEnv("SUBBOOST_MANAGER_DATA_DIR", "   ");
    expect(backupManagerPaths().root).toBe("/var/lib/subboost-manager");
    vi.stubEnv("SUBBOOST_MANAGER_DATA_DIR", root);
    expect(isBackupJobId("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isBackupJobId("../bad")).toBe(false);
    await expect(managerAgentAvailable()).resolves.toBe(false);
    await writeFile(paths.heartbeat, "ok\n");
    await expect(managerAgentAvailable()).resolves.toBe(true);
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.heartbeat, old, old);
    await expect(managerAgentAvailable()).resolves.toBe(false);
  });

  it("queues export jobs and reads only valid status payloads", async () => {
    const id = await createExportJob("admin-1");
    expect(isBackupJobId(id)).toBe(true);
    const paths = backupManagerPaths();
    const request = JSON.parse(await readFile(path.join(paths.jobs, `${id}.json`), "utf8"));
    expect(request).toMatchObject({ id, action: "export", requestedBy: "admin-1" });
    await expect(readBackupJobStatus(id)).resolves.toMatchObject({ id, action: "export", state: "queued" });
    await expect(readBackupJobStatus("bad")).resolves.toBeNull();

    for (const invalidStatus of [
      {},
      { id, action: "invalid", state: "queued", updatedAt: createdAtForTest() },
      { id, action: "export", state: "invalid", updatedAt: createdAtForTest() },
      { id, action: "export", state: "queued", updatedAt: 123 },
    ]) {
      await writeFile(path.join(paths.status, `${id}.json`), `${JSON.stringify(invalidStatus)}\n`);
      await expect(readBackupJobStatus(id)).resolves.toBeNull();
    }
    await writeFile(path.join(paths.status, `${id}.json`), "not-json\n");
    await expect(readBackupJobStatus(id)).resolves.toBeNull();
  });

  it("queues ZIP and dump+env restore jobs and rejects invalid uploads", async () => {
    const zipId = await createRestoreJob("admin-1", [namedFile("backup.ZIP", "zip-data")]);
    const paths = backupManagerPaths();
    const zipRequest = JSON.parse(await readFile(path.join(paths.jobs, `${zipId}.json`), "utf8"));
    expect(zipRequest).toMatchObject({ id: zipId, action: "restore", inputZip: `${zipId}.zip` });
    expect(await readFile(path.join(paths.uploads, `${zipId}.zip`), "utf8")).toBe("zip-data");

    const pairId = await createRestoreJob("admin-2", [
      namedFile("old.dump", "dump-data"),
      namedFile("old.env", "ENCRYPTION_KEY=key"),
    ]);
    const pairRequest = JSON.parse(await readFile(path.join(paths.jobs, `${pairId}.json`), "utf8"));
    expect(pairRequest).toMatchObject({ inputDump: `${pairId}.dump`, inputEnv: `${pairId}.env` });

    await expect(createRestoreJob("admin", [])).rejects.toThrow("不能为空");
    await expect(createRestoreJob("admin", [namedFile("bad.txt", "x")])).rejects.toThrow("请选择一个 .zip");
    await expect(createRestoreJob("admin", [namedFile("one.dump", "x"), namedFile("two.dump", "y")])).rejects.toThrow(
      "请选择一个 .zip",
    );
    const oversized = {
      name: "huge.zip",
      size: MAX_BACKUP_UPLOAD_BYTES + 1,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    };
    await expect(createRestoreJob("admin", [oversized])).rejects.toThrow("256 MiB");
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });

  it("resolves export downloads only for safe successful export jobs", async () => {
    const id = await createExportJob("admin-1");
    const paths = backupManagerPaths();
    await mkdir(paths.exports, { recursive: true });
    const outputFile = "subboost-backup-test.zip";
    await writeFile(path.join(paths.exports, outputFile), "zip-body");
    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile, updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getExportDownload(id)).resolves.toEqual({ filePath: path.join(paths.exports, outputFile), fileName: outputFile });

    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile: "../secret.zip", updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getExportDownload(id)).resolves.toBeNull();

    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "restore", state: "succeeded", outputFile, updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getExportDownload(id)).resolves.toBeNull();

    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile: "backup.txt", updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getExportDownload(id)).resolves.toBeNull();

    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile: "missing.zip", updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getExportDownload(id)).resolves.toBeNull();
  });

  it("serves agent status and export jobs through authenticated API routes", async () => {
    expect(await jsonResponse(await statusGET())).toEqual({ status: 200, body: { available: false } });
    expect(await jsonResponse(await exportPOST())).toEqual({
      status: 503,
      body: { error: "Backup manager agent is unavailable.", code: "CONFIGURATION_ERROR" },
    });
    expect(
      await jsonResponse(
        await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: new FormData() })),
      ),
    ).toEqual({
      status: 503,
      body: { error: "Backup manager agent is unavailable.", code: "CONFIGURATION_ERROR" },
    });

    const paths = backupManagerPaths();
    await writeFile(paths.heartbeat, "ok\n");
    const queued = await jsonResponse(await exportPOST());
    expect(queued.status).toBe(202);
    const id = (queued.body as { jobId: string }).jobId;
    expect(isBackupJobId(id)).toBe(true);

    expect(await jsonResponse(await jobGET(new Request("https://local.test"), { params: Promise.resolve({ id }) }))).toMatchObject({
      status: 200,
      body: { id, action: "export", state: "queued" },
    });
    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile: "ready.zip", updatedAt: new Date().toISOString() })}\n`,
    );
    expect(await jsonResponse(await jobGET(new Request("https://local.test"), { params: Promise.resolve({ id }) }))).toMatchObject({
      status: 200,
      body: { id, action: "export", state: "succeeded", downloadUrl: `/api/backups/download/${id}` },
    });
    expect(await jsonResponse(await jobGET(new Request("https://local.test"), { params: Promise.resolve({ id: "bad" }) }))).toEqual({
      status: 404,
      body: { error: "Backup job not found.", code: "NOT_FOUND" },
    });
  });

  it("accepts restore uploads and rejects malformed or oversized HTTP requests", async () => {
    const paths = backupManagerPaths();
    await writeFile(paths.heartbeat, "ok\n");

    const form = new FormData();
    form.append("files", namedFile("backup.zip", "zip-data"));
    const accepted = await jsonResponse(await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: form })));
    expect(accepted.status).toBe(202);
    expect(isBackupJobId((accepted.body as { jobId: string }).jobId)).toBe(true);

    const pair = new FormData();
    pair.append("files", namedFile("backup.dump", "dump"));
    pair.append("files", namedFile("backup.env", "ENCRYPTION_KEY=backup-encryption-key-123456"));
    expect(
      (await jsonResponse(await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: pair })))).status,
    ).toBe(202);

    const removedFullMode = new FormData();
    removedFullMode.append("mode", "full");
    removedFullMode.append("files", namedFile("complete.zip", "zip-data"));
    expect(
      await jsonResponse(
        await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: removedFullMode })),
      ),
    ).toEqual({ status: 400, body: { error: "Invalid restore mode.", code: "VALIDATION_ERROR" } });

    const empty = new FormData();
    expect(
      await jsonResponse(await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: empty }))),
    ).toEqual({ status: 400, body: { error: "备份文件不能为空。", code: "VALIDATION_ERROR" } });

    const invalid = new FormData();
    invalid.append("files", namedFile("wrong.txt", "x"));
    expect(await jsonResponse(await restorePOST(new Request("https://local.test/api/backups/restore", { method: "POST", body: invalid })))).toEqual({
      status: 400,
      body: { error: "请选择一个 .zip，或同时选择一个 .dump 和一个 .env 文件。", code: "VALIDATION_ERROR" },
    });

    const malformed = await restorePOST(new Request("https://local.test/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=broken" },
      body: "broken",
    }));
    expect(malformed.status).toBe(400);

    const tooLarge = await restorePOST(new Request("https://local.test/api/backups/restore", {
      method: "POST",
      headers: { "content-length": String(MAX_BACKUP_UPLOAD_BYTES + 1024 * 1024 + 1) },
      body: "x",
    }));
    expect(tooLarge.status).toBe(413);
  });

  it("streams completed export ZIP files and rejects missing downloads", async () => {
    const paths = backupManagerPaths();
    const id = await createExportJob("admin-1");
    await mkdir(paths.exports, { recursive: true });
    const outputFile = "subboost-backup-stream.zip";
    await writeFile(path.join(paths.exports, outputFile), "ZIP-CONTENT");
    await writeFile(
      path.join(paths.status, `${id}.json`),
      `${JSON.stringify({ id, action: "export", state: "succeeded", outputFile, updatedAt: new Date().toISOString() })}\n`,
    );

    const response = await downloadGET(new Request("https://local.test"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(outputFile);
    expect(await response.text()).toBe("ZIP-CONTENT");

    const missing = await downloadGET(new Request("https://local.test"), { params: Promise.resolve({ id: "bad" }) });
    expect(missing.status).toBe(404);
  });
});
