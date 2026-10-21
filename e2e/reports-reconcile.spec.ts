import { expect, test } from "@playwright/test";
import { expectNoErrors, signUpWithOrg, watchErrors } from "./helpers";

test("reports drill down to the ledger and export the same figures", async ({ page }) => {
  const errors = watchErrors(page);
  await signUpWithOrg(page);
  await page.goto("/orgs");
  await page.getByRole("button", { name: "Try a demonstration company" }).click();
  await page.waitForURL(/\/o\/harbor-pine-supply[^/]*$/, { timeout: 60_000 });
  const slug = new URL(page.url()).pathname.split("/")[2]!;
  const year = new Date().getUTCMonth() >= 4 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;

  await page.goto(`/o/${slug}/reports/profit-and-loss?from=${year}-01-01&to=${year}-04-30&basis=accrual`);
  const netIncome = page.getByRole("row", { name: /^Net income/ });
  await expect(netIncome).toContainText("(8,402.56)");

  // A figure links to the ledger lines behind it.
  await page.getByRole("row", { name: /6550 Rent/ }).getByRole("link").last().click();
  await expect(page).toHaveURL(/general-ledger/);
  await expect(page.getByText("6,000.00").first()).toBeVisible();

  // The CSV export carries the same total.
  const res = await page.request.get(`/o/${slug}/reports/profit-and-loss/export?format=csv&from=${year}-01-01&to=${year}-04-30&basis=accrual`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("-8402.56");

  // Cash basis is a different, documented set of figures.
  await page.goto(`/o/${slug}/reports/profit-and-loss?from=${year}-01-01&to=${year}-04-30&basis=cash`);
  await expect(page.getByRole("row", { name: /^Net income/ })).toContainText("(8,362.56)");
  await expectNoErrors(errors);
});

test("reconcile a bank account to a statement", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page, { name: "E2E Reconcile Co" });
  await page.goto(`/o/${slug}/accounting/journal/new`);
  await page.getByLabel("Posting date").fill("2026-02-03");
  await page.getByLabel(/^Description/).first().fill("Owner investment");
  await page.getByLabel("Line 1 account").selectOption({ label: "1000 · Checking" });
  await page.getByLabel("Line 1 debit").fill("5000");
  await page.getByLabel("Line 2 account").selectOption({ label: "3100 · Owner Contributions" });
  await page.getByLabel("Line 2 credit").fill("5000");
  await page.getByRole("button", { name: "Post entry" }).click();
  await page.waitForURL(/\/accounting\/journal\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/banking/reconciliations`);
  await page.getByRole("combobox", { name: /^Account/ }).selectOption({ label: "Checking" });
  await page.getByLabel(/^Statement closing date/).fill("2026-02-28");
  await page.getByLabel(/^Statement ending balance/).fill("5000.00");
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/banking\/reconciliations\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Tick shown" }).click();
  await page.getByRole("button", { name: "Finish reconciliation" }).click();
  await expect(page.getByText(/completed/i).first()).toBeVisible();
  await expectNoErrors(errors);
});
