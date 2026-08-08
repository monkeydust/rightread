/**
 * Graph construction — offline, no network, no database, no API key.
 *
 * computeGraph() is the pure half of the builder precisely so this can drive
 * it with synthetic vectors. The properties asserted here are the ones that,
 * if they broke, would produce a graph that still *renders* — a hairball, a
 * duplicated edge, a silently dropped node — and so would not announce itself.
 */

import { computeGraph, clampK } from "../src/lib/graph/build.ts";
import { readUnitFloat, readPositiveInt } from "../src/lib/env.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const DIMS = 8;

/** A unit vector pointing mostly along `axis`, nudged by `spread`. */
function vec(axis: number, spread = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[axis % DIMS] = 1;
  if (spread) v[(axis + 1) % DIMS] = spread;
  return v;
}

function toBytes(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

let seq = 0;
function row(vector: Float32Array | null, overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    id: `i${seq}`,
    title: `Item ${seq}`,
    siteName: null,
    url: `https://example.com/${seq}`,
    kind: "article",
    status: "unread",
    starred: false,
    wordCount: 500,
    savedAt: new Date(0),
    embedding: vector ? toBytes(vector) : null,
    ...overrides,
  };
}

const META = { truncated: 0, startedAt: 0 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (rows: any[], k = 4) => computeGraph(rows as any, k, META);

// ── Shape ─────────────────────────────────────────────────────────
{
  seq = 0;
  const rows = [row(vec(0)), row(vec(0, 0.9)), row(vec(1)), row(vec(2))];
  const g = build(rows, 2);

  check("every row becomes a node", g.nodes.length === 4, `${g.nodes.length}`);
  check(
    "edges are undirected and deduplicated",
    new Set(g.edges.map((e) => [e.source, e.target].sort().join("|"))).size ===
      g.edges.length,
    JSON.stringify(g.edges.map((e) => `${e.source}-${e.target}`))
  );
  check(
    "no self edges",
    g.edges.every((e) => e.source !== e.target)
  );
  check(
    "edge count is bounded by n*k",
    g.edges.length <= rows.length * 2,
    `${g.edges.length}`
  );
  check(
    "edges are sorted strongest first",
    g.edges.every((e, i) => i === 0 || g.edges[i - 1].score >= e.score)
  );
  check(
    "the two near-identical vectors are the strongest pair",
    g.edges[0].score > 0.7,
    `${g.edges[0]?.score}`
  );
}

// ── Top-k is respected per node ───────────────────────────────────
{
  seq = 0;
  // Eight vectors all mutually similar: without a cap every node would link to
  // all seven others. This is the hairball case the design exists to prevent.
  const rows = Array.from({ length: 8 }, (_, i) => row(vec(0, 0.1 * i)));
  for (const k of [2, 3, 4]) {
    const g = build(rows, k);
    const degree = new Map<string, number>();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    // A node can exceed k by being *chosen* by others, but never by its own
    // selections — so the union is bounded by n*k, not by n*(n-1)/2.
    check(
      `k=${k}: edge count bounded by n*k (${g.edges.length} <= ${8 * k})`,
      g.edges.length <= 8 * k
    );
    check(
      `k=${k}: far below the ${(8 * 7) / 2} edges a full mesh would give`,
      g.edges.length < 28
    );
  }
}

// ── Mutual flag ───────────────────────────────────────────────────
{
  seq = 0;
  // A and B are each other's nearest. C is related to both but closer to B,
  // so C selects B while B still prefers A — a one-sided edge.
  //
  // C deliberately is NOT orthogonal: an orthogonal vector scores 0, falls
  // below EDGE_FLOOR and gets no edge at all, which tests nothing about
  // mutuality. (First version of this test did exactly that.)
  const rows = [row(vec(0)), row(vec(0, 0.05)), row(vec(0, 0.8))];
  const g = build(rows, 1);
  const ab = g.edges.find(
    (e) => [e.source, e.target].sort().join("|") === "i1|i2"
  );
  check("A<->B is mutual", ab?.mutual === true, JSON.stringify(ab));
  const cEdges = g.edges.filter((e) => e.source === "i3" || e.target === "i3");
  check(
    "C's edge is not mutual",
    cEdges.length > 0 && cEdges.every((e) => !e.mutual),
    JSON.stringify(cEdges)
  );
}

// ── Duplicates ────────────────────────────────────────────────────
{
  seq = 0;
  // The candidate pool genuinely contains exact duplicates (measured: two
  // copies of the same article at similarity 1.000), so this is a real case.
  const rows = [row(vec(0)), row(vec(0)), row(vec(4))];
  const g = build(rows, 2);
  const dup = g.edges.find((e) => e.duplicate);
  check("identical vectors are flagged as duplicates", Boolean(dup), JSON.stringify(g.edges));
  check("...and score ~1.0", (dup?.score ?? 0) > 0.999, `${dup?.score}`);
}

// ── Unlinked items ────────────────────────────────────────────────
{
  seq = 0;
  const rows = [row(vec(0)), row(vec(0, 0.9)), row(null), row(null)];
  const g = build(rows, 4);
  check("items without embeddings still appear as nodes", g.nodes.length === 4);
  check("...marked unlinked", g.nodes.filter((n) => !n.linked).length === 2);
  check("...and counted in stats", g.stats.unlinked === 2, `${g.stats.unlinked}`);
  check(
    "...and never appear in an edge",
    g.edges.every((e) => !["i3", "i4"].includes(e.source) && !["i3", "i4"].includes(e.target))
  );
}

// ── Degenerate inputs must not throw ──────────────────────────────
{
  seq = 0;
  check("empty library yields an empty graph", build([]).edges.length === 0);
  check("a single item yields no edges", build([row(vec(0))]).edges.length === 0);
  check(
    "a single item still yields its node",
    build([row(vec(0))]).nodes.length === 1
  );
  seq = 0;
  check(
    "all-unembedded library yields no edges",
    build([row(null), row(null)]).edges.length === 0
  );
  seq = 0;
  const zero = build([row(new Float32Array(DIMS)), row(vec(0))], 2);
  check("a zero vector does not produce NaN", zero.edges.every((e) => Number.isFinite(e.score)));
}

// ── Percentile banding ────────────────────────────────────────────
{
  seq = 0;
  // A spread-out corpus, so the similarity distribution is smooth rather than
  // bimodal. This is the property that makes "strong" mean something, and it
  // is why the bands are derived from the corpus rather than hardcoded —
  // measured on 21,321 real pairs, p90 was 0.417, so a fixed 0.4 threshold
  // would have called one random pair in ten "strong".
  //
  // Deterministic LCG rather than Math.random: a test that fails one run in
  // fifty is worse than no test. (An earlier version used two very tight
  // clusters, which put over 10% of pairs in the top bucket and collapsed p90
  // and p99 onto the same value — the assertion below caught it.)
  let state = 12345;
  const rnd = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const rows = Array.from({ length: 30 }, () => {
    const v = new Float32Array(DIMS);
    for (let d = 0; d < DIMS; d++) v[d] = rnd() - 0.4;
    return row(v);
  });
  const g = build(rows, 3);
  check(
    "band cut-offs are derived and ordered",
    g.stats.strongAt > g.stats.moderateAt,
    `moderate ${g.stats.moderateAt} strong ${g.stats.strongAt}`
  );
  check(
    "percentiles are within 0-1",
    g.edges.every((e) => e.percentile >= 0 && e.percentile <= 1)
  );
  check(
    "a stronger edge never has a lower percentile",
    g.edges.every((e, i) => i === 0 || g.edges[i - 1].percentile >= e.percentile)
  );
  check(
    "strength agrees with the cut-offs",
    g.edges.every((e) =>
      e.strength === "strong"
        ? e.score >= g.stats.strongAt
        : e.strength === "moderate"
          ? e.score >= g.stats.moderateAt && e.score < g.stats.strongAt
          : e.score < g.stats.moderateAt
    )
  );
  check("all pairs are counted", g.stats.pairsScored === (30 * 29) / 2, `${g.stats.pairsScored}`);
}

// ── clampK ────────────────────────────────────────────────────────
for (const [input, want] of [
  [4, 4], [2, 2], [8, 8],
  [1, 2], [0, 2], [-5, 2], [99, 8],
  ["3", 3], ["abc", 4], [undefined, 4], [null, 4], [2.5, 4],
] as Array<[unknown, number]>) {
  check(`clampK(${JSON.stringify(input)}) -> ${want}`, clampK(input) === want, `${clampK(input)}`);
}

// ── Env parsing ───────────────────────────────────────────────────
// Same failure this codebase has already been bitten by: a variable declared
// in docker-compose but absent from the env file arrives as "", and Number("")
// is 0 — which for a floor means "connect everything".
for (const [label, value, want] of [
  ["unset", undefined, 0.15],
  ["empty string (the compose case)", "", 0.15],
  ["whitespace", "  ", 0.15],
  ["non-numeric", "high", 0.15],
  ["out of range", "1.5", 0.15],
  ["negative", "-0.2", 0.15],
  ["valid override", "0.3", 0.3],
] as Array<[string, string | undefined, number]>) {
  const saved = process.env.TEST_FLOOR;
  if (value === undefined) delete process.env.TEST_FLOOR;
  else process.env.TEST_FLOOR = value;
  const got = readUnitFloat("TEST_FLOOR", 0.15, "test");
  if (saved === undefined) delete process.env.TEST_FLOOR;
  else process.env.TEST_FLOOR = saved;
  check(`readUnitFloat: ${label} -> ${want}`, got === want, `got ${got}`);
}

for (const [label, value, want] of [
  ["unset", undefined, 2000],
  ["empty string", "", 2000],
  ["zero", "0", 2000],
  ["negative", "-10", 2000],
  ["fractional", "1.5", 2000],
  ["valid override", "500", 500],
] as Array<[string, string | undefined, number]>) {
  const saved = process.env.TEST_CAP;
  if (value === undefined) delete process.env.TEST_CAP;
  else process.env.TEST_CAP = value;
  const got = readPositiveInt("TEST_CAP", 2000, "test");
  if (saved === undefined) delete process.env.TEST_CAP;
  else process.env.TEST_CAP = saved;
  check(`readPositiveInt: ${label} -> ${want}`, got === want, `got ${got}`);
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
