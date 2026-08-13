/**
 * End-to-end search benchmark: the old serial pipeline against the split
 * exact/semantic paths, over a real SQLite database with the network stubbed.
 *
 * The stub replaces globalThis.fetch with a deterministic responder that
 * waits --net-ms and returns a vector seeded from the request text — the real
 * embed() code runs, but nothing leaves the process. That makes the numbers
 * reproducible and lets --net-ms model the one term we cannot control in
 * production. --net-ms 0 shows the honest floor where the only wins are
 * cache reuse and DB/scoring overlap.
 *
 * What the table proves:
 *   - time-to-keyword-results: the old pipeline returned keyword hits only
 *     when everything (including the network) finished; searchExact never
 *     touches the network, so its time is flat in --net-ms.
 *   - semantic warm: a repeat query hits the embedding LRU and the packed
 *     matrix, collapsing to milliseconds.
 *
 *   npm run bench:search:e2e
 *   npm run bench:search:e2e -- --items 200 --iters 30 --net-ms 150
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ITEMS = Number(arg("items", "200"));
const ITERS = Number(arg("iters", "30"));
const NET_MS = Number(arg("net-ms", "150"));

const color = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : color.red("FAIL")}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── Environment, before any src import ────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "rightread-bench-"));
const dbPath = path.join(dir, "bench.db").replace(/\\/g, "/");
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.OPENROUTER_API_KEY = "bench-stub-key";
// Zero (explicitly allowed by readFloor) so semantic winners exist and the
// winner-metadata load is part of what gets measured.
process.env.OPENROUTER_SEMANTIC_FLOOR = "0";

execSync("npx prisma db push --skip-generate", {
  env: process.env as NodeJS.ProcessEnv,
  stdio: "pipe",
});

// ── Deterministic fetch stub ──────────────────────────────────────
const DIMS = 1536;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v: number[] = [];
  for (let d = 0; d < DIMS; d++) v.push(rand() * 2 - 1);
  return v;
}

let stubMode: "ok" | "down" = "ok";
let stubCalls = 0;

globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  stubCalls++;
  await new Promise((r) => setTimeout(r, NET_MS));
  if (stubMode === "down") throw new TypeError("fetch failed (stubbed outage)");
  const input = String(JSON.parse(init?.body ?? "{}").input ?? "");
  return new Response(
    JSON.stringify({ data: [{ embedding: seededVector(hashString(input)) }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}) as typeof fetch;

// ── Imports (after env + stub) ────────────────────────────────────
const { prisma } = await import("../src/lib/db.ts");
const { ensureSearchIndex } = await import("../src/lib/search/index-schema.ts");
const { searchExact, searchSemantic } = await import("../src/lib/search/search.ts");
const { invalidateUserMatrix } = await import("../src/lib/search/matrix-cache.ts");
const { embed, cosine, fromBlob, toBlob, readFloor } = await import(
  "../src/lib/search/embed.ts"
);
const { parseQuery } = await import("../src/lib/search/query.ts");

// ── Seed ──────────────────────────────────────────────────────────
const user = await prisma.user.create({
  data: { email: "bench@example.com" },
});
await ensureSearchIndex();

const rand = mulberry32(4242);
const topics = ["rust async runtimes", "css layout", "database indexes", "type systems"];
for (let i = 0; i < ITEMS; i++) {
  const topic = topics[i % topics.length];
  const vec = new Float32Array(seededVector(1000 + i));
  await prisma.item.create({
    data: {
      userId: user.id,
      url: `https://example.com/${i}`,
      title: `Article ${i}: notes on ${topic}`,
      excerpt: `A short piece about ${topic}.`,
      textContent: `Body text discussing ${topic} at length. ${"filler ".repeat(40)}`,
      wordCount: 300,
      position: i,
      embedding: toBlob(vec),
      embeddingModel: "bench",
      embeddedAt: new Date(),
    },
  });
  void rand; // seed consumed above; kept for symmetry with the micro-bench
}

const QUERY = "rust async";
const FLOOR = readFloor();
const SEMANTIC_LIMIT = 10;

// ── The old pipeline, verbatim in miniature ───────────────────────
// FTS → metadata load → EVERY blob → network embed → per-row cosine. Fully
// serial, exactly as src/lib/search/search.ts was before the split. Keyword
// results only exist when the whole thing finishes — that is the point.
async function oldSearch(userId: string, rawQuery: string) {
  const parsed = parseQuery(rawQuery);
  const rows = await prisma.$queryRawUnsafe<{ itemId: string; snippet: string }[]>(
    `SELECT itemId, snippet(ItemSearch, 4, char(1), char(2), '…', 18) AS snippet
       FROM ItemSearch WHERE ItemSearch MATCH ? AND userId = ?
      ORDER BY bm25(ItemSearch, 0.0, 0.0, 10.0, 4.0, 1.0, 2.0) LIMIT 50`,
    parsed.match,
    userId
  );
  const exactIds = rows.map((r) => r.itemId);
  const items = await prisma.item.findMany({
    where: { userId, id: { in: exactIds } },
    select: { id: true, title: true },
  });

  const candidates = await prisma.item.findMany({
    where: { userId, embedding: { not: null } },
    select: { id: true, title: true, embedding: true },
  });
  const queryVector = await embed(rawQuery);
  const exclude = new Set(exactIds);
  const semantic = candidates
    .filter((c) => !exclude.has(c.id) && c.embedding)
    .map((c) => ({ id: c.id, score: cosine(queryVector, fromBlob(c.embedding!)) }))
    .filter((c) => c.score >= FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_LIMIT);
  return { exact: items, semantic };
}

function stats(samples: number[]): { median: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}
const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

// ── Measure ───────────────────────────────────────────────────────
console.log(color.bold(`\nEnd-to-end search: old serial pipeline vs split paths`));
console.log(color.dim(`items=${ITEMS} iters=${ITERS} net-ms=${NET_MS} floor=${FLOOR}\n`));

// Old: keyword results arrive when EVERYTHING arrives. Distinct queries would
// change nothing (it has no cache); the fixed query keeps FTS hits realistic.
const oldTimes: number[] = [];
for (let i = 0; i < ITERS; i++) {
  const t0 = performance.now();
  await oldSearch(user.id, QUERY);
  oldTimes.push(performance.now() - t0);
}

// New exact: never touches the network at any --net-ms.
const exactTimes: number[] = [];
let exactHits = 0;
for (let i = 0; i < ITERS; i++) {
  const t0 = performance.now();
  const r = await searchExact(user.id, QUERY);
  exactTimes.push(performance.now() - t0);
  exactHits = r.exact.length;
}

// New semantic, cold: fresh query text (embed LRU miss) and an invalidated
// matrix — the worst case, i.e. the library changed between queries.
const coldTimes: number[] = [];
for (let i = 0; i < ITERS; i++) {
  invalidateUserMatrix();
  const t0 = performance.now();
  await searchSemantic(user.id, `${QUERY} variation ${i}`, []);
  coldTimes.push(performance.now() - t0);
}

// New semantic, warm: the repeat query. Prime once, then measure.
await searchSemantic(user.id, QUERY, []);
const warmTimes: number[] = [];
let warmCached = false;
for (let i = 0; i < ITERS; i++) {
  const t0 = performance.now();
  const r = await searchSemantic(user.id, QUERY, []);
  warmTimes.push(performance.now() - t0);
  warmCached = r.phases.embedCached ?? false;
}

const o = stats(oldTimes);
const e = stats(exactTimes);
const c = stats(coldTimes);
const w = stats(warmTimes);

const rows: Array<[string, { median: number; p95: number }, string]> = [
  ["old pipeline (keyword+semantic in one)", o, "keyword results held hostage to the network"],
  ["new: searchExact (keyword)", e, "time-to-keyword-results — no network in path"],
  ["new: searchSemantic, cold", c, "new query + library changed"],
  ["new: searchSemantic, warm (repeat)", w, "embedding LRU + packed matrix"],
];

const label = (s: string) => s.padEnd(42);
console.log(`${label("path")} │ ${"median".padStart(9)} │ ${"p95".padStart(9)}`);
console.log("─".repeat(70));
for (const [name, s, note] of rows) {
  console.log(
    `${label(name)} │ ${`${fmt(s.median)}ms`.padStart(9)} │ ${`${fmt(s.p95)}ms`.padStart(9)}  ${color.dim(note)}`
  );
}

const keywordSpeedup = o.median / Math.max(e.median, 0.01);
const warmSpeedup = o.median / Math.max(w.median, 0.01);
console.log(
  `\n${color.green(color.bold(`time-to-keyword-results: ${keywordSpeedup.toFixed(1)}x faster`))} ` +
    color.dim(`(${fmt(o.median)}ms -> ${fmt(e.median)}ms at net-ms=${NET_MS})`)
);
console.log(
  `${color.green(color.bold(`repeat semantic query:   ${warmSpeedup.toFixed(1)}x faster`))} ` +
    color.dim(`(${fmt(o.median)}ms -> ${fmt(w.median)}ms)`)
);

// ── Behaviour gates ───────────────────────────────────────────────
console.log("");
check("keyword search returns hits", exactHits > 0, `got ${exactHits}`);
check("warm semantic used the embedding cache", warmCached);

// Fail-soft: the network dies, keyword search must not notice.
stubMode = "down";
const failSoftSem = await searchSemantic(user.id, "a query never seen before", []);
const failSoftExact = await searchExact(user.id, QUERY);
check(
  "network down: semantic degrades to unavailable",
  failSoftSem.semanticStatus === "unavailable",
  failSoftSem.semanticStatus
);
check(
  "network down: keyword results unaffected",
  failSoftExact.exact.length === exactHits,
  `got ${failSoftExact.exact.length}`
);
stubMode = "ok";

// No key: semantic reports unavailable without touching the network.
const callsBefore = stubCalls;
delete process.env.OPENROUTER_API_KEY;
const noKey = await searchSemantic(user.id, "another unseen query", []);
check("no API key: semantic reports unavailable", noKey.semanticStatus === "unavailable");
check("no API key: zero network calls", stubCalls === callsBefore, `calls ${stubCalls - callsBefore}`);

// ── Cleanup ───────────────────────────────────────────────────────
await prisma.$disconnect();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can hold the file briefly; a leaked temp dir is not a failure.
}

console.log(failed ? color.red(`\n${failed} FAILED`) : color.green("\nall gates passed"));
process.exit(failed ? 1 : 0);
