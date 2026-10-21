// Screenshot a list of pages for a signed-in user (dev aid).
import { chromium } from "@playwright/test";
const [sp, slug, ...paths] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://localhost:3200/sign-in");
await page.getByLabel("Email").fill(process.env.SHOT_EMAIL);
await page.getByLabel("Password").fill("correct horse battery staple");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
for (const p of paths) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto(`http://localhost:3200/o/${slug}${p}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const name = p.replace(/[^a-z0-9]+/gi, "_") || "root";
  await page.screenshot({ path: `${sp}/${name}.png`, fullPage: true });
  console.log(p, res?.status(), errors.length ? errors.join(" | ") : "");
}
await browser.close();
