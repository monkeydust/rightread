/**
 * The scoring half of semantic search, split out pure — no database, no
 * network — the same shape as computeGraph in lib/graph/build.ts, and for the
 * same reason: tests and benchmarks can drive it with synthetic vectors.
 *
 * The old path unpacked every stored blob and ran a full cosine (three
 * multiply-adds per dimension, then two square roots) on every query. Both
 * halves of that work are query-independent: the blob only needs unpacking
 * once, and the norm only needs computing once, because the vectors do not
 * change between queries. packMatrix does that work up front — one contiguous
 * L2-normalised buffer, the layout lifted from the graph's pairwise loop —
 * and topKSimilar is then a bare dot product per row. Scores are identical to
 * cosine() within float tolerance, so the measured SEMANTIC_FLOOR keeps its
 * meaning.
 */

import { fromBlob } from "./embed";

export type VectorMatrix = {
  /** Row order matches ids order. */
  ids: string[];
  dims: number;
  /** n × dims, row-major, each row L2-normalised (or all-zero if unusable). */
  flat: Float32Array;
};

/**
 * Packs stored embedding blobs into one normalised matrix.
 *
 * Width is set by the first usable row. A blob of any other width cannot be
 * compared to the query, and a null one has nothing to compare — both are
 * left as zero rows, which score 0 against everything and so fall under any
 * sane floor rather than throwing or skewing ranks.
 */
export function packMatrix(
  rows: Array<{ id: string; embedding: Uint8Array | null }>
): VectorMatrix {
  const usable = rows.filter((r) => r.embedding && r.embedding.byteLength > 0);
  if (usable.length === 0) return { ids: [], dims: 0, flat: new Float32Array(0) };

  const dims = fromBlob(usable[0].embedding!).length;
  const flat = new Float32Array(usable.length * dims);
  const ids = usable.map((r) => r.id);

  for (let i = 0; i < usable.length; i++) {
    const v = fromBlob(usable[i].embedding!);
    if (v.length !== dims) continue;
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const base = i * dims;
    for (let d = 0; d < dims; d++) flat[base + d] = v[d] / norm;
  }

  return { ids, dims, flat };
}

/**
 * The per-query hot path: normalise the query once, then one dot product per
 * row over the contiguous buffer.
 *
 * Selection is a linear scan keeping a small sorted top-k, not a full sort:
 * limit is ~10 while n may be thousands, so sorting everything would be the
 * majority of the work for none of the answer.
 */
export function topKSimilar(
  matrix: VectorMatrix,
  query: Float32Array,
  opts: { floor: number; limit: number; exclude?: Set<string> }
): Array<{ id: string; score: number }> {
  const { ids, dims, flat } = matrix;
  const n = ids.length;
  if (n === 0 || opts.limit <= 0 || query.length !== dims) return [];

  let qnorm = 0;
  for (let d = 0; d < dims; d++) qnorm += query[d] * query[d];
  qnorm = Math.sqrt(qnorm);
  if (qnorm === 0) return [];

  const q = new Float32Array(dims);
  for (let d = 0; d < dims; d++) q[d] = query[d] / qnorm;

  // Sorted descending; kept at most `limit` long. Insertion into a ≤10-element
  // array is cheaper than it looks and keeps the common no-insert case to a
  // single comparison against the current minimum.
  const top: Array<{ id: string; score: number }> = [];

  for (let i = 0; i < n; i++) {
    if (opts.exclude?.has(ids[i])) continue;

    const base = i * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += q[d] * flat[base + d];

    if (dot < opts.floor) continue;
    if (top.length === opts.limit && dot <= top[top.length - 1].score) continue;

    let at = top.length;
    while (at > 0 && top[at - 1].score < dot) at--;
    top.splice(at, 0, { id: ids[i], score: dot });
    if (top.length > opts.limit) top.pop();
  }

  return top;
}
