/**
 * What every spec needs: the fixture server's control handle, the server's
 * own account of an item (asked past the service worker), and the few steps
 * a person repeats on the phone.
 */

import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";

export const NEWS = "http://news.e2e.test";
export const FORUM = "https://forum.e2e.test";
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Talks to the fixture server from the test process, not from the browser. */
export async function control(path, body) {
  const res = await fetch(`http://control.e2e.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`fixture control ${path} answered ${res.status}`);
  return res.json();
}

export const setMode = (path, mode) => control("/mode", { path, mode });
export const release = (path) => control("/release", { path });
export const fixtureHits = async () => (await control("/hits")).hits;

/** The app's log so far (run.sh follows `docker logs` into this file). */
export function appLog() {
  return readFileSync(`${process.env.E2E_OUT}/app.log`, "utf8");
}

/**
 * The library as the server holds it. `page.request` shares the page's
 * cookies but does not go through the service worker or the page's offline
 * switch, so this is the truth even while the browser is "offline".
 */
export async function serverItems(page, status = "unread") {
  const res = await page.request.get(`/api/items?status=${status}`);
  expect(res.status(), "GET /api/items").toBe(200);
  return (await res.json()).items;
}

export async function serverItem(page, url) {
  for (const status of ["unread", "archived"]) {
    const found = (await serverItems(page, status)).find((i) => i.url === url);
    if (found) return found;
  }
  return null;
}

/** Waits until the server's copy of the item satisfies `want`, and returns it. */
export async function waitForItem(page, url, want, timeout = 30_000) {
  let last = null;
  await expect
    .poll(
      async () => {
        last = await serverItem(page, url);
        return Boolean(last && want(last));
      },
      { timeout, message: `item ${url} never reached the expected state` }
    )
    .toBe(true);
  return last;
}

export const extracted = (i) => i.extractStatus === "ok";
export const failed = (i) => i.extractStatus === "failed";
export const pending = (i) => i.extractStatus === "pending";

/**
 * Saves a link the way Android does: by opening the share target from the
 * manifest with the link in `url`. Returns the heading the page showed.
 */
export async function share(page, link, field = "url") {
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  const target = manifest.share_target;
  expect(target.method, "share target method").toBe("GET");
  const query = new URLSearchParams({ [target.params[field]]: link });
  await page.goto(`${target.action}?${query}`);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  return (await heading.textContent())?.trim();
}

/** The service worker is installed and in charge of this page. */
export async function workerInControl(page) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, {
    timeout: 30_000,
  });
}

/** Whether the worker holds a copy of a path in any of its caches. */
export function cached(page, path) {
  return page.evaluate(async (p) => Boolean(await caches.match(p)), path);
}

/** The row for an item in the queue or archive, by its title. */
export function row(page, title) {
  return page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title }) });
}

export const reader = (page) => page.locator(".prose-reader");
export const FAILED_TEXT = "This page couldn't be turned into a reader view.";
export const PENDING_TEXT = "Extracting the article…";
