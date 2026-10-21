import { expect, test } from "@playwright/test";
import { expectNoErrors, signUpWithOrg, watchErrors } from "./helpers";

test("buy stock on a bill, pay it, and see it valued in inventory", async ({ page }) => {
  const errors = watchErrors(page);
  const { slug } = await signUpWithOrg(page, { name: "E2E Purchases Co", template: "Products and inventory" });

  await page.goto(`/o/${slug}/purchases/vendors/new`);
  await page.getByLabel(/^Display name/).fill("Harbor Lumber");
  await page.getByRole("button", { name: "Create vendor" }).click();
  await page.waitForURL(/\/purchases\/vendors\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/inventory/items/new`);
  await page.getByLabel(/Stock product/).check();
  await page.getByLabel(/^Name/).fill("Cedar plank");
  await page.getByLabel(/^Sale price/).fill("12");
  await page.getByRole("button", { name: "Create item" }).click();
  await page.waitForURL(/\/inventory\/items\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/purchases/bills/new`);
  await page.getByRole("combobox", { name: /^Vendor/ }).selectOption({ label: "Harbor Lumber" });
  await page.getByLabel("Line 1 item").selectOption({ label: "Cedar plank (stock)" });
  await page.getByLabel("Line 1 quantity").fill("40");
  await page.getByLabel("Line 1 price").fill("4.25");
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);

  await page.getByRole("link", { name: "Pay bill" }).click();
  await page.getByRole("combobox", { name: /^Paid from/ }).selectOption({ label: "1000 · Checking" });
  await expect(page.getByText(/does not send money/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/purchases\/payments\/[0-9a-f-]{36}$/);

  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByText("$170.00").first()).toBeVisible();
  await expectNoErrors(errors);
});
