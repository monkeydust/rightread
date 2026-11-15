import { defineConfig, devices } from "@playwright/test";

/**
 * Run by tests/e2e/run.sh inside the Playwright container, which shares the
 * app container's network: the app is at 127.0.0.1:3000, an origin where
 * Chromium treats http as secure and so registers the service worker.
 */

const token = process.env.E2E_SESSION_TOKEN;
if (!token) throw new Error("E2E_SESSION_TOKEN is not set. Use tests/e2e/run.sh.");

export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.spec.mjs",
  outputDir: process.env.E2E_OUT ? `${process.env.E2E_OUT}/results` : "./test-results",
  // One browser at a time against one database: the tests share a library
  // and a fixture server, and a phone has one user.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    // A Pixel-class phone: viewport, touch, mobile user agent.
    ...devices["Pixel 7"],
    // Full Chromium in its new headless mode, not the cut-down "headless
    // shell": the shell refuses notification permission outright.
    channel: "chromium",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Signed in, as the seeded user. Auth.js names the cookie without the
    // __Secure- prefix over http. A test that needs to be signed out
    // overrides this with an empty state.
    storageState: {
      cookies: [
        {
          name: "authjs.session-token",
          value: token,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  },
  projects: [{ name: "phone-chromium" }],
});
