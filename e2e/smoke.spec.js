import { test, expect } from "@playwright/test";

// Smoke test: the signed-out screen is the first thing every visitor sees.
// If the bundle is broken or the app throws on mount, none of this renders.
test("app boots and shows the signed-out welcome screen", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  // Heading renders → React mounted and the Supabase client initialized.
  await expect(page.getByRole("heading", { name: /Welcome to Ankora/i })).toBeVisible();

  // Sign-in affordance is present.
  await expect(page.locator('input[type="email"]')).toBeVisible();

  // Legal links are wired up.
  await expect(page.getByRole("link", { name: /Privacy/i })).toBeVisible();

  // No uncaught exceptions during boot.
  expect(errors, `page errors:\n${errors.join("\n")}`).toHaveLength(0);
});
