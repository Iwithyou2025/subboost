import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import { createExportJob, managerAgentAvailable } from "@local/lib/backup-manager";

export async function POST() {
  return withCurrentAdmin(async (admin) => {
    if (!(await managerAgentAvailable())) {
      return apiError("Backup manager agent is unavailable.", "CONFIGURATION_ERROR", 503);
    }
    return json({ jobId: await createExportJob(admin.id) }, 202);
  });
}
