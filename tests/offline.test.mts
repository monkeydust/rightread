/**
 * Offline rules — no browser, no database.
 *
 * The outbox's storage half needs IndexedDB and its send half needs a network,
 * so neither is reachable here. What *is* reachable is the part where a mistake
 * would be silent and permanent: how a queued change is shown before the server
 * has heard it, and which changes may be queued at all.
 */

import { applyLocally, type OutboxOp } from "../src/lib/outbox.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

type Row = { id: string; title: string; starred: boolean; status: string };
const rows: Row[] = [
  { id: "a", title: "First", starred: false, status: "unread" },
  { id: "b", title: "Second", starred: false, status: "unread" },
];

// ── A queued patch shows immediately ──────────────────────────────
{
  const op: OutboxOp = { kind: "patch-item", itemId: "b", body: { starred: true } };
  const next = applyLocally(rows, op);

  check("the targeted row changes", next.find((r) => r.id === "b")?.starred === true);
  check("the others do not", next.find((r) => r.id === "a")?.starred === false);
  check("nothing is added or lost", next.length === 2);
  check("fields not in the patch survive", next.find((r) => r.id === "b")?.title === "Second");
  check("the original array is untouched", rows[1].starred === false);
}

// ── Archiving offline ─────────────────────────────────────────────
{
  const next = applyLocally(rows, {
    kind: "patch-item",
    itemId: "a",
    body: { status: "archived" },
  });
  check("status applies locally", next.find((r) => r.id === "a")?.status === "archived");
}

// ── Deleting offline ──────────────────────────────────────────────
{
  const next = applyLocally(rows, { kind: "delete-item", itemId: "a" });
  check("the row goes", next.length === 1 && next[0].id === "b");
}

// ── A patch for something not on this page ────────────────────────
// The queue page holds unread rows; a change to an archived one is legitimate
// and simply has nothing to show here.
{
  const next = applyLocally(rows, {
    kind: "patch-item",
    itemId: "not-here",
    body: { starred: true },
  });
  check("an unknown id changes nothing", JSON.stringify(next) === JSON.stringify(rows));
}

// ── A queued capture invents no row ───────────────────────────────
// There is no item until the server makes one, and a placeholder with no title
// would be a worse lie than the pending count already on screen.
{
  const next = applyLocally(rows, { kind: "capture", url: "https://example.com/x" });
  check("capture adds nothing to the list", next.length === 2);
}

console.log(failed === 0 ? "\nAll offline rules pass." : `\n${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
