/**
 * The semantic graph: how saved items relate to each other.
 *
 * Semantic search answers "what is like this query?". This answers a different
 * question — "how do the things I save relate to each other?" — from the same
 * vectors, with no new API calls. The arithmetic is local; the embeddings were
 * already paid for at capture time.
 *
 * Two measurements shaped everything below. Both are worth reading before
 * changing any constant here.
 *
 * ── 1. Vectors arrive L2-normalised ──────────────────────────────
 * Measured on the production library: norms 0.999387, 1.000158, 1.000000,
 * 0.999504. Cosine is therefore just the dot product.
 *
 * `cosine()` in search/embed.ts computes both magnitudes defensively, which is
 * right for search — it runs once per item against one query, and a wrong
 * score there is worse than a few microseconds. Here the loop is O(n²), where
 * that defensiveness is three times the arithmetic for no benefit. So this
 * module normalises once, up front, and then uses a bare dot product. The
 * normalisation pass is what makes that safe, and it is not optional.
 *
 * ── 2. Absolute similarity does not mean what it looks like ──────
 * Measured across 21,321 real pairs (207 documents: the library plus the
 * recommendation candidate pool):
 *
 *     min -0.056   p50 0.241   p90 0.417   p99 0.571   max 1.000
 *
 * Two *unrelated* long documents still score ~0.24, because they share the
 * "this is long English prose" direction. sources/similar.ts found the same
 * thing independently and painfully: its first floor of 0.38 shipped visibly
 * bad recommendations, because unrelated HN-frontpage pairs reach 0.41.
 *
 * So a fixed threshold cannot separate "related" from "both are prose" — the
 * number that means "strong" depends entirely on the corpus. 0.43 sounds high
 * and is merely the 90th percentile: one random pair in ten scores that well.
 *
 * The fix is to calibrate against the user's own library rather than hardcode.
 * Edges are banded by their percentile within this corpus (see EdgeStrength),
 * so "strong" means "stronger than 99% of pairs here" — which stays true if
 * the embedding model changes, or if someone's library is all one topic.
 *
 * Mean-centering the corpus was tried and rejected: it is the standard fix for
 * the shared-prose direction, but measured on the same 207 documents it left
 * neighbour *rankings* essentially unchanged while reducing spread (sd 0.118
 * -> 0.103). Top-k depends only on ordering, so it bought nothing.
 */

import { prisma } from "@/lib/db";
import { fromBlob } from "@/lib/search/embed";
import { readUnitFloat, readPositiveInt } from "@/lib/env";

export type EdgeStrength = "strong" | "moderate" | "weak";

export type GraphNode = {
  id: string;
  title: string;
  siteName: string | null;
  url: string;
  kind: string;
  status: string;
  starred: boolean;
  wordCount: number | null;
  savedAt: Date;
  /** False for items never embedded — shown, but unconnected. */
  linked: boolean;
};

export type GraphEdge = {
  source: string;
  target: string;
  /** Raw cosine, 0-1. Kept for the tooltip; do not threshold on it directly. */
  score: number;
  /** Percentile of this score within this corpus, 0-1. The honest number. */
  percentile: number;
  strength: EdgeStrength;
  /** True when both nodes independently chose each other as a top-k neighbour. */
  mutual: boolean;
  /** Score >= DUPLICATE_AT: almost certainly the same article saved twice. */
  duplicate: boolean;
};

export type GraphStats = {
  /** Percentile cut-offs derived from this corpus, for the legend. */
  moderateAt: number;
  strongAt: number;
  /** Documents that had no embedding and so could not be linked. */
  unlinked: number;
  /** Items omitted by the node cap. Surfaced in the UI — never a silent cap. */
  truncated: number;
  pairsScored: number;
  tookMs: number;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
};

/**
 * Neighbours kept per node. Top-k rather than a global threshold because k is
 * invariant to library size and to wherever the similarity distribution
 * happens to sit — the graph stays readable at 10 items and at 2,000, and no
 * node is ever stranded. Edge count is bounded by n*k, so it cannot hairball.
 */
const DEFAULT_K = 4;
const MIN_K = 2;
const MAX_K = 8;

/**
 * A pure noise guard, not a relevance threshold — the banding does that work.
 * Set below the lowest score observed between real documents (0.183) so it
 * only ever excludes genuine junk.
 *
 * NOT the same quantity as OPENROUTER_SEMANTIC_FLOOR (query-to-document) or
 * RIGHTREAD_REC_FLOOR (document-to-document, but precision-first for
 * recommendations). The three names look interchangeable and are not.
 */
const DEFAULT_EDGE_FLOOR = 0.15;

/** At or above this, two documents are the same text. Flagged, not hidden. */
const DUPLICATE_AT = 0.99;

/** Percentile boundaries for the three bands. */
// Exported for lib/graph/bands.ts, which estimates the same bands from a
// sampled histogram so the reader page never pays this file's full O(n²) build.
// The two derivations must share these definitions or "moderate" would quietly
// mean different things on the graph page and in the reader.
export const MODERATE_PERCENTILE = 0.9;
export const STRONG_PERCENTILE = 0.99;

const EDGE_FLOOR = readUnitFloat("GRAPH_EDGE_FLOOR", DEFAULT_EDGE_FLOOR, "graph");
const MAX_NODES = readPositiveInt("GRAPH_MAX_NODES", 2000, "graph");

/**
 * Histogram resolution for percentile estimation. Scores live in [-1, 1], so
 * 400 buckets is a resolution of 0.005 — far finer than any decision made from
 * it, at O(1) memory instead of the O(n²) of keeping every score.
 */
const BUCKETS = 400;

export function clampK(raw: unknown): number {
  // Absent means "use the default", which is not the same as "out of range".
  // Number(null) is 0 — an integer — so without this null would clamp to
  // MIN_K and quietly give a sparser graph than asked for.
  if (raw === null || raw === undefined || raw === "") return DEFAULT_K;
  const k = Number(raw);
  if (!Number.isInteger(k)) return DEFAULT_K;
  return Math.min(MAX_K, Math.max(MIN_K, k));
}

type Row = {
  id: string;
  title: string;
  siteName: string | null;
  url: string;
  kind: string;
  status: string;
  starred: boolean;
  wordCount: number | null;
  savedAt: Date;
  embedding: Uint8Array | null;
};

/** Keyed by userId. Invalidated by a version string, not by a timer. */
const cache = new Map<string, { version: string; k: number; graph: Graph }>();

/**
 * Cheap enough to run on every request: two aggregates, no vectors loaded.
 * Any insert, delete or edit moves one of them, so the graph recomputes
 * exactly when the library changes and not otherwise.
 *
 * Same single-process caveat as lib/events.ts — with more than one container
 * each holds its own cache. That degrades to recomputation, not to staleness,
 * because the version is read from the database every time.
 */
async function libraryVersion(userId: string, status: string): Promise<string> {
  const [agg] = await prisma.$queryRawUnsafe<{ n: bigint; t: string | null }[]>(
    `SELECT count(*) AS n, max(updatedAt) AS t FROM Item WHERE userId = ?`,
    userId
  );
  return `${status}:${agg.n}:${agg.t ?? "-"}`;
}

export async function buildGraph(
  userId: string,
  opts: { status?: "all" | "unread" | "archived"; k?: number } = {}
): Promise<Graph> {
  const status = opts.status ?? "all";
  const k = clampK(opts.k ?? DEFAULT_K);

  const version = await libraryVersion(userId, status);
  const hit = cache.get(userId);
  if (hit && hit.version === version && hit.k === k) return hit.graph;

  const started = Date.now();

  const rows = (await prisma.item.findMany({
    where: { userId, ...(status === "all" ? {} : { status }) },
    select: {
      id: true,
      title: true,
      siteName: true,
      url: true,
      kind: true,
      status: true,
      starred: true,
      wordCount: true,
      savedAt: true,
      embedding: true,
    },
    // Most recent first, so the cap drops the oldest rather than an arbitrary set.
    orderBy: { savedAt: "desc" },
    take: MAX_NODES,
  })) as Row[];

  const total = await prisma.item.count({
    where: { userId, ...(status === "all" ? {} : { status }) },
  });

  const graph = computeGraph(rows, k, {
    truncated: Math.max(0, total - rows.length),
    startedAt: started,
  });

  cache.set(userId, { version, k, graph });
  return graph;
}

/**
 * The pure half — no database, no clock beyond the caller's. Split out so the
 * tests can drive it with synthetic vectors and no Prisma.
 */
export function computeGraph(
  rows: Row[],
  k: number,
  meta: { truncated: number; startedAt: number }
): Graph {
  const embedded = rows.filter((r) => r.embedding);
  const n = embedded.length;

  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    siteName: r.siteName,
    url: r.url,
    kind: r.kind,
    status: r.status,
    starred: r.starred,
    wordCount: r.wordCount,
    savedAt: r.savedAt,
    linked: Boolean(r.embedding),
  }));

  const stats: GraphStats = {
    moderateAt: 0,
    strongAt: 0,
    unlinked: rows.length - n,
    truncated: meta.truncated,
    pairsScored: 0,
    tookMs: 0,
  };

  // One or zero embedded items cannot have an edge. Returning early also
  // avoids dividing by a zero-length histogram below.
  if (n < 2) {
    stats.tookMs = Date.now() - meta.startedAt;
    return { nodes, edges: [], stats };
  }

  // ── Pack and normalise ───────────────────────────────────────────
  // One contiguous buffer rather than n separate Float32Arrays: the O(n²) loop
  // walks these sequentially, and locality dominates at this size.
  const dims = fromBlob(embedded[0].embedding!).length;
  const flat = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    const v = fromBlob(embedded[i].embedding!);
    // A vector of the wrong width cannot be compared; leave it zeroed, which
    // scores 0 against everything and so simply never becomes an edge.
    if (v.length !== dims) continue;
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const base = i * dims;
    for (let d = 0; d < dims; d++) flat[base + d] = v[d] / norm;
  }

  // ── Score every pair once ────────────────────────────────────────
  // Upper triangle only. Each node keeps a bounded top-k list, so peak memory
  // is O(n*k) rather than the O(n²) of materialising every score.
  const top: Array<Array<{ j: number; s: number }>> = Array.from(
    { length: n },
    () => []
  );
  const histogram = new Int32Array(BUCKETS);
  let pairs = 0;

  const offer = (list: Array<{ j: number; s: number }>, j: number, s: number) => {
    if (list.length < k) {
      list.push({ j, s });
      if (list.length === k) list.sort((a, b) => a.s - b.s);
      return;
    }
    // Kept ascending, so index 0 is the weakest currently held.
    if (s <= list[0].s) return;
    list[0] = { j, s };
    list.sort((a, b) => a.s - b.s);
  };

  for (let i = 0; i < n; i++) {
    const bi = i * dims;
    for (let j = i + 1; j < n; j++) {
      const bj = j * dims;
      let s = 0;
      for (let d = 0; d < dims; d++) s += flat[bi + d] * flat[bj + d];

      pairs++;
      const bucket = Math.min(
        BUCKETS - 1,
        Math.max(0, Math.floor(((s + 1) / 2) * BUCKETS))
      );
      histogram[bucket]++;

      if (s < EDGE_FLOOR) continue;
      offer(top[i], j, s);
      offer(top[j], i, s);
    }
  }

  // ── Calibrate the bands against this corpus ──────────────────────
  const moderateAt = percentileFromHistogram(histogram, pairs, MODERATE_PERCENTILE);
  const strongAt = percentileFromHistogram(histogram, pairs, STRONG_PERCENTILE);

  // ── Union the directed top-k sets into undirected edges ──────────
  const chosen = new Map<string, { i: number; j: number; s: number; both: boolean }>();
  for (let i = 0; i < n; i++) {
    for (const { j, s } of top[i]) {
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const key = `${a}:${b}`;
      const existing = chosen.get(key);
      // Seeing the same pair from both sides means each chose the other.
      if (existing) existing.both = true;
      else chosen.set(key, { i: a, j: b, s, both: false });
    }
  }

  const edges: GraphEdge[] = [...chosen.values()]
    .map(({ i, j, s, both }) => ({
      source: embedded[i].id,
      target: embedded[j].id,
      score: s,
      percentile: percentileOf(histogram, pairs, s),
      strength: (s >= strongAt ? "strong" : s >= moderateAt ? "moderate" : "weak") as EdgeStrength,
      mutual: both,
      duplicate: s >= DUPLICATE_AT,
    }))
    .sort((a, b) => b.score - a.score);

  stats.moderateAt = moderateAt;
  stats.strongAt = strongAt;
  stats.pairsScored = pairs;
  stats.tookMs = Date.now() - meta.startedAt;

  return { nodes, edges, stats };
}

/** Score at the given percentile, read off the histogram. */
export function percentileFromHistogram(
  histogram: Int32Array,
  total: number,
  p: number
): number {
  if (total === 0) return 0;
  const target = total * p;
  let seen = 0;
  for (let b = 0; b < histogram.length; b++) {
    seen += histogram[b];
    if (seen >= target) return (b / histogram.length) * 2 - 1;
  }
  return 1;
}

/** The inverse: what fraction of pairs score at or below this value. */
function percentileOf(histogram: Int32Array, total: number, score: number): number {
  if (total === 0) return 0;
  const bucket = Math.min(
    histogram.length - 1,
    Math.max(0, Math.floor(((score + 1) / 2) * histogram.length))
  );
  let seen = 0;
  for (let b = 0; b <= bucket; b++) seen += histogram[b];
  return seen / total;
}
