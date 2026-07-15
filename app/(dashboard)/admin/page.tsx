import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin-dashboard";
import { configuredAdminEmails } from "@/lib/admin-emails";
import {
  adminPageRedirectForAuthorization,
  getAdminAuthorization,
} from "@/lib/admin-authorization";
import { listAdminMachines } from "@/lib/admin-machines";
import { allowedEmailDomain } from "@/lib/auth";

export default async function AdminPage() {
  // Layouts and pages can render in parallel. Authorize here before loading
  // operational data so the page never relies on its parent layout as a gate.
  const authorization = await getAdminAuthorization(await headers());

  const redirectDestination = adminPageRedirectForAuthorization(
    authorization.status,
  );
  if (redirectDestination) {
    redirect(redirectDestination);
  }

  const now = new Date();
  const machines = await listAdminMachines(now);

  return (
    <AdminDashboard
      initialMachines={machines}
      initialServerTime={now.toISOString()}
      admins={configuredAdminEmails()}
      allowedDomain={allowedEmailDomain}
    />
  );
}
