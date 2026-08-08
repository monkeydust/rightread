/**
 * Key phrases: standing semantic queries against whatever the listeners bring in.
 *
 * Everything else in rightread is reactive — it needs an article in hand before
 * it can tell you anything. A key phrase is the opposite: declare an interest
 * once, and every article a source publishes from then on is scored against it.
 *
 * ── The floor, measured ──────────────────────────────────────────
 * A phrase is short, so phrase → article is the *query-to-document*
 * distribution, not the document-to-document one `sources/similar.ts` measured
 * 0.45 for. Reusing 0.45 would return nothing at all. Reusing search's 0.22
 * would return noise, because a recommendation has to favour precision for the
 * reason similar.ts already documents: a wrong recommendation reads as a broken
 * feature, an empty panel reads as honesty.
 *
 * Measured on text-embedding-3-small against a real 202-article Hacker News
 * pool, with four on-topic phrases and four deliberate controls:
 *
 *   retro computing and vintage OSes    0.534  -> homebrew Am29000 windowed OS
 *   running LLMs on your own hardware   0.506  -> running Kimi and GLM at scale
 *   post-quantum cryptography           0.388  -> LLMs won't break symmetric crypto
 *   SQLite internals and storage        0.349  -> rebuilding Postgres for analytics
 *   ---- controls ----
 *   slow-cooked Italian pasta recipes   0.338  -> "Rice Deserves Better Than a
 *                                                  Kochbeutel" — a REAL food
 *                                                  article; not a false positive
 *   beekeeping for beginners            0.256  -> a botany reading list
 *   baroque church organ restoration    0.251  -> "Altar II" (matched on altar)
 *   premier league transfer rumours     0.223  -> nothing real
 *
 * The controls are the interesting part: three of the four found weak but
 * genuine associations rather than nonsense, and the highest-scoring "control"
 * hit was correct — the pool really did contain a food article. So the
 * separation is not noise-vs-signal, it is strong-signal-vs-weak-signal.
 *
 * 0.32 admits every on-topic phrase, keeps the correct food match, and returns
 * nothing for beekeeping, organs and football. Re-measure on any model change.
 */

import { prisma } from "@/lib/db";
import { embed, fromBlob, cosine, toBlob, EMBED_MODEL } from "@/lib/search/embed";
import { readUnitFloat } from "@/lib/env";
import { ITEM_MATCH_FLOOR } from "@/lib/sources/similar";

const DEFAULT_PHRASE_FLOOR = 0.32;
const FLOOR = readUnitFloat("RIGHTREAD_PHRASE_FLOOR", DEFAULT_PHRASE_FLOOR, "phrases");

/**
 * Most a single origin may contribute per sweep. A phrase that matches a whole
 * feed should surface its best handful, not bury everything else in Discover.
 */
const MAX_PER_ORIGIN = 10;

export type Origin = { kind: "phrase" | "item"; id: string };

export type Scorable = { id: string; embedding: Uint8Array | null };
export type Hit = { id: string; score: number };

/**
 * The selection rule, in one place: score everything, drop what falls below
 * the floor, best first, capped.
 *
 * Pure and exported so the rules can be tested without a database — the two
 * callers differ only in which floor they pass, and having written this twice
 * is how the floors would drift apart.
 */
export function selectHits(
  query: Float32Array,
  candidates: Scorable[],
  floor: number,
  max: number = MAX_PER_ORIGIN
): Hit[] {
  return candidates
    .filter((c) => c.embedding)
    .map((c) => ({ id: c.id, score: cosine(query, fromBlob(c.embedding!)) }))
    .filter((c) => c.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** Records hits for one origin. Upserting keeps a repeated sweep idempotent. */
async function record(
  userId: string,
  origin: Origin,
  hits: Hit[]
): Promise<void> {
  for (const hit of hits) {
    await prisma.recommendation
      .upsert({
        where: {
          userId_candidateId_originKind_originId: {
            userId,
            candidateId: hit.id,
            originKind: origin.kind,
            originId: origin.id,
          },
        },
        create: {
          userId,
          candidateId: hit.id,
          originKind: origin.kind,
          originId: origin.id,
          score: hit.score,
        },
        // The score can move if either side was re-embedded.
        update: { score: hit.score },
      })
      .catch((err: unknown) => {
        console.warn("[phrases] could not record recommendation:", err);
      });
  }
}

/**
 * Embeds a phrase and stores the vector. Clearing lastMatchedAt is what makes
 * an edited phrase backfill against candidates already held.
 */
export async function embedPhrase(phraseId: string): Promise<boolean> {
  const phrase = await prisma.keyPhrase
    .findUnique({ where: { id: phraseId }, select: { text: true } })
    .catch(() => null);
  if (!phrase) return false;

  try {
    const vector = await embed(phrase.text);
    await prisma.keyPhrase.update({
      where: { id: phraseId },
      data: {
        embedding: toBlob(vector),
        embeddingModel: EMBED_MODEL,
        embeddedAt: new Date(),
        lastMatchedAt: null,
      },
    });
    return true;
  } catch (err) {
    // Fail-soft, like every other embedding call: an unembeddable phrase
    // simply never matches. It must not break the settings page that created it.
    console.warn(
      `[phrases] could not embed ${JSON.stringify(phrase.text)}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Scores one query vector against a user's candidate pool and records the hits.
 *
 * Dismissed and already-saved candidates are excluded in the query rather than
 * filtered afterwards: "not interested" has to hold however the article is
 * found next, which is why dismissedAt lives on Candidate and not here.
 */
export async function recommendFrom(
  userId: string,
  queryVector: Float32Array,
  origin: Origin,
  options: { since?: Date | null } = {}
): Promise<number> {
  const candidates = await prisma.candidate.findMany({
    where: {
      userId,
      embedding: { not: null },
      dismissedAt: null,
      savedItemId: null,
      ...(options.since ? { embeddedAt: { gt: options.since } } : {}),
    },
    select: { id: true, embedding: true },
  });
  if (candidates.length === 0) return 0;

  const hits = selectHits(queryVector, candidates, FLOOR);
  await record(userId, origin, hits);

  return hits.length;
}

/**
 * Runs every active phrase against whatever arrived since it last ran.
 * Called from the source poller. Never throws.
 */
export async function matchAllPhrases(): Promise<void> {
  try {
    const phrases = await prisma.keyPhrase.findMany({
      where: { active: true },
      select: {
        id: true,
        userId: true,
        text: true,
        embedding: true,
        lastMatchedAt: true,
      },
    });

    for (const phrase of phrases) {
      // A phrase whose embedding failed earlier gets another chance here
      // rather than staying dead until someone edits it.
      if (!phrase.embedding) {
        const ok = await embedPhrase(phrase.id);
        if (!ok) continue;
        const refreshed = await prisma.keyPhrase.findUnique({
          where: { id: phrase.id },
          select: { embedding: true },
        });
        if (!refreshed?.embedding) continue;
        phrase.embedding = refreshed.embedding;
        phrase.lastMatchedAt = null;
      }

      const found = await recommendFrom(
        phrase.userId,
        fromBlob(phrase.embedding),
        { kind: "phrase", id: phrase.id },
        { since: phrase.lastMatchedAt }
      );

      await prisma.keyPhrase
        .update({ where: { id: phrase.id }, data: { lastMatchedAt: new Date() } })
        .catch(() => {});

      if (found > 0) {
        console.log(`[phrases] ${found} new for ${JSON.stringify(phrase.text)}`);
      }
    }
  } catch (err) {
    console.warn(
      "[phrases] sweep failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Matches one freshly-saved article against the candidate pool.
 *
 * Called from capture after the item is embedded, so it costs no API call —
 * the vector already exists. Uses the document-to-document floor from
 * sources/similar.ts, which is the right one here because both sides are full
 * articles; only the phrase path uses the lower query-to-document floor.
 */
export async function recommendForItem(userId: string, itemId: string): Promise<void> {
  try {
    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { embedding: true },
    });
    if (!item?.embedding) return;

    const vector = fromBlob(item.embedding);

    const candidates = await prisma.candidate.findMany({
      where: { userId, embedding: { not: null }, dismissedAt: null, savedItemId: null },
      select: { id: true, embedding: true },
    });

    const hits = selectHits(vector, candidates, ITEM_MATCH_FLOOR);
    await record(userId, { kind: "item", id: itemId }, hits);
  } catch (err) {
    // Capture must never fail because a recommendation could not be recorded.
    console.warn(
      `[phrases] item match failed for ${itemId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export { FLOOR as PHRASE_FLOOR, MAX_PER_ORIGIN };
