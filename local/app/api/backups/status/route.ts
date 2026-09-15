import { withCurrentAdmin } from "@local/lib/api-auth";
import { json } from "@local/lib/http";
import { managerAgentAvailable } from "@local/lib/backup-manager";

export async function GET() {
  return withCurrentAdmin(async () => json({ available: await managerAgentAvailable() }));
}
