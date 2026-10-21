// Visit every page reachable from the navigation (and the first detail link on each list), report failures.
import { chromium } from "@playwright/test";
const [, slug, email] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: process.env.MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://localhost:3200/sign-in");
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill("correct horse battery staple");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
const base = `/o/${slug}`;
await page.goto(`http://localhost:3200${base}`);
import fs from "node:fs";
const navLinks = [...fs.readFileSync(new URL("../../lib/web/nav.ts", import.meta.url), "utf8").matchAll(/href: "(\/[^"]*)"/g)].map((m) => `${base}${m[1]}`);
navLinks.push(`${base}/onboarding`, `${base}/search?q=blue`, `${base}/accounting/accounts/new`, `${base}/accounting/journal/new`);
const queue = [...new Set([`${base}`, ...navLinks.filter((h) => h?.startsWith("/o/"))])];
const seen = new Set();
const problems = [];
let errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
for (let i = 0; i < queue.length && i < 220; i++) {
  const url = queue[i];
  if (seen.has(url)) continue;
  seen.add(url);
  errors = [];
  const res = await page.goto(`http://localhost:3200${url}`).catch((e) => ({ status: () => "ERR " + e.message }));
  await page.waitForLoadState("networkidle").catch(() => {});
  const status = res?.status();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).catch(() => 0);
  if (status !== 200 || errors.length || overflow > 1) problems.push({ url, status, overflow, errors: [...new Set(errors)].slice(0, 3) });
  // One detail link per list page.
  if (navLinks.includes(url)) {
    const detail = await page.$$eval("main table a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => h && /\/[0-9a-f-]{36}$/.test(h)).slice(0, 1)).catch(() => []);
    const actions = await page.$$eval("main a[href$='/new']", (as) => as.map((a) => a.getAttribute("href")).slice(0, 2)).catch(() => []);
    for (const d of [...detail, ...actions]) if (d && !seen.has(d)) queue.push(d);
  }
}
console.log(`visited ${seen.size}`);
console.log(JSON.stringify(problems, null, 1));
await browser.close();
