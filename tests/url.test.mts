import { normalizeUrl, hostLabel, extractFirstUrl } from "../src/lib/url.ts";

const cases: Array<[string, string, string]> = [
  ["strips utm", "https://a.com/x?utm_source=t&id=5", "https://a.com/x?id=5"],
  ["strips fbclid", "https://a.com/x?fbclid=abc", "https://a.com/x"],
  ["strips hash", "https://a.com/x#section", "https://a.com/x"],
  ["trailing slash", "https://a.com/x/", "https://a.com/x"],
  ["root slash kept", "https://a.com/", "https://a.com/"],
  ["adds scheme", "example.com/post", "https://example.com/post"],
  ["lowercases host", "https://EXAMPLE.com/Path", "https://example.com/Path"],
  ["keeps real params", "https://a.com/s?q=hello&page=2", "https://a.com/s?q=hello&page=2"],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  const got = normalizeUrl(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got ${got}  want ${expected}`);
}

const rejects = ["javascript:alert(1)", "file:///etc/passwd", "", "   ", "ftp://a.com/x"];
for (const bad of rejects) {
  let threw = false;
  try { normalizeUrl(bad); } catch { threw = true; }
  if (!threw) failed++;
  console.log(`${threw ? "PASS" : "FAIL"}  rejects ${JSON.stringify(bad)}`);
}

// ── extractFirstUrl — powers paste-to-save and the share target ──
const extractCases: Array<[string, string, string | null]> = [
  ["bare url", "https://a.com/x", "https://a.com/x"],
  ["bare host", "example.com/post", "https://example.com/post"],
  ["surrounding whitespace", "  https://a.com/x  ", "https://a.com/x"],
  ["url inside a sentence", "Great read https://a.com/x really", "https://a.com/x"],
  ["trailing full stop", "See https://a.com/x.", "https://a.com/x"],
  ["trailing bracket", "(https://a.com/x)", "https://a.com/x"],
  ["strips tracking params", "https://a.com/x?utm_source=t", "https://a.com/x"],
  ["first of several", "https://a.com/1 and https://b.com/2", "https://a.com/1"],
  ["plain prose", "just some words here", null],
  ["empty", "", null],
  ["whitespace only", "   ", null],
  ["rejects javascript:", "javascript:alert(1)", null],
  ["rejects file://", "file:///etc/passwd", null],
];
for (const [name, input, expected] of extractCases) {
  const got = extractFirstUrl(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  extractFirstUrl: ${name}`);
  if (!ok) console.log(`      got ${got}  want ${expected}`);
}

const hl = hostLabel("https://www.theverge.com/a/b") === "theverge.com";
if (!hl) failed++;
console.log(`${hl ? "PASS" : "FAIL"}  hostLabel strips www`);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
