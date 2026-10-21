import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks of the main workflows against a running server
 * (E2E_BASE_URL, default http://localhost:3200). In CI the server is built
 * and started by `webServer`; locally, run `npm run dev` (or `npm start`)
 * first. PW_CHANNEL=chrome uses an installed Chrome instead of downloading
 * Playwright's Chromium.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) }, testMatch: /mobile\.spec\.ts/ },
  ],
  ...(process.env.E2E_START_SERVER ? { webServer: { command: "npm run start", url: `${baseURL}/api/health`, reuseExistingServer: true, timeout: 120_000 } } : {}),
});
