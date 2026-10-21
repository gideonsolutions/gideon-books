import { expect, test } from "@playwright/test";
import { expectNoErrors, signUpWithOrg, watchErrors } from "./helpers";

const CSV = ["Date,Description,Amount", "2026-01-05,Monthly service fee,-12.00", "2026-01-08,Mobile deposit,251.00", "2026-01-09,Coffee,-4.50", "2026-01-09,Coffee,-4.50", ""].join("\n");

test("import a statement, see duplicates refused, categorize a fee", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page, { name: "E2E Bank Co" });

  const importOnce = async () => {
    await page.goto(`/o/${slug}/banking/imports/new`);
    await page.getByLabel("Account").selectOption({ label: "1000 · Checking" });
    await page.getByLabel("Statement file (CSV)").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
    await page.getByRole("button", { name: "Preview" }).click();
  };

  await importOnce();
  // Two identical coffee rows in one file are both kept.
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await page.waitForURL(/\/banking\/imports\/[0-9a-f-]{36}$/);

  // The same file again brings in nothing new.
  await importOnce();
  await expect(page.getByRole("button", { name: /Import 0 transactions/ })).toBeDisabled();

  await page.goto(`/o/${slug}/banking/transactions`);
  const feeRow = page.getByRole("row", { name: /Monthly service fee/ });
  await feeRow.getByRole("link", { name: "Review" }).click();
  await page.getByText("Categorize", { exact: true }).click();
  await page.getByLabel("Category 1").selectOption({ label: "6900 · Bank Charges" });
  await page.getByRole("button", { name: "Categorize and post" }).click();
  await expect(page.getByText("Categorized as")).toBeVisible();
  await expectNoErrors(errors);
});
