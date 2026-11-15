/**
 * Settings → Notifications, and the worker's push handler.
 *
 * What a headless browser on a closed network can and cannot show:
 *  - it can show the section, the per-type switch being saved on the server,
 *    and what the device switch says for each permission state;
 *  - it can hand the real service worker a push message (through Chromium's
 *    developer protocol) and read back the notification it raised;
 *  - it cannot subscribe to a push service, so "switch on" ending in "On",
 *    the test button, and a notification arriving from Google are NOT tested
 *    here. Those need a phone.
 */

import { test, expect } from "@playwright/test";
import { workerInControl } from "./support.mjs";

const groupShares = (page) => page.getByRole("switch", { name: "Group shares" });
const device = (page) => page.getByRole("switch", { name: "Notifications on this device" });

test("Settings shows the Notifications section with this device off", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByText("Notifications are not set up on this server.")).toHaveCount(0);
  await expect(device(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Off.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a test notification" })).toBeDisabled();
});

test("the Group shares switch is saved on the server", async ({ page }) => {
  await page.goto("/settings");
  await expect(groupShares(page)).toHaveAttribute("aria-checked", "true");

  await groupShares(page).click();
  await expect(groupShares(page)).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(groupShares(page)).toHaveAttribute("aria-checked", "false");

  await groupShares(page).click();
  await expect(groupShares(page)).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(groupShares(page)).toHaveAttribute("aria-checked", "true");
});

test("switching on with no push service to reach says so and stays off", async ({ page, context }) => {
  // The test network has no route to Google's push service, so the browser
  // cannot subscribe. The switch must not claim to be on, and must say why.
  await context.grantPermissions(["notifications"]);
  await page.goto("/");
  await workerInControl(page);
  await page.goto("/settings");
  await expect(page.getByText("Off.", { exact: true })).toBeVisible();

  await device(page).click();
  // Next's own route announcer is also an alert, so name the element.
  await expect(page.locator('p[role="alert"]')).toHaveText(/\S/, { timeout: 60_000 });
  await expect(device(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Send a test notification" })).toBeDisabled();

  const stored = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(await reg?.pushManager.getSubscription());
  });
  expect(stored).toBe(false);
});

test("the page never holds the private key or asks permission on load", async ({ page }) => {
  let asked = false;
  await page.addInitScript(() => {
    const original = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args) => {
      window.__askedForPermission = true;
      return original(...args);
    };
  });
  const res = await page.goto("/settings");
  const html = await res.text();
  expect(html).not.toMatch(/VAPID_PRIVATE_KEY|privateKey/);
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  asked = await page.evaluate(() => Boolean(window.__askedForPermission));
  expect(asked).toBe(false);
});

test("the worker turns a push message into a notification that opens the right page", async ({ page, context, playwright }) => {
  await context.grantPermissions(["notifications"]);
  await page.goto("/");
  await workerInControl(page);

  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  const registrationId = await new Promise((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const own = registrations.find((r) => r.scopeURL === "http://127.0.0.1:3000/");
      if (own) resolve(own.registrationId);
    });
  });
  const deliver = (data) =>
    cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://127.0.0.1:3000", registrationId, data });
  const shown = () =>
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return (await reg.getNotifications()).map((n) => ({
        title: n.title, body: n.body, tag: n.tag, icon: n.icon, badge: n.badge, path: n.data?.path,
      }));
    });

  // Handing the worker a message through the developer protocol is this
  // test's own stand-in for a push service, and Chromium now and then drops
  // one that arrives just as the worker goes idle. So each message is sent
  // until its notification is there; every message carries a tag, so a
  // repeat replaces rather than stacks.
  const push = (data, arrived) =>
    expect(async () => {
      await deliver(typeof data === "string" ? data : JSON.stringify(data));
      await expect.poll(async () => arrived(await shown()), { timeout: 4000 }).toBe(true);
    }).toPass({ timeout: 40_000 });

  await push(
    {
      v: 1, type: "group_share", title: "Book club",
      body: "Pat Example shared: How tides work (example.org)", path: "/groups/g1", tag: "share-s1",
    },
    (list) => list.length === 1
  );
  const [first] = await shown();
  expect(first).toMatchObject({
    title: "Book club",
    body: "Pat Example shared: How tides work (example.org)",
    tag: "share-s1",
    path: "/groups/g1",
  });
  expect(new URL(first.icon).pathname).toBe("/icon-192.png");
  // The status-bar badge is fetched by the phone's system, with no cookies.
  const badge = new URL(first.badge);
  expect(badge.origin).toBe("http://127.0.0.1:3000");
  const fetched = await playwright.request.newContext();
  const image = await fetched.get(badge.href);
  expect(image.status(), `${badge.pathname} without a session`).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
  await fetched.dispose();

  // The same share again replaces the first notification rather than stacking.
  await push(
    { v: 1, type: "group_share", title: "Book club", body: "Again", path: "/groups/g1", tag: "share-s1" },
    (list) => list.length === 1 && list[0].body === "Again"
  );

  // Something unreadable still shows a notification, and it opens the queue.
  await push("this is not JSON", (list) => list.some((n) => n.tag === "rightread"));
  const all = await shown();
  expect(all).toHaveLength(2);
  expect(all.find((n) => n.tag === "rightread")).toMatchObject({
    title: "rightread", body: "Something new on rightread", path: "/",
  });

  // A path that leaves the app is refused.
  await push(
    { v: 1, type: "x", title: "Elsewhere", body: "", path: "//evil.example/", tag: "elsewhere" },
    (list) => list.some((n) => n.tag === "elsewhere")
  );
  expect((await shown()).find((n) => n.tag === "elsewhere").path).toBe("/");
});
