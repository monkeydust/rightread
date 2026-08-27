/**
 * A trail: a short walk through the user's own library, drifting outward.
 *
 * Not a similarity list. Each hop follows a moderate-band connection from the
 * CURRENT stop — strong edges would orbit one cluster, which is the opposite
 * of the point — and among eligible next stops the walk picks the one LEAST
 * similar to the START. That drift objective is what makes five hops end
 * somewhere genuinely far away: each step spends its band-strength budget on
 * moving, not circling.
 *
 * Deterministic at seed 0 (strict argmin, ties by id), which is what lets the
 * trail page be stateless: same library + same start = same trail, so the
 * back button reconstructs the walk instead of a database remembering it.
 * A non-zero seed picks among the three farthest eligible stops per hop, for
 * the "walk a different way" link.
 */

import { prisma } from "@/lib/db";
import { getUserMatrix } from "@/lib/search/matrix-cache";
import { getUserBands, type Bands } from "@/lib/graph/bands";
import type { VectorMatrix } from "@/lib/search/vectors";

export const TRAIL_STOPS = 5;
/** Same-text guard, matching the graph's DUPLICATE_AT. */
const DUP = 0.99;
/** Matching the graph's EDGE_FLOOR: below this a connection is noise. */
const NOISE = 0.15;

export type TrailStop = {
  id: string;
  /** Cosine to the previous stop — "64% like the last stop". */
  simToPrev: number;
  /** Cosine to the start — the honest measure of how far the trail has come. */
  simToStart: number;
};

export type TrailWalk = { stops: TrailStop[]; endedEarly: boolean };

/** Deterministic LCG, the same shape the graph tests use. No Math.random. */
function lcg(seed: number): number {
  const next = (seed * 1103515245 + 12345) & 0x7fffffff;
  return next;
}

/**
 * Pure walk over a packed matrix. Exported for tests.
 *
 * Returns null when the start item is absent or was never embedded — there is
 * no geometry to walk. A thin or fragmented library produces a short walk with
 * `endedEarly: true`, never a padded one.
 */
export function walkTrail(
  matrix: VectorMatrix,
  startId: string,
  bands: Bands,
  opts: { stops?: number; seed?: number } = {}
): TrailWalk | null {
  const { ids, dims, flat } = matrix;
  const stops = opts.stops ?? TRAIL_STOPS;
  const seed = opts.seed ?? 0;

  const start = ids.indexOf(startId);
  if (start === -1) return null;

  const rowOf = (i: number): Float32Array =>
    flat.subarray(i * dims, (i + 1) * dims);

  const simsTo = (i: number): Float32Array => {
    const row = rowOf(i);
    const out = new Float32Array(ids.length);
    for (let j = 0; j < ids.length; j++) {
      const bj = j * dims;
      let s = 0;
      for (let d = 0; d < dims; d++) s += row[d] * flat[bj + d];
      out[j] = s;
    }
    return out;
  };

  const startRow = simsTo(start);
  // An unembedded item is a zero row: similar to nothing, including itself.
  if (startRow[start] < 0.5) return null;

  const visited = new Set<number>([start]);
  const path: TrailStop[] = [{ id: startId, simToPrev: 1, simToStart: 1 }];
  let current = start;
  let rng = seed;

  for (let step = 1; step <= stops; step++) {
    const row = current === start ? startRow : simsTo(current);

    const eligible = (lo: number, hi: number): number[] => {
      const out: number[] = [];
      for (let j = 0; j < ids.length; j++) {
        if (visited.has(j)) continue;
        const s = row[j];
        if (s < lo || s >= hi) continue;
        // Not a near-duplicate of ANY stop already on the trail — a walk that
        // lands on the same article saved twice has not moved.
        let dup = false;
        for (const v of visited) {
          const bv = v * dims;
          const bj = j * dims;
          let sv = 0;
          for (let d = 0; d < dims; d++) sv += flat[bv + d] * flat[bj + d];
          if (sv >= DUP) {
            dup = true;
            break;
          }
        }
        if (!dup) out.push(j);
      }
      return out;
    };

    // The intended hop is the moderate band; a thin corpus widens rather than
    // stops, because a shorter-but-real trail beats no trail — but only down
    // to the noise floor. Below that there is no connection to follow.
    const pool =
      [
        eligible(bands.moderateAt, bands.strongAt),
        eligible(bands.leapAt, bands.strongAt),
        eligible(NOISE, bands.strongAt),
      ].find((p) => p.length > 0) ?? [];

    if (pool.length === 0) break;

    // Farthest-from-start first; ties broken by id so seed 0 is fully
    // deterministic. A non-zero seed picks among the top three drifters.
    pool.sort((a, b) => {
      const diff = startRow[a] - startRow[b];
      if (diff !== 0) return diff;
      return ids[a] < ids[b] ? -1 : 1;
    });

    let pick: number;
    if (seed === 0) {
      pick = pool[0];
    } else {
      rng = lcg(rng + step);
      pick = pool[rng % Math.min(3, pool.length)];
    }

    visited.add(pick);
    path.push({
      id: ids[pick],
      simToPrev: row[pick],
      simToStart: startRow[pick],
    });
    current = pick;
  }

  return { stops: path, endedEarly: path.length < stops + 1 };
}

export type TrailStopDetail = TrailStop & {
  title: string;
  siteName: string | null;
  excerpt: string | null;
  wordCount: number | null;
  status: string;
};

export type Trail = {
  stops: TrailStopDetail[];
  endedEarly: boolean;
  seed: number;
};

/**
 * The walk plus display metadata, or null when it cannot start.
 *
 * `pinnedPath` replays stop ids from the URL instead of recomputing, so a
 * trail survives the library changing mid-walk. Ids are validated against the
 * caller's own items — a pinned path is user input, not a trusted handle.
 */
export async function buildTrail(
  userId: string,
  startId: string,
  opts: { seed?: number; pinnedPath?: string[] } = {}
): Promise<Trail | null> {
  try {
    const seed = opts.seed ?? 0;

    let stops: TrailStop[];
    let endedEarly: boolean;

    if (opts.pinnedPath?.length) {
      const owned = await prisma.item.findMany({
        where: { userId, id: { in: opts.pinnedPath } },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((o) => o.id));
      if (
        opts.pinnedPath.every((id) => ownedIds.has(id)) &&
        opts.pinnedPath[0] === startId
      ) {
        // Recompute the similarity numbers for honest labels, but keep the
        // pinned order rather than re-walking.
        const matrix = await getUserMatrix(userId);
        const index = new Map(matrix.ids.map((id, i) => [id, i]));
        const sim = (a: string, b: string): number => {
          const ia = index.get(a);
          const ib = index.get(b);
          if (ia === undefined || ib === undefined) return 0;
          let s = 0;
          const ba = ia * matrix.dims;
          const bb = ib * matrix.dims;
          for (let d = 0; d < matrix.dims; d++)
            s += matrix.flat[ba + d] * matrix.flat[bb + d];
          return s;
        };
        stops = opts.pinnedPath.map((id, i) => ({
          id,
          simToPrev: i === 0 ? 1 : sim(opts.pinnedPath![i - 1], id),
          simToStart: i === 0 ? 1 : sim(startId, id),
        }));
        endedEarly = stops.length < TRAIL_STOPS + 1;
        return hydrate(userId, stops, endedEarly, seed);
      }
      // A stale or foreign pin falls through to a fresh walk.
    }

    const [matrix, bands] = await Promise.all([
      getUserMatrix(userId),
      getUserBands(userId),
    ]);
    if (!bands) return null;

    const walk = walkTrail(matrix, startId, bands, { seed });
    if (!walk || walk.stops.length < 2) return null;
    return hydrate(userId, walk.stops, walk.endedEarly, seed);
  } catch (err) {
    console.warn(
      `[trail] failed for ${startId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function hydrate(
  userId: string,
  stops: TrailStop[],
  endedEarly: boolean,
  seed: number
): Promise<Trail | null> {
  const rows = await prisma.item.findMany({
    where: { userId, id: { in: stops.map((s) => s.id) } },
    select: {
      id: true,
      title: true,
      siteName: true,
      excerpt: true,
      wordCount: true,
      status: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const detailed: TrailStopDetail[] = [];
  for (const stop of stops) {
    const row = byId.get(stop.id);
    // An item deleted since the walk was pinned simply drops out.
    if (!row) continue;
    detailed.push({ ...stop, ...row });
  }
  if (detailed.length < 2) return null;
  return { stops: detailed, endedEarly, seed };
}
