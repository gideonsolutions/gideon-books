import { chromium } from "@playwright/test";
const [sp] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
for (const [name, vp] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto("http://localhost:3399/#products");
  await page.waitForTimeout(500);
  const card = page.getByRole("link", { name: /Gideon Books/ }).first();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${sp}/site-${name}.png` });
  console.log(name, await page.locator("text=products live").first().textContent());
  await page.close();
}
await browser.close();
