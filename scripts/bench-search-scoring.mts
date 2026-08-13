/**
 * Micro-benchmark of the semantic scoring hot path: the old per-query work
 * (unpack every blob, full cosine per row) against the new one (pack and
 * normalise once, bare dot product per row).
 *
 * Offline and deterministic — synthetic vectors from a seeded PRNG, no
 * network, no database — so the numbers are comparable run to run and
 * machine to machine. The parity gate makes this double as a correctness
 * check: if the fast path ever ranks differently from the old one, the
 * benchmark exits 1 rather than reporting a speedup for wrong answers.
 *
 *   npm run bench:search
 *   npm run bench:search -- --n 1000,10000,50000 --dims 1536 --iters 20
 */

import { packMatrix, topKSimilar } from "../src/lib/search/vectors.ts";
import { cosine, fromBlob, toBlob } from "../src/lib/search/embed.ts";

const color = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SIZES = arg("n", "1000,10000,50000").split(",").map(Number);
const DIMS = Number(arg("dims", "1536"));
const ITERS = Number(arg("iters", "20"));
const FLOOR = 0.05;
const LIMIT = 10;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let d = 0; d < DIMS; d++) v[d] = rand() * 2 - 1;
  return v;
}

function stats(samples: number[]): { median: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2);
}

console.log(color.bold(`\nSemantic scoring: old cosine path vs packed matrix`));
console.log(color.dim(`dims=${DIMS} floor=${FLOOR} limit=${LIMIT} iters=${ITERS}\n`));

const header = `${"n".padStart(7)} │ ${"old/query".padStart(12)} │ ${"new cold".padStart(12)} │ ${"new warm".padStart(12)} │ ${"warm speedup".padStart(12)}`;
console.log(header);
console.log("─".repeat(header.length + 2));

let parityFailed = false;

for (const n of SIZES) {
  const rand = mulberry32(1234 + n);
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    embedding: toBlob(randomVector(rand)) as Uint8Array | null,
  }));
  const queries = Array.from({ length: ITERS }, () => randomVector(rand));

  // ── Old path: per query, unpack every blob and run full cosine ──
  const oldTimes: number[] = [];
  let oldTop: string[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const scored = rows
      .map((r) => ({ id: r.id, score: cosine(q, fromBlob(r.embedding!)) }))
      .filter((r) => r.score >= FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT);
    oldTimes.push(performance.now() - t0);
    oldTop = scored.map((s) => s.id);
  }

  // ── New, cold: pack + score (a library change invalidated the cache) ──
  const coldTimes: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const m = packMatrix(rows);
    topKSimilar(m, q, { floor: FLOOR, limit: LIMIT });
    coldTimes.push(performance.now() - t0);
  }

  // ── New, warm: matrix already packed (every query after the first) ──
  const matrix = packMatrix(rows);
  const warmTimes: number[] = [];
  let newTop: string[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const hits = topKSimilar(matrix, q, { floor: FLOOR, limit: LIMIT });
    warmTimes.push(performance.now() - t0);
    newTop = hits.map((h) => h.id);
  }

  // ── Parity gate: same last query must rank identically ──
  const match = JSON.stringify(oldTop) === JSON.stringify(newTop);
  if (!match) {
    parityFailed = true;
    console.log(color.red(`  PARITY FAIL at n=${n}:`));
    console.log(`    old ${JSON.stringify(oldTop)}`);
    console.log(`    new ${JSON.stringify(newTop)}`);
  }

  const o = stats(oldTimes);
  const c = stats(coldTimes);
  const w = stats(warmTimes);
  const speedup = o.median / Math.max(w.median, 0.0001);

  console.log(
    `${String(n).padStart(7)} │ ${`${fmt(o.median)}ms`.padStart(12)} │ ${`${fmt(c.median)}ms`.padStart(12)} │ ${`${fmt(w.median)}ms`.padStart(12)} │ ${color.green(`${speedup.toFixed(1)}x`.padStart(12))}`
  );
  console.log(
    color.dim(
      `${"p95".padStart(7)} │ ${`${fmt(o.p95)}ms`.padStart(12)} │ ${`${fmt(c.p95)}ms`.padStart(12)} │ ${`${fmt(w.p95)}ms`.padStart(12)} │`
    )
  );
}

console.log(
  parityFailed
    ? color.red("\nPARITY FAILED — the fast path ranks differently; numbers above are void")
    : color.green("\nparity: new path ranks identically to the old cosine path at every size")
);
process.exit(parityFailed ? 1 : 0);
