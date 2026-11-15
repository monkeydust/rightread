/**
 * The fault of 2026-11-13: the reader went on showing a cached "couldn't be
 * turned into a reader view" page after the item had been fixed on the
 * server. Article pages are served from the service worker's cache, so the
 * page has to notice for itself (ExtractionWatch).
 */

import { test, expect } from "@playwright/test";
import {
  NEWS, share, waitForItem, extracted, failed, pending, row, reader, cached,
  workerInControl, setMode, release, FAILED_TEXT, PENDING_TEXT,
} from "./support.mjs";

/** Saves a page that fails, opens it so the worker caches the failed reader, and returns the item. */
async function failedAndCached(page, path) {
  const link = `${NEWS}${path}`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, failed);

  await page.goto("/");
  await workerInControl(page);
  await page.goto(`/read/${item.id}`);
  await expect(page.getByText(FAILED_TEXT)).toBeVisible();
  await expect(page.getByText("Fetch failed: HTTP 500")).toBeVisible();
  await expect.poll(() => cached(page, `/read/${item.id}`), { message: "the failed page was never cached" }).toBe(true);
  return { link, item };
}

test("a failed page that was cached shows the article once the item is fixed (full open)", async ({ page, context }) => {
  const path = "/flaky/fixed-after-being-opened";
  const { link, item } = await failedAndCached(page, path);
  await page.goto("/");

  // The site recovers, and the link is shared again from another app.
  await setMode(path, "ok");
  const other = await context.newPage();
  expect(await share(other, link)).toBe("Already saved");
  await other.close();
  await waitForItem(page, link, extracted);

  // Opening the article again, as a fresh navigation, starts from the cached
  // failed page. It must end on the article.
  await page.goto(`/read/${item.id}`);
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`);
  await expect(page.getByText(FAILED_TEXT)).toHaveCount(0);
});

test("the same, opened by tapping the row in the queue", async ({ page, context }) => {
  const path = "/flaky/fixed-then-tapped";
  const { link, item } = await failedAndCached(page, path);
  await page.getByRole("link", { name: "← Queue" }).click();
  const inQueue = page.getByRole("listitem").filter({ has: page.locator(`a[href="/read/${item.id}"]`) });
  await expect(inQueue.getByText("couldn't extract")).toBeVisible();

  await setMode(path, "ok");
  const other = await context.newPage();
  expect(await share(other, link)).toBe("Already saved");
  await other.close();
  await waitForItem(page, link, extracted);

  // Coming back from the share sheet brings the app to the front, which is
  // when the queue asks the server again. Headless Chromium has no
  // foreground, so that event is fired by hand.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(inQueue.getByText("couldn't extract")).toHaveCount(0);

  // A tap is a client-side navigation: the worker answers it from its copy
  // of the page's data, which still says "failed".
  await inQueue.locator(`a[href="/read/${item.id}"]`).click();
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`);
  await expect(page.getByText(FAILED_TEXT)).toHaveCount(0);
});

// Found by this suite on 2026-11-15: a save through the share target
// published no live event, because the /share page and the /api/events route
// held separate copies of the listener registry in a production build
// (src/lib/events.ts). Nobody touches the queue here: no reload, no
// foreground event.
test("an open queue shows a share-target save without being touched", async ({ page, context }) => {
  const link = `${NEWS}/articles/saved-while-the-queue-was-open`;
  await page.goto("/");
  await expect(page.getByPlaceholder("Search, or paste a link to save")).toBeVisible();

  const other = await context.newPage();
  expect(await share(other, link)).toBe("Saved to rightread");
  await other.close();
  await waitForItem(page, link, extracted);

  await expect(row(page, /Saved while the queue was open/)).toBeVisible();
});

test("a reader left open while the article is extracted turns into the article", async ({ page }) => {
  const path = "/slow/opened-while-extracting";
  const link = `${NEWS}${path}`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, pending);

  await page.goto(`/read/${item.id}`);
  await expect(page.getByText(PENDING_TEXT)).toBeVisible();

  // The site answers. Nobody touches the phone.
  await release(path);
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`, { timeout: 30_000 });
  await expect(page.getByText(PENDING_TEXT)).toHaveCount(0);
});

test("a failed reader left open learns that a re-share worked when the app comes back to the front", async ({ page, context }) => {
  const path = "/flaky/left-open-then-reshared";
  const { link } = await failedAndCached(page, path);

  await setMode(path, "ok");
  const other = await context.newPage();
  expect(await share(other, link)).toBe("Already saved");
  await other.close();
  await waitForItem(page, link, extracted);
  await expect(page.getByText(FAILED_TEXT)).toBeVisible();

  // Headless Chromium has no real foreground and background, so the event
  // the app listens for is fired by hand. This checks the handler, not
  // Android's delivery of the event.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`);
  await expect(page.getByText(FAILED_TEXT)).toHaveCount(0);
});

test("saving a failed item again shows it as extracting, in the queue and in the reader", async ({ page }) => {
  const path = "/flaky/saved-again-while-failed";
  const { link, item } = await failedAndCached(page, path);

  await page.goto("/");
  await expect(page.getByText("couldn't extract").first()).toBeVisible();

  // This time the site is slow rather than broken, so the pending state lasts
  // long enough to be looked at.
  await setMode(path, "hold");
  expect(await share(page, link)).toBe("Already saved");
  await waitForItem(page, link, pending);

  await page.getByRole("link", { name: "Open queue" }).click();
  const again = page.getByRole("listitem").filter({ has: page.locator(`a[href="/read/${item.id}"]`) });
  await expect(again.getByText("extracting…")).toBeVisible();
  await expect(again.getByText("couldn't extract")).toHaveCount(0);

  // The reader was cached saying "failed". It must now say "extracting".
  await page.goto(`/read/${item.id}`);
  await expect(page.getByText(PENDING_TEXT)).toBeVisible();
  await expect(page.getByText(FAILED_TEXT)).toHaveCount(0);

  await release(path);
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`, { timeout: 30_000 });
});
