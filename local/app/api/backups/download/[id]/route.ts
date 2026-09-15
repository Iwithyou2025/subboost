import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError } from "@local/lib/http";
import { getExportDownload } from "@local/lib/backup-manager";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  return withCurrentAdmin(async () => {
    const { id } = await params;
    const download = await getExportDownload(id);
    if (!download) return apiError("Backup export not found.", "NOT_FOUND", 404);
    const info = await stat(download.filePath);
    const body = Readable.toWeb(createReadStream(download.filePath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${download.fileName}"`,
        "Content-Length": String(info.size),
        "Content-Type": "application/zip",
      },
    });
  });
}
