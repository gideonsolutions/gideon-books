import { expect, test } from "@playwright/test";
import { expectNoErrors, signUpWithOrg, watchErrors } from "./helpers";

test("invoice a customer, take a partial payment, then the rest", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page, { name: "E2E Sales Co" });

  await page.goto(`/o/${slug}/sales/customers/new`);
  await page.getByLabel(/^Display name/).fill("Seaside Bakery");
  await page.getByLabel(/^Email/).fill("ap@seaside.example");
  await page.getByRole("button", { name: "Create customer" }).click();
  await page.waitForURL(/\/sales\/customers\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/sales/invoices/new`);
  await page.getByRole("combobox", { name: /^Customer/ }).selectOption({ label: "Seaside Bakery" });
  await page.getByLabel("Line 1 description").fill("Catering setup");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 price").fill("125.50");
  await expect(page.getByText("$251.00").first()).toBeVisible();
  await page.getByRole("button", { name: "Save and issue" }).click();
  await page.waitForURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Invoice INV-0001/ })).toBeVisible();

  await page.getByRole("link", { name: "Record payment" }).click();
  await page.getByLabel(/^Amount \(USD\)/).fill("100");
  await page.getByLabel(/^Deposit to/).selectOption({ label: "1000 · Checking" });
  await page.getByLabel(/Amount applied to/).first().fill("100");
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/sales\/payments\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/sales/invoices`);
  await expect(page.getByText("Partially paid")).toBeVisible();
  await page.getByRole("link", { name: "INV-0001" }).click();
  await page.getByRole("link", { name: "Record payment" }).click();
  await page.getByLabel(/^Amount \(USD\)/).fill("151");
  await page.getByLabel(/^Deposit to/).selectOption({ label: "1000 · Checking" });
  await page.getByLabel(/Amount applied to/).first().fill("151");
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/sales\/payments\/[0-9a-f-]{36}$/);
  await page.goto(`/o/${slug}/sales/invoices`);
  await expect(page.getByRole("row", { name: /INV-0001/ }).getByText("Paid")).toBeVisible();
  await expectNoErrors(errors);
});
