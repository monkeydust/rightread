/**
 * Per-user cache of the packed, normalised embedding matrix.
 *
 * Loading every stored blob, copying each one out of Prisma's pooled buffer
 * and normalising it is query-independent work — the vectors only change when
 * the library does. So it is done once and invalidated by a version string,
 * the exact pattern of the graph cache in lib/graph/build.ts: two SQL
 * aggregates per request, and any insert, delete or edit (including the
 * backfill script running in another process, which bumps @updatedAt) moves
 * one of them. Multiple containers each hold their own copy, which degrades
 * to recomputation, never to staleness, because the version is read from the
 * database every time.
 *
 * Only ids and vectors live here (~6 KB per item). Titles and excerpts for
 * the handful of winners are fetched fresh per query — caching them would
 * trade a 10-row indexed read for a stale-metadata class of bug.
 */

import { prisma } from "@/lib/db";
import { readPositiveInt } from "@/lib/env";
import { packMatrix, type VectorMatrix } from "./vectors";

const MAX_USERS = readPositiveInt("SEARCH_MATRIX_USERS", 8, "search");

const cache = new Map<string, { version: string; matrix: VectorMatrix }>();

/** Two aggregates, no vectors — cheap enough to run on every search. */
async function libraryVersion(userId: string): Promise<string> {
  const [agg] = await prisma.$queryRawUnsafe<{ n: bigint; t: string | null }[]>(
    `SELECT count(*) AS n, max(updatedAt) AS t FROM Item WHERE userId = ?`,
    userId
  );
  return `${agg.n}:${agg.t ?? "-"}`;
}

export async function getUserMatrix(userId: string): Promise<VectorMatrix> {
  const version = await libraryVersion(userId);

  const hit = cache.get(userId);
  if (hit && hit.version === version) {
    // Map-order LRU: re-insert on hit so eviction below drops the coldest user.
    cache.delete(userId);
    cache.set(userId, hit);
    return hit.matrix;
  }

  const rows = await prisma.item.findMany({
    where: { userId, embedding: { not: null } },
    select: { id: true, embedding: true },
  });

  const matrix = packMatrix(rows);
  cache.set(userId, { version, matrix });
  if (cache.size > MAX_USERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return matrix;
}

/** Drops one user's matrix, or every matrix when called with no argument. */
export function invalidateUserMatrix(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}
