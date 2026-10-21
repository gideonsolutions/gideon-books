import { expect, test } from "@playwright/test";
import { expectNoErrors, signUpWithOrg, watchErrors } from "./helpers";

test("sign up, create an organization, post and reverse a journal entry, close a period", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page, { name: "E2E Ledger Co" });
  await expect(page.getByRole("heading", { name: /Set up E2E Ledger Co/ })).toBeVisible();

  // A journal entry, balanced, posted.
  await page.goto(`/o/${slug}/accounting/journal/new`);
  await page.getByLabel("Posting date").fill("2026-01-15");
  await page.getByLabel(/^Description/).first().fill("Owner investment");
  await page.getByLabel("Line 1 account").selectOption({ label: "1000 · Checking" });
  await page.getByLabel("Line 1 debit").fill("1000");
  await page.getByLabel("Line 2 account").selectOption({ label: "3100 · Owner Contributions" });
  await page.getByLabel("Line 2 credit").fill("1000");
  await expect(page.getByText("Balanced.")).toBeVisible();
  await page.getByRole("button", { name: "Post entry" }).click();
  await page.waitForURL(/\/accounting\/journal\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Entry #1/ })).toBeVisible();

  // Reverse it with a reason.
  await page.getByRole("button", { name: "Reverse" }).click();
  await page.getByLabel("Reversal date").fill("2026-01-16");
  await page.getByLabel("Why is it being reversed?").fill("Recorded twice");
  await page.getByRole("button", { name: "Post reversal" }).click();
  await page.waitForURL(/\/accounting\/journal\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/Reverses/)).toBeVisible();

  // Close January.
  await page.goto(`/o/${slug}/accounting/periods`);
  await page.getByRole("link", { name: "Checklist" }).first().click();
  await page.getByLabel("I have reviewed the items above and want to close anyway.").check().catch(() => {});
  await page.getByRole("button", { name: "Close the period" }).click();
  await expect(page.getByText("Period closed.")).toBeVisible();

  // Posting into January is now refused, with an explanation.
  await page.goto(`/o/${slug}/accounting/journal/new`);
  await page.getByLabel("Posting date").fill("2026-01-20");
  await page.getByLabel(/^Description/).first().fill("Late");
  await page.getByLabel("Line 1 account").selectOption({ label: "1000 · Checking" });
  await page.getByLabel("Line 1 debit").fill("5");
  await page.getByLabel("Line 2 account").selectOption({ label: "3100 · Owner Contributions" });
  await page.getByLabel("Line 2 credit").fill("5");
  await page.getByRole("button", { name: "Post entry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "closed" })).toBeVisible();
  await expectNoErrors(errors);
});

test("settings: invite a member and create an API token", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page);
  await page.goto(`/o/${slug}/settings/members`);
  await page.getByLabel("Email").fill("accountant@example.test");
  await page.getByLabel("Role").last().selectOption("accountant");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText(/share this link/)).toBeVisible();
  await page.goto(`/o/${slug}/settings/api`);
  await page.getByLabel("Name").fill("Spreadsheet sync");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("Copy the token now")).toBeVisible();
  await expectNoErrors(errors);
});

test("a demonstration company is clearly labeled", async ({ page }) => {
  const errors = watchErrors(page);
  await signUpWithOrg(page);
  await page.goto("/orgs");
  await page.getByRole("button", { name: "Try a demonstration company" }).click();
  await page.waitForURL(/\/o\/harbor-pine-supply/, { timeout: 60_000 });
  await expect(page.getByRole("note")).toContainText("Demonstration company");
  await expect(page.getByText("Owed to you")).toBeVisible();
  await expectNoErrors(errors);
});
