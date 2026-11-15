import { test, expect } from "@playwright/test";
import { NEWS, SIGNED_OUT } from "./support.mjs";

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  test("the queue sends you to the sign-in page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  });

  test("a share while signed out keeps the link through sign-in", async ({ page }) => {
    const link = `${NEWS}/articles/shared-while-signed-out`;
    await page.goto(`/share?url=${encodeURIComponent(link)}`);
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
    const callback = new URL(page.url()).searchParams.get("callbackUrl");
    expect(callback).toContain("/share?");
    expect(decodeURIComponent(callback)).toContain(link);
  });

  test("the API refuses without a session", async ({ request }) => {
    expect((await request.get("/api/items")).status()).toBe(401);
    expect((await request.post("/api/tokens", { data: {} })).status()).toBe(401);
    expect((await request.post("/api/capture", { data: { url: `${NEWS}/articles/nope` } })).status()).toBe(401);
  });
});

test("signed in, the queue loads with the paste box", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
  await expect(page.getByPlaceholder("Search, or paste a link to save")).toBeVisible();
  await expect(page.getByRole("link", { name: "rightread — go to queue" })).toBeVisible();
});

test("the service worker installs and takes control", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 30_000 });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe("http://127.0.0.1:3000/");
});
