import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { isConfiguredAdminEmail } from "@/lib/admin-authorization";
import { auth, isAllowedInstitutionEmail } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session || !isAllowedInstitutionEmail(session.user.email)) {
    redirect("/login");
  }

  const isAdmin = isConfiguredAdminEmail(session.user.email);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="font-bold">LabGate</p>
            <p className="text-xs text-slate-500">{session.user.email}</p>
          </div>
          <div className="flex items-center gap-3">
            <nav aria-label="Primary" className="flex items-center gap-1">
              <Link
                href="/"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Machines
              </Link>
              {isAdmin ? (
                <Link
                  href="/admin"
                  className="rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                >
                  Admin
                </Link>
              ) : null}
            </nav>
            <SignOutButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
