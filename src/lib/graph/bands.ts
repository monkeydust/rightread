/**
 * Similarity bands for a user's library, cheap enough for the reader page.
 *
 * The graph builder derives `moderateAt`/`strongAt` from a histogram of every
 * pairwise cosine in the corpus — the honest, self-calibrating yardstick this
 * codebase settled on after fixed thresholds shipped junk twice. But its cache
 * is private to that module and its cold path is the full O(n²) top-k build:
 * seconds at the node cap, which must never sit on the path to an article.
 *
 * So this estimates the same quantities the same way — same histogram
 * definition, same percentile function, imported from the builder so the two
 * can never drift apart — over a *sample* of pairs from the already-cached
 * embedding matrix. Deterministic stride sampling, capped at MAX_BAND_PAIRS:
 * exact below ~200 items, ~15 ms at worst above, bounded forever. Where both
 * caches happen to be warm the two derivations agree within one histogram
 * bucket (0.005), which is beneath any decision made on them.
 */

import { prisma } from "@/lib/db";
import { getUserMatrix } from "@/lib/search/matrix-cache";
import type { VectorMatrix } from "@/lib/search/vectors";
import {
  percentileFromHistogram,
  MODERATE_PERCENTILE,
  STRONG_PERCENTILE,
} from "@/lib/graph/build";

export type Bands = {
  /** ≥ this: closer than 90% of pairs in this library. */
  moderateAt: number;
  /** ≥ this: closer than 99% — the graph's "strong". */
  strongAt: number;
  /**
   * The 75th percentile: above the "both are long English prose" median
   * (~0.24 measured), below moderate. The window [leapAt, moderateAt) is what
   * the reader calls "a leap" — a weak but real connection.
   */
  leapAt: number;
  pairsSampled: number;
};

/** Below the graph's own percentiles, "leap" is defined here. */
const LEAP_PERCENTILE = 0.75;

/** Same resolution as the graph builder's histogram. */
const BUCKETS = 400;

/** Hard ceiling on sampled pairs, so cost is bounded at any library size. */
const MAX_BAND_PAIRS = 20_000;

/**
 * Percentiles over a handful of pairs are noise, not statistics. Eight items
 * is 28 pairs — about the least that gives the 90th percentile any meaning.
 */
const MIN_ITEMS = 8;

/**
 * Pure band estimation over a packed matrix. Exported for tests.
 *
 * Zero rows (items that were never embedded) are skipped entirely — they score
 * 0 against everything and would drag every percentile toward zero.
 */
export function estimateBands(
  matrix: VectorMatrix,
  maxPairs: number = MAX_BAND_PAIRS
): Bands | null {
  const { ids, dims, flat } = matrix;

  // Rows with actual content. A zero row has zero norm by construction.
  const live: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const base = i * dims;
    let any = 0;
    for (let d = 0; d < dims; d++) any += Math.abs(flat[base + d]);
    if (any > 0) live.push(i);
  }
  if (live.length < MIN_ITEMS) return null;

  const n = live.length;
  const totalPairs = (n * (n - 1)) / 2;
  // Deterministic stride over the upper triangle: every k-th pair in row-major
  // order. Not random — the same library must always produce the same bands,
  // or a page refresh would relabel "a step away" as "a leap".
  const stride = Math.max(1, Math.floor(totalPairs / maxPairs));

  const histogram = new Int32Array(BUCKETS);
  let sampled = 0;
  let pairIndex = 0;

  for (let a = 0; a < n; a++) {
    const bi = live[a] * dims;
    for (let b = a + 1; b < n; b++) {
      if (pairIndex++ % stride !== 0) continue;
      const bj = live[b] * dims;
      let s = 0;
      for (let d = 0; d < dims; d++) s += flat[bi + d] * flat[bj + d];
      const bucket = Math.min(
        BUCKETS - 1,
        Math.max(0, Math.floor(((s + 1) / 2) * BUCKETS))
      );
      histogram[bucket]++;
      sampled++;
    }
  }
  if (sampled === 0) return null;

  return {
    moderateAt: percentileFromHistogram(histogram, sampled, MODERATE_PERCENTILE),
    strongAt: percentileFromHistogram(histogram, sampled, STRONG_PERCENTILE),
    leapAt: percentileFromHistogram(histogram, sampled, LEAP_PERCENTILE),
    pairsSampled: sampled,
  };
}

// ── Per-user cache, the version-string pattern both other caches use ──

const cache = new Map<string, { version: string; bands: Bands | null }>();

async function libraryVersion(userId: string): Promise<string> {
  const [agg] = await prisma.$queryRawUnsafe<{ n: bigint; t: string | null }[]>(
    `SELECT count(*) AS n, max(updatedAt) AS t FROM Item WHERE userId = ?`,
    userId
  );
  return `${agg?.n ?? 0}:${agg?.t ?? ""}`;
}

/**
 * The user's bands, cached until their library changes. Null when the library
 * is too small for percentiles to mean anything — callers render fewer slots,
 * never a padded guess.
 */
export async function getUserBands(userId: string): Promise<Bands | null> {
  const version = await libraryVersion(userId);
  const hit = cache.get(userId);
  if (hit && hit.version === version) return hit.bands;

  const matrix = await getUserMatrix(userId);
  const bands = estimateBands(matrix);
  cache.set(userId, { version, bands });
  return bands;
}
