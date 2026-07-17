import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminActivityLog } from "@/components/admin-activity-log";
import {
  adminPageRedirectForAuthorization,
  getAdminAuthorization,
} from "@/lib/admin-authorization";
import { listAdminActivity } from "@/lib/admin-activity";

export default async function AdminLogsPage() {
  // Keep this authorization independent from the dashboard layout before any
  // activity data is loaded.
  const authorization = await getAdminAuthorization(await headers());
  const redirectDestination = adminPageRedirectForAuthorization(
    authorization.status,
  );
  if (redirectDestination) {
    redirect(redirectDestination);
  }

  const initialPage = await listAdminActivity({
    source: "all",
    action: "all",
  });

  return <AdminActivityLog initialPage={initialPage} />;
}
