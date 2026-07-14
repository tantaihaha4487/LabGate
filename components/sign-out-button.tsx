"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setError(undefined);
    setPending(true);

    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError(result.error.message ?? "Sign-out failed.");
        return;
      }
      location.assign("/login");
    } catch {
      setError("Could not sign out. Check your connection and retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p role="alert" className="mt-1 max-w-56 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
