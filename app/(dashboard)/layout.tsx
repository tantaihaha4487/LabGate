import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { auth, isAllowedInstitutionEmail } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session || !isAllowedInstitutionEmail(session.user.email)) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="font-bold">LabGate</p>
            <p className="text-xs text-slate-500">{session.user.email}</p>
          </div>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
