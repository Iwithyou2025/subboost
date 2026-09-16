import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import {
  createRestoreJob,
  managerAgentAvailable,
  MAX_BACKUP_UPLOAD_BYTES,
} from "@local/lib/backup-manager";

export async function POST(request: Request) {
  return withCurrentAdmin(async (admin) => {
    if (!(await managerAgentAvailable())) {
      return apiError("Backup manager agent is unavailable.", "CONFIGURATION_ERROR", 503);
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKUP_UPLOAD_BYTES + 1024 * 1024) {
      return apiError("Backup upload is too large.", "PAYLOAD_TOO_LARGE", 413);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return apiError("Invalid backup upload.", "BAD_REQUEST", 400);
    }

    const files = formData.getAll("files").filter((value): value is File => value instanceof File);
    const modeValue = formData.get("mode");
    if (modeValue !== null && modeValue !== "data") {
      return apiError("Invalid restore mode.", "VALIDATION_ERROR", 400);
    }
    try {
      return json({ jobId: await createRestoreJob(admin.id, files) }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backup upload.";
      const status = message.includes("256 MiB") ? 413 : 400;
      return apiError(message, status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR", status);
    }
  });
}
