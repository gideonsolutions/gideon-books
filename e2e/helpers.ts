import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct horse battery staple";

export function uniqueEmail(prefix = "e2e") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Sign up a new person and create an organization; returns its slug. */
export async function signUpWithOrg(page: Page, opts: { name?: string; template?: string } = {}): Promise<{ email: string; slug: string }> {
  const email = uniqueEmail();
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("E2E Person");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/orgs/new");
  await page.getByLabel("Organization name").fill(opts.name ?? `E2E Co ${Date.now()}`);
  if (opts.template) await page.getByLabel(new RegExp(opts.template, "i")).check();
  await page.getByRole("button", { name: "Create and continue" }).click();
  await page.waitForURL("**/onboarding");
  const slug = new URL(page.url()).pathname.split("/")[2]!;
  return { email, slug };
}

export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
}

/** Fail the test on any uncaught page error (hydration errors included). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

export async function expectNoErrors(errors: string[]) {
  expect(errors, errors.join("\n")).toEqual([]);
}
