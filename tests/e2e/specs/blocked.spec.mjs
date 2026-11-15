/**
 * A site that refuses this server with a bot wall, fetched through the
 * fallback. The wall and TinyFish are both fakes (fixtures/server.mjs); the
 * real service is only ever called by the canary.
 */

import { test, expect } from "@playwright/test";
import {
  NEWS, FORUM, share, waitForItem, extracted, failed, reader, fixtureHits, appLog, FAILED_TEXT,
} from "./support.mjs";

test("a blocked three-page thread is saved whole, as one item", async ({ page }) => {
  const link = `${FORUM}/thread/tides`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, extracted, 60_000);

  await page.goto(`/read/${item.id}`);
  const body = reader(page);
  await expect(body).toContainText("Reply 1 of the tides thread, on page 1.");
  await expect(body).toContainText("Reply 5 of the tides thread, on page 2.");
  await expect(body).toContainText("Reply 12 of the tides thread, on page 3.");
  await expect(body).toContainText("HeronOnTheWeir");
  await expect(body).not.toContainText("cut short");
  // The forum's own "Log in" link is page furniture, not a post.
  await expect(body).not.toContainText("Log in");

  // One call per page, each with the key, each for the forum and nothing else.
  const calls = (await fixtureHits()).filter(
    (h) => h.host === "api.fetch.tinyfish.ai" && h.urls?.[0]?.includes("/thread/tides")
  );
  expect(calls.map((c) => c.urls[0])).toEqual([link, `${link}?page=2`, `${link}?page=3`]);
  expect(calls.every((c) => c.apiKey === true && c.method === "POST")).toBe(true);

  // The log line RELEASE reads after a production save.
  await expect
    .poll(() => appLog(), { timeout: 10_000 })
    .toMatch(/fetch fallback \(tinyfish\) host=forum\.e2e\.test pages=3 outcome=ok stop=page_total .*first=1 total=3/);
});

test("when the fallback is refused too, the reader says the page was blocked", async ({ page }) => {
  const link = `${FORUM}/thread/refused`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, failed, 60_000);
  expect(item.extractError).toMatch(/^Blocked/);
  expect(item.extractError).toContain("bot_blocked");

  await page.goto(`/read/${item.id}`);
  await expect(page.getByText(FAILED_TEXT)).toBeVisible();
  await expect(page.getByText(/Blocked/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the original" })).toHaveAttribute("href", link);
});

test("an ordinary failure is not sent to the fallback", async ({ page }) => {
  // Only a bot wall may send a page's address to a third party. A plain 500
  // must fail as it always did.
  const path = "/flaky/plain-server-error";
  const link = `${NEWS}${path}`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, failed);
  expect(item.extractError).toContain("HTTP 500");

  const sent = (await fixtureHits()).filter((h) => h.host === "api.fetch.tinyfish.ai");
  expect(sent.filter((h) => !h.urls?.[0]?.startsWith(`${FORUM}/thread/`))).toEqual([]);
});
