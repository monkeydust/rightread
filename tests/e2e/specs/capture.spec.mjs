import { test, expect } from "@playwright/test";
import { NEWS, share, waitForItem, extracted, row, reader, fixtureHits } from "./support.mjs";

test("a link shared from another app is saved, extracted and readable", async ({ page }) => {
  const path = "/articles/the-harbour-bell";
  const link = `${NEWS}${path}`;

  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, extracted);
  expect(item.title).toContain("The harbour bell");

  await page.getByRole("link", { name: "Open queue" }).click();
  const saved = row(page, /The harbour bell/);
  await expect(saved).toBeVisible();
  await expect(saved.getByText(/\d+ min/)).toBeVisible();
  await expect(saved.getByText("couldn't extract")).toHaveCount(0);

  await saved.getByRole("link", { name: /The harbour bell/ }).click();
  await expect(page).toHaveURL(new RegExp(`/read/${item.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The harbour bell");
  await expect(reader(page)).toContainText(`Marker sentence for ${path}.`);
  await expect(reader(page)).toContainText("paid for in herring");
  // The site's own navigation and footer are not part of the article.
  await expect(reader(page)).not.toContainText("is not a real newspaper");
});

test("a share that puts the link inside the text field is still saved", async ({ page }) => {
  const link = `${NEWS}/articles/link-inside-the-text`;
  expect(await share(page, `Worth a read ${link} (sent from another app)`, "text")).toBe("Saved to rightread");
  await waitForItem(page, link, extracted);
});

test("sharing the same link twice says so and keeps one copy", async ({ page }) => {
  const link = `${NEWS}/articles/shared-twice`;
  expect(await share(page, link)).toBe("Saved to rightread");
  await waitForItem(page, link, extracted);
  expect(await share(page, link)).toBe("Already saved");
  const res = await page.request.get("/api/items?status=unread");
  const copies = (await res.json()).items.filter((i) => i.url === link);
  expect(copies).toHaveLength(1);
});

test("a share with no link in it says so", async ({ page }) => {
  expect(await share(page, "no link here at all", "text")).toBe("Couldn't save that");
  await expect(page.getByText("That share didn't contain a link.")).toBeVisible();
});

test("pasting a link into the box saves it without another tap", async ({ page, context }) => {
  const link = `${NEWS}/articles/pasted-into-the-box`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const box = page.getByPlaceholder("Search, or paste a link to save");
  await box.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), link);
  await page.keyboard.press("Control+V");

  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(box).toHaveValue("");
  const saved = row(page, /Pasted into the box/);
  await expect(saved).toBeVisible();
  await expect(saved.getByText(/\d+ min/)).toBeVisible();
  await waitForItem(page, link, extracted);
});

test("typing a link offers Save, and Save stores it", async ({ page }) => {
  const link = `${NEWS}/articles/typed-into-the-box`;
  await page.goto("/");
  const box = page.getByPlaceholder("Search, or paste a link to save");
  await box.fill(link);
  await expect(page.getByText("That looks like a link")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row(page, /Typed into the box/)).toBeVisible();
  await waitForItem(page, link, extracted);
});

test("typing words searches instead of saving", async ({ page }) => {
  await page.goto("/");
  const before = (await (await page.request.get("/api/items")).json()).items.length;
  await page.getByPlaceholder("Search, or paste a link to save").fill("harbour bell");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.waitForTimeout(1500);
  const after = (await (await page.request.get("/api/items")).json()).items.length;
  expect(after).toBe(before);
});

test("saves work with OpenRouter failing, and its calls never left the test network", async ({ page }) => {
  // The fake at openrouter.ai answers 503 to everything. Every save above
  // was extracted anyway: that is the fail-soft rule. The calls landing on
  // the fake is also the proof that nothing reached the real service.
  const link = `${NEWS}/articles/saved-with-the-model-down`;
  expect(await share(page, link)).toBe("Saved to rightread");
  const item = await waitForItem(page, link, extracted);
  expect(item.kind).toBe("other");

  await expect
    .poll(async () => (await fixtureHits()).filter((h) => h.host === "openrouter.ai").length, {
      message: "the app never tried OpenRouter, so this run did not exercise its failure",
    })
    .toBeGreaterThan(0);
});
