import { normalizeUrl, hostLabel } from "../src/lib/url.ts";

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

const hl = hostLabel("https://www.theverge.com/a/b") === "theverge.com";
if (!hl) failed++;
console.log(`${hl ? "PASS" : "FAIL"}  hostLabel strips www`);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
