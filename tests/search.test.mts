/**
 * Offline search tests — no network, no API key, no database.
 *
 * The query parser is the piece that must not regress: it stands between a
 * free-text box and FTS5's own query language, where an unbalanced quote or a
 * bare operator is a syntax error rather than an empty result set. Every case
 * below is something a person could plausibly type.
 *
 * Ranking quality is measured separately against a real library; it needs the
 * network and has no place in `npm test`.
 */

import { parseQuery } from "../src/lib/search/query.ts";
import { cosine, toBlob, fromBlob } from "../src/lib/search/embed.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── Query parsing ─────────────────────────────────────────────────
const cases: Array<[string, string, string | null]> = [
  ["single term", "rust", '"rust"'],
  ["two terms AND", "rust async", '"rust" "async"'],
  ["prefix wildcard", "data*", '"data"*'],
  ["wildcard mid-query", "rust data* async", '"rust" "data"* "async"'],
  ["quoted phrase", '"memory safety"', '"memory safety"'],
  ["phrase with wildcard", '"web assem"*', '"web assem"*'],
  ["phrase plus term", '"memory safety" rust', '"memory safety" "rust"'],
  ["collapses whitespace", "  rust   async  ", '"rust" "async"'],
  ["multiple asterisks", "data***", '"data"*'],
  ["empty", "", null],
  ["whitespace only", "   ", null],
  ["punctuation only", "!!! ???", null],
  ["asterisk alone", "*", null],
  // The cases that would otherwise raise an FTS5 syntax error:
  ["unbalanced quote", 'rust "async', '"rust" "async"'],
  ["embedded quote", 'say "hi" now', '"say" "hi" "now"'],
  ["bare AND is literal", "rust AND async", '"rust" "AND" "async"'],
  ["bare OR is literal", "rust OR async", '"rust" "OR" "async"'],
  ["NEAR is literal", "NEAR(a b)", '"NEAR(a" "b)"'],
  ["parens are literal", "(rust)", '"(rust)"'],
  ["hyphen not negation", "-rust", '"-rust"'],
  ["colon not a column filter", "title:rust", '"title:rust"'],
  ["unicode", "café résumé", '"café" "résumé"'],
];
for (const [name, input, expected] of cases) {
  const got = parseQuery(input).match;
  check(`parse: ${name}`, got === expected, `got ${got}  want ${expected}`);
}

check("wildcard flag set", parseQuery("data*").hasWildcard === true);
check("wildcard flag clear", parseQuery("data").hasWildcard === false);
check(
  "terms exposed for highlighting",
  JSON.stringify(parseQuery('"memory safety" rust').terms) ===
    JSON.stringify(["memory safety", "rust"])
);

// No input should ever produce a match string that FTS5 could not parse:
// every token is quoted, so quotes must always be balanced.
for (const nasty of ['"', '""', '"""', 'a"b', '*"*', '\\', "a\\b", '""*']) {
  const m = parseQuery(nasty).match;
  const balanced = m === null || (m.match(/"/g) ?? []).length % 2 === 0;
  check(`hostile input stays balanced: ${JSON.stringify(nasty)}`, balanced, `got ${m}`);
}

// ── Vector round-trip and similarity ──────────────────────────────
const v = Float32Array.from([0.1, -0.5, 0.25, 1]);
const round = fromBlob(toBlob(v));
check(
  "float32 survives blob round-trip",
  round.length === v.length && round.every((x, i) => x === v[i]),
  JSON.stringify(Array.from(round))
);

const a = Float32Array.from([1, 0, 0]);
const b = Float32Array.from([0, 1, 0]);
check("cosine: identical vectors are 1", Math.abs(cosine(a, a) - 1) < 1e-6);
check("cosine: orthogonal vectors are 0", Math.abs(cosine(a, b)) < 1e-6);
check(
  "cosine: opposite vectors are -1",
  Math.abs(cosine(a, Float32Array.from([-1, 0, 0])) + 1) < 1e-6
);
check("cosine: scale invariant", Math.abs(cosine(a, Float32Array.from([5, 0, 0])) - 1) < 1e-6);
check("cosine: length mismatch is 0, not a throw", cosine(a, Float32Array.from([1, 0])) === 0);
check("cosine: zero vector is 0, not NaN", cosine(a, Float32Array.from([0, 0, 0])) === 0);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
