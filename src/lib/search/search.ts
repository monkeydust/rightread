import { prisma } from "@/lib/db";
import { ensureSearchIndex } from "./index-schema";
import { parseQuery } from "./query";
import { readFloor, EmbeddingUnavailableError } from "./embed";
import { queryEmbedCache } from "./embed-cache";
import { getUserMatrix } from "./matrix-cache";
import { topKSimilar } from "./vectors";

export type SearchHit = {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  kind: string;
  status: string;
  starred: boolean;
  savedAt: Date;
  wordCount: number | null;
  /**
   * Keyword hits only. Matched terms are delimited by U+0001 and U+0002 rather
   * than <mark> tags: this text comes from arbitrary web pages, and returning
   * HTML the client would have to render as HTML is an injection vector for
   * anything a page happened to contain. The client splits on the sentinels
   * and builds real elements, so the text is never parsed as markup.
   */
  snippet?: string | null;
  /** Semantic hits only: 0-1 cosine similarity. */
  score?: number;
};

/**
 * Where a request's time went. Phases overlap — the embedding round trip runs
 * concurrently with database work — so the sum may legitimately exceed tookMs.
 * That is the point of the parallelism, not a bug in the numbers.
 */
export type SearchPhases = {
  ftsMs?: number;
  loadMs?: number;
  embedMs?: number;
  scoreMs?: number;
  /** True when the query vector came from the LRU rather than the network. */
  embedCached?: boolean;
};

export type ExactResults = {
  query: string;
  hasWildcard: boolean;
  exact: SearchHit[];
  tookMs: number;
  phases: SearchPhases;
};

export type SemanticResults = {
  query: string;
  semantic: SearchHit[];
  /** Why semantic returned nothing, when it returned nothing for a reason. */
  semanticStatus: "ok" | "unavailable" | "not-indexed" | "skipped";
  tookMs: number;
  phases: SearchPhases;
};

/** The combined shape, kept for callers that want both groups in one call. */
export type SearchResults = {
  query: string;
  hasWildcard: boolean;
  exact: SearchHit[];
  semantic: SearchHit[];
  semanticStatus: SemanticResults["semanticStatus"];
  tookMs: number;
};

const EXACT_LIMIT = 50;
const SEMANTIC_LIMIT = 10;

/** Measured cut-off below which semantic hits are noise; see readFloor. */
const SEMANTIC_FLOOR = readFloor();

type Row = {
  itemId: string;
  snippet: string;
};

/**
 * Keyword search alone: FTS5 plus one metadata read, nothing else.
 *
 * Split from semantic search so this path NEVER waits on the embedding
 * network round trip. The two used to travel in one response, which chained
 * ~1 ms of SQLite behind hundreds of milliseconds of OpenRouter — the
 * keyword results were never slow to compute, only slow to arrive.
 */
export async function searchExact(
  userId: string,
  rawQuery: string
): Promise<ExactResults> {
  const started = Date.now();
  const phases: SearchPhases = {};
  const parsed = parseQuery(rawQuery);

  if (!parsed.match) {
    return {
      query: rawQuery,
      hasWildcard: false,
      exact: [],
      tookMs: Date.now() - started,
      phases,
    };
  }

  await ensureSearchIndex();

  // ── Exact: FTS5, ranked by bm25 ────────────────────────────────
  // Column weights: a term in the title matters far more than the same term
  // buried in the body. bm25() returns a negative score, lower being better.
  const ftsStarted = Date.now();
  let rows: Row[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT itemId,
              snippet(ItemSearch, 4, char(1), char(2), '…', 18) AS snippet
         FROM ItemSearch
        WHERE ItemSearch MATCH ?
          AND userId = ?
        ORDER BY bm25(ItemSearch, 0.0, 0.0, 10.0, 4.0, 1.0, 2.0)
        LIMIT ${EXACT_LIMIT}`,
      parsed.match,
      userId
    );
  } catch (err) {
    // parseQuery should make this unreachable; if a query still gets through,
    // degrade to "no keyword results" rather than failing the whole search.
    console.warn(`[search] FTS query failed for ${JSON.stringify(parsed.match)}:`, err);
  }
  phases.ftsMs = Date.now() - ftsStarted;

  const exactIds = rows.map((r) => r.itemId);
  const snippets = new Map(rows.map((r) => [r.itemId, r.snippet]));

  const loadStarted = Date.now();
  const items = await loadItems(userId, exactIds);
  phases.loadMs = Date.now() - loadStarted;

  // Preserve bm25 ordering, which the IN query does not.
  const byId = new Map(items.map((i) => [i.id, i]));
  const exact: SearchHit[] = exactIds
    .map((id) => byId.get(id))
    .filter((i): i is (typeof items)[number] => Boolean(i))
    .map((i) => ({ ...i, snippet: snippets.get(i.id) ?? null }));

  return {
    query: rawQuery,
    hasWildcard: parsed.hasWildcard,
    exact,
    tookMs: Date.now() - started,
    phases,
  };
}

/**
 * Semantic search alone: cosine over stored vectors.
 *
 * The two slow, query-independent pieces are cached — the query embedding in
 * an LRU (a repeat query never touches the network) and the packed,
 * normalised vector matrix per user (the blob load and norms are not redone
 * per keystroke). On a cold query both remaining loads run concurrently, so
 * the database work hides entirely inside the network wait.
 *
 * `excludeIds` carries the keyword hits so a fact is not repeated as a guess.
 */
export async function searchSemantic(
  userId: string,
  rawQuery: string,
  excludeIds: string[] = []
): Promise<SemanticResults> {
  const started = Date.now();
  const phases: SearchPhases = {};

  const done = (
    semantic: SearchHit[],
    semanticStatus: SemanticResults["semanticStatus"]
  ): SemanticResults => ({
    query: rawQuery,
    semantic,
    semanticStatus,
    tookMs: Date.now() - started,
    phases,
  });

  if (!rawQuery.trim()) return done([], "skipped");

  // Nothing to score and nothing to score with — decided before any vector
  // is loaded. This deliberately reports an empty library as "unavailable"
  // when the key is missing: the actionable problem is the key.
  if (!process.env.OPENROUTER_API_KEY) return done([], "unavailable");

  phases.embedCached = queryEmbedCache.has(rawQuery);

  // Fired together on purpose: the matrix load is pure database work, the
  // embedding is pure network, and neither needs the other. The immediate
  // no-op catch stops an early rejection of one becoming an unhandled
  // rejection while the other is still being awaited.
  const embedStarted = Date.now();
  const vectorPromise = queryEmbedCache.get(rawQuery);
  const matrixPromise = getUserMatrix(userId);
  vectorPromise.catch(() => {});
  matrixPromise.catch(() => {});

  let queryVector: Float32Array;
  try {
    queryVector = await vectorPromise;
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    console.warn("[search] semantic unavailable:", err.message);
    return done([], "unavailable");
  }
  phases.embedMs = Date.now() - embedStarted;

  const matrix = await matrixPromise;
  if (matrix.ids.length === 0) return done([], "not-indexed");

  const scoreStarted = Date.now();
  const top = topKSimilar(matrix, queryVector, {
    floor: SEMANTIC_FLOOR,
    limit: SEMANTIC_LIMIT,
    // Anything already found by keyword is a fact, not a suggestion — showing
    // it again under "related" would be noise.
    exclude: new Set(excludeIds),
  });
  phases.scoreMs = Date.now() - scoreStarted;

  const loadStarted = Date.now();
  const items = await loadItems(userId, top.map((t) => t.id));
  phases.loadMs = Date.now() - loadStarted;

  // Restore score order — the IN query returns rows in storage order.
  const byId = new Map(items.map((i) => [i.id, i]));
  const semantic: SearchHit[] = top
    .map(({ id, score }) => {
      const item = byId.get(id);
      return item ? { ...item, score } : null;
    })
    .filter((h): h is SearchHit & { score: number } => h !== null);

  return done(semantic, "ok");
}

/**
 * Both groups in one call, for callers that want the old combined shape.
 *
 * They are deliberately not merged into one ranked list. A keyword hit is a
 * fact — the words are on the page — while a semantic hit is a guess, and
 * blending the two into a single order hides which is which. The caller shows
 * them as two labelled groups.
 */
export async function search(
  userId: string,
  rawQuery: string
): Promise<SearchResults> {
  const started = Date.now();

  const exactResults = await searchExact(userId, rawQuery);
  const parsed = parseQuery(rawQuery);
  const semanticResults = parsed.match
    ? await searchSemantic(userId, rawQuery, exactResults.exact.map((h) => h.id))
    : { semantic: [], semanticStatus: "skipped" as const };

  return {
    query: rawQuery,
    hasWildcard: exactResults.hasWildcard,
    exact: exactResults.exact,
    semantic: semanticResults.semantic,
    semanticStatus: semanticResults.semanticStatus,
    tookMs: Date.now() - started,
  };
}

function loadItems(userId: string, ids: string[]) {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.item.findMany({
    where: { userId, id: { in: ids } },
    select: {
      id: true,
      url: true,
      title: true,
      siteName: true,
      excerpt: true,
      kind: true,
      status: true,
      starred: true,
      savedAt: true,
      wordCount: true,
    },
  });
}
