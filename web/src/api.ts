import { useCallback, useEffect, useRef, useState } from "react";
export type Reservation = {
  id: string;
  studentEmail: string;
  state: "pending" | "active";
  createdAt: string;
  expiresAt: string;
  sessionOpenedAt: string | null;
  machineStateVersion: number;
};
export type Machine = {
  id: string;
  name: string;
  status: string;
  connectivity: string;
  lastHeartbeat: string | null;
  isHidden?: boolean;
  tailscaleIp?: string;
  sshHostKeySha256?: string | null;
  safetyHoldCredentialId?: string | null;
  currentReservation?: Reservation | null;
};
export type Session = {
  user: { email: string; name: string };
  isAdmin: boolean;
  csrfToken: string;
  adminEmails: string[] | null;
};
export type Entry = {
  id: string;
  source: string;
  action: string;
  status: string;
  email: string;
  occurredAt: string;
  machine: { id: string; name: string } | null;
};
export type Page = {
  entries: Entry[];
  nextCursor: string | null;
  serverTime: string;
};
let csrf = "";
export function setCSRF(v: string) {
  csrf = v;
}
export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const data = await r
    .json()
    .catch(() => ({ error: "Unexpected server response" }));
  if (!r.ok)
    throw new APIError(r.status, data.error ?? `Request failed (${r.status})`);
  return data as T;
}
export function usePolling<T>(path: string, enabled = true, interval = 2000) {
  const [state, setState] = useState<{ path: string; data?: T; error: string }>(
    { path: "", error: "" },
  );
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let disposed = false,
      pending = false;
    const controller = new AbortController();
    async function load() {
      if (disposed || pending || !enabled || document.hidden) return;
      pending = true;
      try {
        const data = await api<T>(
          path,
          "GET",
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        );
        if (!disposed) setState({ path, data, error: "" });
      } catch (e) {
        if (!disposed)
          setState((previous) => ({
            path,
            data: previous.path === path ? previous.data : undefined,
            error: e instanceof Error ? e.message : "Request failed",
          }));
      } finally {
        pending = false;
      }
    }
    refreshRef.current = load;
    void load();
    const id = setInterval(() => void load(), interval);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, enabled, interval]);
  return {
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error : "",
    loading: enabled && state.path !== path,
    refresh,
  };
}
