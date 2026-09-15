import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import { readBackupJobStatus } from "@local/lib/backup-manager";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  return withCurrentAdmin(async () => {
    const { id } = await params;
    const status = await readBackupJobStatus(id);
    if (!status) return apiError("Backup job not found.", "NOT_FOUND", 404);
    return json({
      ...status,
      ...(status.action === "export" && status.state === "succeeded"
        ? { downloadUrl: `/api/backups/download/${encodeURIComponent(id)}` }
        : {}),
    });
  });
}
