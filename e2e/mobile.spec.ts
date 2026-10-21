import { expect, test } from "@playwright/test";
import { signUpWithOrg } from "./helpers";

test("the navigation works on a phone", async ({ page }) => {
  const { slug } = await signUpWithOrg(page);
  await page.goto(`/o/${slug}`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Accounting" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Chart of accounts" }).click();
  await expect(page.getByRole("heading", { name: "Chart of accounts" })).toBeVisible();
  // No horizontal scrolling of the page itself.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
