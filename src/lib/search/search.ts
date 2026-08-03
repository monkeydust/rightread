import { prisma } from "@/lib/db";
import { ensureSearchIndex } from "./index-schema";
import { parseQuery } from "./query";
import { embed, fromBlob, cosine, EmbeddingUnavailableError } from "./embed";

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

export type SearchResults = {
  query: string;
  hasWildcard: boolean;
  exact: SearchHit[];
  semantic: SearchHit[];
  /** Why semantic returned nothing, when it returned nothing for a reason. */
  semanticStatus: "ok" | "unavailable" | "not-indexed" | "skipped";
  tookMs: number;
};

const EXACT_LIMIT = 50;
const SEMANTIC_LIMIT = 10;

/**
 * Below this, results are noise.
 *
 * Measured on text-embedding-3-small over a real library rather than guessed —
 * an earlier value of 0.34 was set by assumption and sat *above* most genuine
 * matches, so semantic search silently returned nothing:
 *
 *   deliberately irrelevant query ("cooking pasta recipes")   ceiling 0.151
 *   conceptual match ("data races" -> Rust ownership)                0.291
 *   direct match ("ownership" -> Rust ownership)                     0.345
 *   strong match ("react hooks" -> useEffect guide)                  0.542
 *
 * 0.22 clears the noise ceiling with headroom while admitting conceptual
 * matches. It is specific to this embedding model — changing the model means
 * re-measuring, which is what OPENROUTER_SEMANTIC_FLOOR is for.
 */
const SEMANTIC_FLOOR = Number(process.env.OPENROUTER_SEMANTIC_FLOOR ?? 0.22);

type Row = {
  itemId: string;
  snippet: string;
};

/**
 * Keyword and semantic search, returned separately.
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
  const parsed = parseQuery(rawQuery);

  if (!parsed.match) {
    return {
      query: rawQuery,
      hasWildcard: false,
      exact: [],
      semantic: [],
      semanticStatus: "skipped",
      tookMs: Date.now() - started,
    };
  }

  await ensureSearchIndex();

  // ── Exact: FTS5, ranked by bm25 ────────────────────────────────
  // Column weights: a term in the title matters far more than the same term
  // buried in the body. bm25() returns a negative score, lower being better.
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

  const exactIds = rows.map((r) => r.itemId);
  const snippets = new Map(rows.map((r) => [r.itemId, r.snippet]));
  const items = await loadItems(userId, exactIds);

  // Preserve bm25 ordering, which the IN query does not.
  const byId = new Map(items.map((i) => [i.id, i]));
  const exact: SearchHit[] = exactIds
    .map((id) => byId.get(id))
    .filter((i): i is (typeof items)[number] => Boolean(i))
    .map((i) => ({ ...i, snippet: snippets.get(i.id) ?? null }));

  // ── Semantic: cosine over stored vectors ───────────────────────
  const { hits: semantic, status: semanticStatus } = await semanticSearch(
    userId,
    rawQuery,
    new Set(exactIds)
  );

  return {
    query: rawQuery,
    hasWildcard: parsed.hasWildcard,
    exact,
    semantic,
    semanticStatus,
    tookMs: Date.now() - started,
  };
}

async function semanticSearch(
  userId: string,
  rawQuery: string,
  exclude: Set<string>
): Promise<{ hits: SearchHit[]; status: SearchResults["semanticStatus"] }> {
  const candidates = await prisma.item.findMany({
    where: { userId, embedding: { not: null } },
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
      embedding: true,
    },
  });

  if (candidates.length === 0) return { hits: [], status: "not-indexed" };

  let queryVector: Float32Array;
  try {
    queryVector = await embed(rawQuery);
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    console.warn("[search] semantic unavailable:", err.message);
    return { hits: [], status: "unavailable" };
  }

  const scored = candidates
    // Anything already found by keyword is a fact, not a suggestion — showing
    // it again under "related" would be noise.
    .filter((c) => !exclude.has(c.id) && c.embedding)
    .map((c) => {
      const { embedding, ...rest } = c;
      return { ...rest, score: cosine(queryVector, fromBlob(embedding!)) };
    })
    .filter((c) => c.score >= SEMANTIC_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_LIMIT);

  return { hits: scored, status: "ok" };
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
