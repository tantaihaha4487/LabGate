import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("visible machine and newest activity pages share non-overlapping two-second polling", () => {
  const hook = readFileSync(
    resolve("components/use-visible-polling.ts"),
    "utf8",
  );
  const machinePicker = readFileSync(
    resolve("components/machine-picker.tsx"),
    "utf8",
  );
  const adminDashboard = readFileSync(
    resolve("components/admin-dashboard.tsx"),
    "utf8",
  );
  const activityLog = readFileSync(
    resolve("components/admin-activity-log.tsx"),
    "utf8",
  );

  assert.match(hook, /VISIBLE_POLL_INTERVAL_MS = 2_000/);
  assert.match(hook, /document\.visibilityState !== "visible"/);
  assert.match(hook, /addEventListener\("visibilitychange"/);
  assert.match(hook, /if \(running\)/);
  assert.match(hook, /await pollRef\.current\(\)/);
  assert.match(hook, /scheduleNextPoll\(\)/);
  assert.doesNotMatch(hook, /setInterval/);

  assert.match(machinePicker, /useVisiblePolling\(\(\) => loadMachines\(true\)\)/);
  assert.match(adminDashboard, /useVisiblePolling\(\(\) => loadMachines\(true\)\)/);
  assert.match(
    activityLog,
    /useVisiblePolling\([\s\S]*cursorStack\.length === 1/,
  );
  assert.match(
    activityLog,
    /requestPage\(appliedFilters, undefined, \[undefined\], true\)/,
  );
});
