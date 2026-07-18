"use client";

import { useEffect, useRef } from "react";

export const VISIBLE_POLL_INTERVAL_MS = 2_000;

export function useVisiblePolling(
  poll: () => Promise<void>,
  enabled = true,
): void {
  const pollRef = useRef(poll);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let running = false;
    let rerunWhenReady = false;
    let timeout: number | undefined;

    function clearScheduledPoll() {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        timeout = undefined;
      }
    }

    function scheduleNextPoll() {
      clearScheduledPoll();
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      timeout = window.setTimeout(() => {
        timeout = undefined;
        void pollNow();
      }, VISIBLE_POLL_INTERVAL_MS);
    }

    async function pollNow() {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      if (running) {
        rerunWhenReady = true;
        return;
      }

      running = true;
      try {
        await pollRef.current();
      } catch {
        // Background refresh failures must not stop later polling attempts.
      } finally {
        running = false;
        if (cancelled || document.visibilityState !== "visible") {
          return;
        }
        if (rerunWhenReady) {
          rerunWhenReady = false;
          void pollNow();
          return;
        }
        scheduleNextPoll();
      }
    }

    function handleVisibilityChange() {
      clearScheduledPoll();
      if (document.visibilityState !== "visible") {
        rerunWhenReady = false;
        return;
      }
      if (running) {
        rerunWhenReady = true;
        return;
      }
      void pollNow();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextPoll();

    return () => {
      cancelled = true;
      clearScheduledPoll();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled]);
}
