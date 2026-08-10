/**
 * Search-or-save intent detection — offline.
 *
 * One box now serves two purposes, so this single rule decides whether typing
 * saves a page or searches the library. Getting it wrong is not a cosmetic
 * bug: a mis-read search would silently capture a page, and a mis-read link
 * would search for something that isn't there. Every case below is something a
 * person could plausibly type into the box.
 */

import { classifyInput } from "../src/lib/url.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const kind = (v: string) => classifyInput(v).kind;

// ── Things that must be treated as links ──────────────────────────
for (const v of [
  "https://example.com/article",
  "http://example.com",
  "example.com",
  "example.com/article",
  "www.bbc.co.uk/news/uk-123",
  "https://archive.is/IAxf9",
  "  https://example.com/a  ",
  "https://example.com/a?b=c&d=e#frag",
  "https://sub.domain.example.co.uk/deep/path/",
]) {
  check(`link: ${JSON.stringify(v)}`, kind(v) === "link", kind(v));
}

// ── Things that must be treated as searches ───────────────────────
for (const v of [
  "rust async",
  "memory safety",
  "post-quantum cryptography",
  '"exact phrase"',
  "data*",
  "how do I avoid data races",
  // A sentence that merely mentions a domain is not a link to save.
  "that piece on example.com about latency",
  "notes from example.com and elsewhere",
  // Single words that are not domains.
  "rust",
  "sqlite",
  // A bare word with a dot that is not a valid host.
  "e.g",
  "...",
]) {
  check(`search: ${JSON.stringify(v)}`, kind(v) === "search", kind(v));
}

// ── Empty ─────────────────────────────────────────────────────────
for (const v of ["", "   ", "\t\n"]) {
  check(`empty: ${JSON.stringify(v)}`, kind(v) === "empty", kind(v));
}

// ── The link it reports is normalised and usable ──────────────────
{
  const r = classifyInput("example.com/article");
  check(
    "a bare host is normalised to an absolute URL",
    r.kind === "link" && r.url.startsWith("http"),
    JSON.stringify(r)
  );
}
{
  const r = classifyInput("  https://example.com/a  ");
  check(
    "surrounding whitespace is trimmed off the link",
    r.kind === "link" && !/\s/.test(r.url),
    JSON.stringify(r)
  );
}
{
  const r = classifyInput("rust async");
  check(
    "a search reports the trimmed term",
    r.kind === "search" && r.term === "rust async",
    JSON.stringify(r)
  );
}

// ── The property that matters most ────────────────────────────────
// A search term must never be classified as a link, because that is the
// direction where the mistake is destructive: it would save a page.
const searchesThatMustNeverSave = [
  "the verge review",
  "wired com article",
  "check example.com later",
  "site:example.com something",
  "example dot com",
];
check(
  "no plausible search phrase is ever read as a link",
  searchesThatMustNeverSave.every((v) => kind(v) !== "link"),
  JSON.stringify(searchesThatMustNeverSave.map((v) => [v, kind(v)]))
);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
