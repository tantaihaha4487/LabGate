"use client";

import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => location.assign("/login") } })}
      className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
    >
      Sign out
    </button>
  );
}
