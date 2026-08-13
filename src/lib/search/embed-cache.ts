/**
 * LRU cache of query embeddings.
 *
 * Retyping a search — or refining one word of it and coming back — used to
 * cost a full OpenRouter round trip every time, and that round trip is the
 * dominant term in semantic search latency. The mapping (model, text) →
 * vector cannot go stale, and EMBED_MODEL is fixed at module load, so there
 * is no TTL: entries leave only by LRU eviction. 256 vectors × 6 KB is
 * ~1.5 MB, bounded by SEARCH_EMBED_CACHE_SIZE.
 *
 * Vectors are a pure function of the text, not of the user, so one cache is
 * shared across users — nothing user-owned is in here.
 */

import { embed } from "./embed";
import { readPositiveInt } from "@/lib/env";

/** Cheap relative to an article; matches MAX_CHARS in embed.ts. */
const MAX_CHARS = 8_000;

/**
 * The cache key for a query string.
 *
 * NFC first, so "café" typed composed and decomposed is one entry; then the
 * whitespace differences embed() itself would erase. Case is preserved —
 * the embedding model sees case, so folding it would return subtly wrong
 * vectors for the sake of a few extra hits.
 */
export function normalizeEmbedKey(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, MAX_CHARS);
}

export function createEmbedCache(
  embedFn: (text: string) => Promise<Float32Array>,
  capacity: number
): {
  get(raw: string): Promise<Float32Array>;
  has(raw: string): boolean;
  size(): number;
} {
  // Map iterates in insertion order, so re-inserting on every hit makes the
  // first key the least recently used — the standard Map-as-LRU trick.
  //
  // The value is the promise, not the vector: two concurrent identical
  // queries (easy to produce by typing during an in-flight search) share one
  // fetch instead of racing two.
  const entries = new Map<string, Promise<Float32Array>>();

  return {
    get(raw: string): Promise<Float32Array> {
      const key = normalizeEmbedKey(raw);

      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }

      const pending = embedFn(key);
      // A rejection is deleted, never served twice: caching "the network was
      // down at 9:14" would pin that outage to this query for the life of the
      // process (the ensureSearchIndex self-heal pattern). The catch here only
      // evicts — callers still see the original rejection from `pending`.
      pending.catch(() => {
        if (entries.get(key) === pending) entries.delete(key);
      });

      entries.set(key, pending);
      if (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return pending;
    },

    has(raw: string): boolean {
      return entries.has(normalizeEmbedKey(raw));
    },

    size(): number {
      return entries.size;
    },
  };
}

/** The shared instance searches go through. */
export const queryEmbedCache = createEmbedCache(
  embed,
  readPositiveInt("SEARCH_EMBED_CACHE_SIZE", 256, "search")
);
