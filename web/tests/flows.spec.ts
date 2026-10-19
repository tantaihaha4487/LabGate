import { test, expect } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  await request.get("/__fixture/reset");
});
test("login screen, theme, and protected admin page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});
test("student checkout, one-time credential, and expiration", async ({
  page,
  request,
}) => {
  await page.clock.install();
  await page.goto("/__fixture/login?role=student");
  await expect(
    page.getByRole("heading", { name: "Find your next seat." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reserve desktop" }).click();
  await expect(
    page.getByText("Temporary password", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Login within")).toBeVisible();
  await request.get("/__fixture/expire");
  await page.clock.runFor(181000);
  await expect(
    page.getByText("Temporary password", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText("Your login window has ended.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Temporary password", { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
});
test("admin visibility, activity filters, enrollment, and pairing", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/__fixture/login?role=admin");
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Every desktop. One place." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Hide", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clear picture of your lab." }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Activity source" }).click();
  await page.getByRole("option", { name: "physical", exact: true }).click();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await page.getByRole("button", { name: "Enrollment", exact: true }).click();
  await page.getByLabel("Machine name", { exact: true }).fill("Desktop 02");
  await page.getByLabel("Tailscale IPv4", { exact: true }).fill("100.64.0.2");
  await page
    .getByLabel("Ed25519 SSH host-key fingerprint", { exact: true })
    .fill("SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA");
  await page
    .getByRole("button", { name: "Register desktop", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Enrollment token", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Administrators", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Generate configuration line", exact: true })
    .click();
  await expect(
    page.getByText("ADMIN_EMAILS=admin@ubu.ac.th", { exact: true }),
  ).toBeVisible();
  const secret = "test-only-pairing-secret-abcdefghijklmnopqrstuvwxyz";
  const start = await request.post("/api/cli/start", { data: { secret } });
  const pairing = await start.json();
  await page.goto("/cli/approve");
  await page.getByLabel("Pairing code").fill(pairing.code);
  await page.getByRole("button", { name: "Approve terminal" }).click();
  await expect(
    page.getByText("Approved. Return to your terminal."),
  ).toBeVisible();
  const poll = await request.post("/api/cli/poll", {
    data: { id: pairing.id, secret },
  });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).token).toBeTruthy();
  expect(errors).toEqual([]);
});
test("mobile admin navigation and enrollment layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__fixture/login?role=admin");
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await page.getByRole("button", { name: "Enrollment", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bring a desktop into your lab." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("refresh failures preserve inventory and recover", async ({ page }) => {
  await page.goto("/__fixture/login?role=admin");
  await page.goto("/admin");
  await expect(
    page.getByText("Desktop 01", { exact: true }).first(),
  ).toBeVisible();
  await page.route("**/api/admin/machines", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary inventory failure" }),
    }),
  );
  await expect(page.getByText("Temporary inventory failure")).toBeVisible({
    timeout: 10000,
  });
  await expect(
    page.getByText("Desktop 01", { exact: true }).first(),
  ).toBeVisible();
  await page.unroute("**/api/admin/machines");
  await expect(page.getByText("Temporary inventory failure")).not.toBeVisible({
    timeout: 10000,
  });
});
