/**
 * Offline reading. "Offline" here is Chromium's own switch for the page and
 * its service worker: requests fail at once. It is not an aeroplane's wi-fi
 * that accepts a request and never answers; the unit tests cover that case
 * (tests/sw-precache.test.mts, tests/offline.test.mts).
 */

import { test, expect } from "@playwright/test";
import {
  NEWS, share, waitForItem, extracted, row, reader, cached, workerInControl, serverItem,
} from "./support.mjs";

async function saveTwo(page) {
  const opened = `${NEWS}/articles/read-before-the-flight`;
  const unopened = `${NEWS}/articles/saved-but-never-opened`;
  for (const link of [opened, unopened]) {
    if (!(await serverItem(page, link))) await share(page, link);
  }
  return {
    opened: await waitForItem(page, opened, extracted),
    unopened: await waitForItem(page, unopened, extracted),
  };
}

/** Fails unless the browser really cannot reach the app. */
async function expectCutOff(page) {
  const reached = await page.evaluate(() =>
    fetch("/api/items?status=unread", { cache: "no-store" }).then(
      (r) => `answered ${r.status}`,
      () => "failed"
    )
  );
  expect(reached, "the page could still reach the server while offline").toBe("failed");
}

test("with the network off, a saved article opens and the queue still loads", async ({ page, context }) => {
  const { opened, unopened } = await saveTwo(page);

  // Online: open the queue (which downloads every article in the background)
  // and read one article.
  await page.goto("/");
  await workerInControl(page);
  await expect(row(page, /Read before the flight/)).toBeVisible();
  await page.goto(`/read/${opened.id}`);
  await expect(reader(page)).toContainText("Marker sentence for /articles/read-before-the-flight.");
  await page.goto("/");
  await expect.poll(() => cached(page, `/read/${unopened.id}`), {
    timeout: 30_000,
    message: "the queue never downloaded the unopened article for offline use",
  }).toBe(true);

  await context.setOffline(true);
  await expectCutOff(page);

  // The queue, reloaded with no network.
  await page.reload();
  await expect(row(page, /Read before the flight/)).toBeVisible();
  await expect(page.getByPlaceholder("Search, or paste a link to save")).toBeVisible();

  // The article that was read online.
  await page.goto(`/read/${opened.id}`);
  await expect(reader(page)).toContainText("Marker sentence for /articles/read-before-the-flight.");

  // An article that was never opened, only saved.
  await page.goto(`/read/${unopened.id}`);
  await expect(reader(page)).toContainText("Marker sentence for /articles/saved-but-never-opened.");

  // Tapping through from the queue, as on the phone.
  await page.goto("/");
  await row(page, /Read before the flight/).getByRole("link", { name: /Read before the flight/ }).click();
  await expect(reader(page)).toContainText("Marker sentence for /articles/read-before-the-flight.");

  // A page that was never visited has no copy: the app says it is offline
  // rather than showing a browser error. This also shows the worker itself
  // had no network, or it would have fetched the page.
  await page.goto("/graph");
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();

  await context.setOffline(false);
});

test("a star and a Done made offline land on the server after reconnecting", async ({ page, context }) => {
  const link = `${NEWS}/articles/starred-on-the-plane`;
  const other = `${NEWS}/articles/done-on-the-plane`;
  await share(page, link);
  await share(page, other);
  await waitForItem(page, link, extracted);
  await waitForItem(page, other, extracted);

  await page.goto("/");
  await workerInControl(page);
  const starRow = row(page, /Starred on the plane/);
  const doneRow = row(page, /Done on the plane/);
  await expect(starRow).toBeVisible();
  await expect(doneRow).toBeVisible();

  await context.setOffline(true);
  await expectCutOff(page);

  // Both apply on screen at once.
  await starRow.getByRole("button", { name: "Star", exact: true }).click();
  await expect(starRow.getByRole("button", { name: "Remove star" })).toBeVisible();
  // Done marks the row at once. Offline it stays where it is, with the
  // button turned into its own undo, until the queue is next loaded.
  await doneRow.getByRole("button", { name: "Mark as done" }).click();
  await expect(doneRow.getByRole("button", { name: "Move back to queue" })).toBeVisible();

  // The server has heard nothing yet.
  expect((await serverItem(page, link)).starred).toBe(false);
  expect((await serverItem(page, other)).status).toBe("unread");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await waitForItem(page, link, (i) => i.starred === true, 30_000);
  await waitForItem(page, other, (i) => i.status === "archived", 30_000);

  // And it is still so after a fresh load from the server.
  await page.reload();
  await expect(row(page, /Starred on the plane/).getByRole("button", { name: "Remove star" })).toBeVisible();
  await expect(row(page, /Done on the plane/)).toHaveCount(0);
  await page.goto("/archive");
  await expect(row(page, /Done on the plane/)).toBeVisible();
});
