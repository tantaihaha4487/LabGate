export const HEARTBEAT_STALE_AFTER_MS = 2 * 60 * 1_000;
export const HEARTBEAT_MAX_FUTURE_SKEW_MS = 30 * 1_000;

export function heartbeatEligibilityWindow(now: Date): {
  earliest: Date;
  latest: Date;
} {
  const nowMilliseconds = now.getTime();

  if (!Number.isFinite(nowMilliseconds)) {
    throw new TypeError("A valid liveness reference time is required.");
  }

  return {
    earliest: new Date(nowMilliseconds - HEARTBEAT_STALE_AFTER_MS),
    latest: new Date(nowMilliseconds + HEARTBEAT_MAX_FUTURE_SKEW_MS),
  };
}

export function isHeartbeatEligible(
  lastHeartbeat: Date | null,
  now: Date,
): boolean {
  if (lastHeartbeat === null) {
    return false;
  }

  const { earliest, latest } = heartbeatEligibilityWindow(now);
  const heartbeatMilliseconds = lastHeartbeat.getTime();

  return (
    Number.isFinite(heartbeatMilliseconds) &&
    heartbeatMilliseconds >= earliest.getTime() &&
    heartbeatMilliseconds <= latest.getTime()
  );
}
