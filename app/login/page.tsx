import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { auth, isAllowedInstitutionEmail } from "@/lib/auth";

export default async function LoginPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (session && isAllowedInstitutionEmail(session.user.email)) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-12">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl shadow-blue-950/30">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-600">
          Ubon Ratchathani University
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-slate-950">
          LabGate
        </h1>
        <p className="mt-4 text-slate-600">
          Sign in with your university Google account to reserve a physical lab
          computer.
        </p>
        <div className="mt-8">
          <GoogleSignInButton />
        </div>
        <p className="mt-5 text-center text-xs text-slate-500">
          Only @ubu.ac.th accounts are accepted.
        </p>
      </section>
    </main>
  );
}
