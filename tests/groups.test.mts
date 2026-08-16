/**
 * Group rules — offline.
 *
 * Covers the pure half of `src/lib/groups/`: the decisions that shape what
 * lands on a shelf and what a card ends up saying. The database half is not
 * exercised here for the same reason the rest of this suite avoids it — there
 * is no fixture harness — so anything security-relevant is kept as a plain
 * function and asserted directly.
 *
 * The snapshot rules matter more than they look. `captureUrl` returns before
 * extraction finishes, so sharing something you just saved is the normal flow
 * and the sharer's item is a bare hostname at that instant. Getting these wrong
 * means a group's shelf is permanently a list of domain names.
 */

import {
  normalizeGroupName,
  snapshotFromItem,
  isBetterSnapshot,
  MAX_GROUP_NAME,
} from "../src/lib/groups/rules.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── Group names ───────────────────────────────────────────────────
check("name: trims", normalizeGroupName("  Reading club  ") === "Reading club");
check(
  "name: collapses internal whitespace",
  normalizeGroupName("Reading\n\tclub") === "Reading club",
  String(normalizeGroupName("Reading\n\tclub"))
);
check("name: empty is null", normalizeGroupName("") === null);
check("name: whitespace only is null", normalizeGroupName("   \n ") === null);
check("name: null input is null", normalizeGroupName(null) === null);
check("name: undefined input is null", normalizeGroupName(undefined) === null);
check(
  "name: capped at MAX_GROUP_NAME",
  normalizeGroupName("x".repeat(200))?.length === MAX_GROUP_NAME
);
check("name: keeps unicode", normalizeGroupName("Кружок чтения") === "Кружок чтения");

// ── Snapshots ─────────────────────────────────────────────────────
const extracted = {
  title: "The Case Against the Open Plan Office",
  siteName: "The Atlantic",
  excerpt: "A short summary of the piece.",
  leadImage: "https://example.com/a.jpg",
};

const full = snapshotFromItem(extracted, "example.com");
check("snapshot: copies the title", full.title === extracted.title);
check("snapshot: copies siteName", full.siteName === "The Atlantic");
check("snapshot: copies excerpt", full.excerpt === extracted.excerpt);
check("snapshot: copies leadImage", full.leadImage === extracted.leadImage);

// The case that actually happens: shared a second after saving, so the item
// exists but extraction has not run and the title is still the host label.
const pending = snapshotFromItem(
  { title: "Untitled", siteName: null, excerpt: null, leadImage: null },
  "nytimes.com"
);
check(
  "snapshot: 'Untitled' falls back to the host label",
  pending.title === "nytimes.com",
  pending.title
);

// Sharing a link that is not in your library at all.
const none = snapshotFromItem(null, "bbc.co.uk");
check("snapshot: no item falls back to the host label", none.title === "bbc.co.uk");
check("snapshot: no item leaves the rest null", none.excerpt === null && none.siteName === null);

check(
  "snapshot: blank title falls back",
  snapshotFromItem({ title: "   " }, "example.com").title === "example.com"
);

// ── Which snapshot wins on a re-share ─────────────────────────────
// The guard that stops a re-share downgrading a good card to a hostname.
const good = { title: extracted.title, siteName: "The Atlantic", excerpt: "text", leadImage: null };
const thin = { title: "example.com", siteName: null, excerpt: null, leadImage: null };

check("better: real beats thin", isBetterSnapshot(good, thin) === true);
check("better: thin does NOT beat real", isBetterSnapshot(thin, good) === false);
check(
  "better: a longer title wins when neither has text",
  isBetterSnapshot({ ...thin, title: "A Real Headline" }, thin) === true
);
check(
  "better: identical snapshots are not 'better'",
  isBetterSnapshot(good, { ...good }) === false
);

console.log(failed === 0 ? "\nAll group rules pass." : `\n${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
