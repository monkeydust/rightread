/**
 * Offline classifier tests — no network, no API key, deterministic.
 *
 * These cover the parts that must never regress silently: the URL rule table,
 * enum validation, layer precedence, and the fail-soft contract. Accuracy of
 * the model itself is measured separately by scripts/eval-classify.mjs, which
 * does hit the network and therefore has no place in `npm test`.
 */

import { matchUrl } from "../src/lib/classify/rules.ts";
import { isKind, KINDS } from "../src/lib/classify/kinds.ts";
import { classifyPage } from "../src/lib/classify/index.ts";
import { parseJSON } from "../src/lib/openrouter.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── URL rules ─────────────────────────────────────────────────────
const ruleCases: Array<[string, string | null]> = [
  ["https://news.ycombinator.com/item?id=123", "conversation"],
  ["https://news.ycombinator.com/", "other"],
  ["https://news.ycombinator.com/newest", "other"],
  ["https://www.reddit.com/r/rust/comments/abc/title/", "conversation"],
  ["https://old.reddit.com/r/rust/comments/abc/", "conversation"],
  ["https://np.reddit.com/r/rust/comments/abc/", "conversation"],
  ["https://www.reddit.com/r/rust/", "other"],
  ["https://lobste.rs/s/abc123/some-title", "conversation"],
  ["https://lobste.rs/", "other"],
  ["https://stackoverflow.com/questions/42/why", "conversation"],
  ["https://superuser.com/questions/42/why", "conversation"],
  ["https://github.com/a/b/issues/7", "conversation"],
  ["https://github.com/a/b/pull/7", "conversation"],
  ["https://github.com/a/b/discussions/7", "conversation"],
  ["https://github.com/a/b", null], // a repo root is not a thread — model decides
  ["https://en.wikipedia.org/wiki/Rust", "reference"],
  ["https://de.wikipedia.org/wiki/Rust", "reference"],
  ["https://arxiv.org/abs/1234.5678", "other"],
  ["https://www.youtube.com/watch?v=x", "other"],
  ["https://youtu.be/x", "other"],
  ["https://simonwillison.net/2024/a-post/", null], // no rule — model decides
  ["https://example.com/anything", null],
  ["not a url at all", null],
];
for (const [url, expected] of ruleCases) {
  const got = matchUrl(url);
  check(
    `rule: ${url.slice(0, 52)} -> ${expected ?? "no match"}`,
    (got?.kind ?? null) === expected,
    `got ${got?.kind ?? "null"}`
  );
}

// www. is stripped before matching, so both forms behave identically.
check(
  "rule: www prefix is normalised",
  matchUrl("https://www.lobste.rs/s/a/b")?.kind === "conversation"
);

// ── Enum validation ───────────────────────────────────────────────
check("isKind accepts every declared kind", KINDS.every(isKind));
for (const bad of ["Article", "ARTICLE", "discussion", "", null, undefined, 7, {}]) {
  check(`isKind rejects ${JSON.stringify(bad)}`, !isKind(bad));
}

// ── Layer precedence and fail-soft ────────────────────────────────
// No API key: any call that reaches the model must degrade, not throw.
const savedKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const ruled = await classifyPage({
  url: "https://news.ycombinator.com/item?id=999",
  title: "irrelevant",
  extracted: false,
});
check(
  "URL rule resolves without any model call",
  ruled.kind === "conversation" && ruled.source === "url" && ruled.confidence === 1,
  JSON.stringify(ruled)
);

const degraded = await classifyPage({
  url: "https://example.com/some-essay",
  title: "An essay",
  text: "words words words",
  extracted: true,
});
check(
  "missing API key degrades to other, never throws",
  degraded.kind === "other" && degraded.source === "none" && degraded.confidence === 0,
  JSON.stringify(degraded)
);

if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;

// ── parseJSON, the two failure modes seen in production ───────────
check(
  "parseJSON: plain object",
  parseJSON<{ kind: string }>('{"kind":"blog"}').kind === "blog"
);
check(
  "parseJSON: markdown-fenced despite json mode",
  parseJSON<{ kind: string }>('```json\n{"kind":"blog"}\n```').kind === "blog"
);
check(
  "parseJSON: truncated mid-object is recovered",
  parseJSON<{ kind: string }>('{"kind":"blog","reason":"an unterminated str').kind === "blog"
);
let threw = false;
try {
  parseJSON("this is not json at all");
} catch {
  threw = true;
}
check("parseJSON: genuine garbage still throws", threw);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
