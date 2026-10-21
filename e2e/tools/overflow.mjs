// Report which elements stick out past the viewport on a page, at phone width.
import { chromium } from "@playwright/test";
const [slug, email, ...paths] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:3200/sign-in");
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill("correct horse battery staple");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
for (const p of paths) {
  await page.goto(`http://localhost:3200/o/${slug}${p}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const sw = document.documentElement.scrollWidth;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0) {
        const pr = el.parentElement?.getBoundingClientRect();
        if (pr && pr.right <= vw + 1) out.push(`${el.tagName.toLowerCase()} [${(el.getAttribute("class") ?? "").slice(0, 90)}] right=${Math.round(r.right)} parent=${el.parentElement.tagName.toLowerCase()}[${(el.parentElement.getAttribute("class") ?? "").slice(0, 60)}]`);
      }
    }
    const t = document.querySelector("main table");
    const chain = [];
    for (let e = t; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      chain.push(`${e.tagName.toLowerCase()} w=${Math.round(r.width)} right=${Math.round(r.right)} ox=${cs.overflowX} sw=${e.scrollWidth}`);
    }
    const before = document.documentElement.scrollWidth;
    const wrap = t.parentElement;
    wrap.style.display = "none";
    const hidden = document.documentElement.scrollWidth;
    wrap.style.display = "";
    // Try clipping the cells' selects
    const selects = [...wrap.querySelectorAll("select,input")].map((e) => Math.round(e.getBoundingClientRect().right));
    window.scrollTo(2000, 0);
    const sx = window.scrollX;
    const bodySw = document.body.scrollWidth;
    return { sw, vw, sx, bodySw, before, hidden, selects: selects.slice(0, 8) };
  });
  console.log(p, wide);
}
await browser.close();
