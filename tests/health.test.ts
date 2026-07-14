import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/health/route";

test("health identifies the compatible machine-enrollment protocol", async () => {
  const response = await GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "labgate",
    machineEnrollmentVersion: 1,
  });
});
