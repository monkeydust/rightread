/**
 * The canary's one save, run inside the app container by canary.sh:
 *
 *   docker exec -e E2E_SESSION_TOKEN=… <app> node /e2e/lib/canary-save.mjs <url>
 *
 * Saves the URL through POST /api/capture as the signed-in test user, waits
 * for the extraction to finish, and prints one line of JSON describing what
 * was stored. It decides nothing; canary.sh does, from this and the app log.
 * The URL is never printed, and neither is any of the page's text.
 */

import { DatabaseSync } from "node:sqlite";

const [url] = process.argv.slice(2);
const token = process.env.E2E_SESSION_TOKEN;
const APP = "http://127.0.0.1:3000";
const WAIT_MS = 8 * 60 * 1000;

if (!url || !token) {
  console.error("usage: canary-save.mjs <url>   (with E2E_SESSION_TOKEN set)");
  process.exit(2);
}

// No Origin header: that is how the capture route tells a script from a page.
const headers = { cookie: `authjs.session-token=${token}`, "content-type": "application/json" };

const saved = await fetch(`${APP}/api/capture`, {
  method: "POST",
  headers,
  body: JSON.stringify({ url }),
  signal: AbortSignal.timeout(30_000),
});
if (saved.status !== 201) {
  console.log(JSON.stringify({ saved: false, status: saved.status }));
  process.exit(0);
}
const { item } = await saved.json();

const started = Date.now();
let extractStatus = "pending";
while (Date.now() - started < WAIT_MS) {
  const res = await fetch(`${APP}/api/items/${item.id}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.ok) extractStatus = (await res.json()).extractStatus;
  if (extractStatus !== "pending") break;
  await new Promise((r) => setTimeout(r, 3000));
}

const db = new DatabaseSync(process.env.DATABASE_URL.slice("file:".length), { readOnly: true });
const row = db
  .prepare("SELECT contentHtml, wordCount, extractError FROM Item WHERE id = ?")
  .get(item.id);
db.close();

const html = row?.contentHtml ?? "";
console.log(
  JSON.stringify({
    saved: true,
    extractStatus,
    seconds: Math.round((Date.now() - started) / 1000),
    words: row?.wordCount ?? 0,
    cutShort: html.includes("This thread is cut short"),
    // Only the fallback's own code, e.g. "bot_blocked"; never page text.
    error: (row?.extractError ?? "").match(/fallback fetch also failed \(([a-z0-9_]+)\)/)?.[1] ?? (row?.extractError ? "other" : null),
  })
);
