/**
 * The fast semantic-scoring path and its caches.
 *
 * The load-bearing test is equivalence: topKSimilar must rank exactly as the
 * old per-row cosine(query, fromBlob(blob)) did, because SEMANTIC_FLOOR was
 * measured against those scores — a scorer that is fast but subtly different
 * would silently move the noise floor.
 *
 * Offline by design: no network, no API key, no database.
 */

import { packMatrix, topKSimilar } from "../src/lib/search/vectors.ts";
import { createEmbedCache, normalizeEmbedKey } from "../src/lib/search/embed-cache.ts";
import { cosine, fromBlob, toBlob } from "../src/lib/search/embed.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

/** Deterministic PRNG so a failure reproduces byte-for-byte. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let d = 0; d < dims; d++) v[d] = rand() * 2 - 1;
  return v;
}

// ── Equivalence with the old scorer ───────────────────────────────
{
  const rand = mulberry32(42);
  const DIMS = 32;
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: `item-${i}`,
    embedding: toBlob(randomVector(rand, DIMS)) as Uint8Array | null,
  }));
  const query = randomVector(rand, DIMS);

  // The old path, verbatim in miniature: full cosine per row, sort, slice.
  const oldScores = rows
    .map((r) => ({ id: r.id, score: cosine(query, fromBlob(r.embedding!)) }))
    .filter((r) => r.score >= 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const matrix = packMatrix(rows);
  const newScores = topKSimilar(matrix, query, { floor: 0.05, limit: 10 });

  check(
    "same ids in the same order as the old cosine path",
    JSON.stringify(newScores.map((s) => s.id)) ===
      JSON.stringify(oldScores.map((s) => s.id)),
    `old ${JSON.stringify(oldScores.map((s) => s.id))} new ${JSON.stringify(newScores.map((s) => s.id))}`
  );
  check(
    "scores agree within float tolerance",
    newScores.every((s, i) => Math.abs(s.score - oldScores[i].score) < 1e-6),
    JSON.stringify(newScores.map((s, i) => s.score - oldScores[i].score))
  );
}

// ── packMatrix edges ──────────────────────────────────────────────
{
  check("zero rows -> empty matrix", packMatrix([]).ids.length === 0);
  check(
    "all-null rows -> empty matrix",
    packMatrix([{ id: "a", embedding: null }]).ids.length === 0
  );

  const rand = mulberry32(7);
  const good = toBlob(randomVector(rand, 8));
  const wrongWidth = toBlob(randomVector(rand, 4));
  const m = packMatrix([
    { id: "good", embedding: good },
    { id: "null", embedding: null },
    { id: "narrow", embedding: wrongWidth },
  ]);
  check("null rows are dropped, not zero-padded", !m.ids.includes("null"));
  check("wrong-width row kept as id but zeroed", m.ids.includes("narrow"));
  const hits = topKSimilar(m, fromBlob(good), { floor: 0.5, limit: 10 });
  check(
    "wrong-width row never scores",
    hits.length === 1 && hits[0].id === "good",
    JSON.stringify(hits)
  );

  const rows = packMatrix([{ id: "a", embedding: good }]);
  check(
    "query of a different width matches nothing",
    topKSimilar(rows, new Float32Array(16), { floor: 0, limit: 5 }).length === 0
  );
  check(
    "zero query vector matches nothing",
    topKSimilar(rows, new Float32Array(8), { floor: 0, limit: 5 }).length === 0
  );
}

// ── floor / exclude / limit ───────────────────────────────────────
{
  const DIMS = 8;
  // Hand-built so similarities are exact: identical, near, orthogonal.
  const base = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
  const near = new Float32Array([0.9, 0.1, 0, 0, 0, 0, 0, 0]);
  const ortho = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
  const m = packMatrix([
    { id: "same", embedding: toBlob(base) },
    { id: "near", embedding: toBlob(near) },
    { id: "ortho", embedding: toBlob(ortho) },
  ]);

  const all = topKSimilar(m, base, { floor: 0.5, limit: 10 });
  check(
    "floor drops the orthogonal vector",
    all.map((h) => h.id).join(",") === "same,near",
    JSON.stringify(all)
  );

  const excluded = topKSimilar(m, base, {
    floor: 0.5,
    limit: 10,
    exclude: new Set(["same"]),
  });
  check(
    "exclude removes a would-be top hit",
    excluded.map((h) => h.id).join(",") === "near",
    JSON.stringify(excluded)
  );

  const limited = topKSimilar(m, base, { floor: 0, limit: 1 });
  check("limit keeps only the best", limited.length === 1 && limited[0].id === "same");
  check("limit 0 returns nothing", topKSimilar(m, base, { floor: 0, limit: 0 }).length === 0);

  // Bounded top-k with more candidates than the limit, against a full sort.
  const rand = mulberry32(99);
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `v${i}`,
    embedding: toBlob(randomVector(rand, DIMS)) as Uint8Array | null,
  }));
  const q = randomVector(rand, DIMS);
  const wide = packMatrix(many);
  const topk = topKSimilar(wide, q, { floor: -1, limit: 10 });
  const full = many
    .map((r) => ({ id: r.id, score: cosine(q, fromBlob(r.embedding!)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  check(
    "bounded top-k equals a full sort at n=200",
    JSON.stringify(topk.map((h) => h.id)) === JSON.stringify(full.map((h) => h.id)),
    `topk ${JSON.stringify(topk.map((h) => h.id))}`
  );
}

// ── Embed cache ───────────────────────────────────────────────────
{
  check(
    "key: NFC unifies composed and decomposed",
    normalizeEmbedKey("café") === normalizeEmbedKey("café")
  );
  check(
    "key: whitespace collapses, case survives",
    normalizeEmbedKey("  Rust   Async ") === "Rust Async"
  );

  let calls = 0;
  const stub = async (text: string) => {
    calls++;
    return new Float32Array([text.length, 1]);
  };

  const cache = createEmbedCache(stub, 2);

  await cache.get("rust");
  await cache.get("rust");
  check("repeat query embeds once", calls === 1, `calls ${calls}`);

  await cache.get("café");
  await cache.get("café");
  check("NFC variants share one entry", calls === 2, `calls ${calls}`);

  // Concurrent identical queries share the in-flight promise.
  let resolveSlow: (v: Float32Array) => void;
  const slow = createEmbedCache(
    () =>
      new Promise<Float32Array>((r) => {
        calls++;
        resolveSlow = r;
      }),
    4
  );
  const p1 = slow.get("same query");
  const p2 = slow.get("same query");
  resolveSlow!(new Float32Array([1]));
  await Promise.all([p1, p2]);
  check("concurrent identical queries = one fetch", calls === 3, `calls ${calls}`);

  // LRU: capacity 2, third distinct key evicts the least recently used.
  calls = 0;
  const lru = createEmbedCache(stub, 2);
  await lru.get("a");
  await lru.get("b");
  await lru.get("a"); // touch a, making b the LRU
  await lru.get("c"); // evicts b
  check("eviction picks the least recently used", !lru.has("b") && lru.has("a") && lru.has("c"));
  await lru.get("b");
  check("evicted key re-fetches", calls === 4, `calls ${calls}`);

  // Failures are never cached.
  let attempts = 0;
  const flaky = createEmbedCache(async () => {
    attempts++;
    if (attempts === 1) throw new Error("network down");
    return new Float32Array([1]);
  }, 4);
  const first = await flaky.get("q").then(
    () => "ok",
    () => "failed"
  );
  const second = await flaky.get("q").then(
    () => "ok",
    () => "failed"
  );
  check("a failure is surfaced, then retried", first === "failed" && second === "ok", `${first}/${second}`);
  check("the failure was not cached", attempts === 2, `attempts ${attempts}`);
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
