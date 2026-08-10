import { prisma } from "@/lib/db";
import { normalizeUrl, hostLabel } from "@/lib/url";
import { extractArticle, extractFromHtml, type Extracted } from "@/lib/extract";
import { classifyPage, type PageEvidence } from "@/lib/classify";
import { publish } from "@/lib/events";
import { embed, embeddableText, toBlob, EMBED_MODEL } from "@/lib/search/embed";

/**
 * New items go to the top of the queue. Positions are sparse floats, so this
 * is one read plus one write regardless of library size.
 */
async function topPosition(userId: string): Promise<number> {
  const first = await prisma.item.findFirst({
    where: { userId },
    orderBy: { position: "asc" },
    select: { position: true },
  });
  return (first?.position ?? 0) - 1;
}

/**
 * Saves a URL for a user and kicks off extraction.
 *
 * Returns as soon as the row exists so the share sheet / extension gets an
 * instant confirmation; the article text fills in a second or two later and the
 * list polls for it. Re-saving an existing URL resurfaces it rather than
 * erroring.
 */
export async function captureUrl(userId: string, rawUrl: string) {
  const url = normalizeUrl(rawUrl);

  const existing = await prisma.item.findUnique({
    where: { userId_url: { userId, url } },
  });

  if (existing) {
    const item = await prisma.item.update({
      where: { id: existing.id },
      data: {
        // Bring it back to the top of the queue and out of the archive.
        position: await topPosition(userId),
        status: "unread",
        savedAt: new Date(),
      },
    });
    // Retry extraction if it failed last time.
    publish(userId, { type: "items-changed", cause: "captured", itemId: item.id });
    if (item.extractStatus !== "ok") void runExtraction(item.id, url);
    return { item, alreadySaved: true };
  }

  const item = await prisma.item.create({
    data: {
      userId,
      url,
      title: hostLabel(url),
      position: await topPosition(userId),
      extractStatus: "pending",
    },
  });

  publish(userId, { type: "items-changed", cause: "captured", itemId: item.id });
  void runExtraction(item.id, url);
  return { item, alreadySaved: false };
}

/**
 * Extraction runs detached from the request. Any failure is recorded on the row
 * as extractStatus "failed" — the item stays in the list with a link out and a
 * retry button, which beats losing the save.
 */
export async function runExtraction(itemId: string, url: string): Promise<void> {
  // Needed to address the SSE channel; the caller only passes an item id.
  const owner = await prisma.item
    .findUnique({ where: { id: itemId }, select: { userId: true } })
    .catch(() => null);
  const notify = (cause: "extracted" | "classified") => {
    if (owner?.userId) publish(owner.userId, { type: "items-changed", cause, itemId });
  };

  try {
    const article = await extractArticle(url);
    await persistArticle(itemId, article, owner?.userId, notify);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rightread] extraction failed for ${url}: ${message}`);

    // Re-extracting an article that already reads fine (to pick up a better
    // tidy pass, say) must never make it worse. If the site is down or has
    // since put the page behind a wall, keep what we already have rather than
    // flipping a working article to "failed".
    const existing = await prisma.item
      .findUnique({ where: { id: itemId }, select: { contentHtml: true } })
      .catch(() => null);

    if (existing?.contentHtml) {
      console.warn(
        `[rightread] keeping the previously extracted copy of ${url}`
      );
      return;
    }

    await prisma.item
      .update({
        where: { id: itemId },
        data: {
          extractStatus: "failed",
          extractError: message.slice(0, 300),
          extractedAt: new Date(),
        },
      })
      .catch(() => {});

    // Still classify. A paywalled or JavaScript-rendered page has no text, but
    // its URL and title are often decisive — and this is exactly the case the
    // URL rules exist for.
    const item = await prisma.item
      .findUnique({ where: { id: itemId }, select: { title: true } })
      .catch(() => null);
    notify("extracted");

    await classifyItem(itemId, {
      url,
      title: item?.title ?? url,
      extracted: false,
    });
    notify("classified");
  }
}

/**
 * Persists an extracted article and runs the rest of the pipeline —
 * classification, embedding, recommendations. Shared by the fetch path
 * (runExtraction) and the paste path (applyProvidedContent) so both produce an
 * identical item: same fields, same classification, same place in Discover.
 */
async function persistArticle(
  itemId: string,
  article: Extracted,
  userId: string | undefined,
  notify: (cause: "extracted" | "classified") => void
): Promise<void> {
  await prisma.item.update({
    where: { id: itemId },
    data: {
      title: article.title,
      siteName: article.siteName,
      byline: article.byline,
      excerpt: article.excerpt,
      leadImage: article.leadImage,
      contentHtml: article.contentHtml,
      textContent: article.textContent,
      wordCount: article.wordCount,
      resolvedUrl: article.resolvedUrl,
      extractStatus: "ok",
      extractError: null,
      extractedAt: new Date(),
    },
  });
  notify("extracted");

  await classifyItem(itemId, {
    url: article.resolvedUrl,
    title: article.title,
    text: article.textContent,
    byline: article.byline,
    siteName: article.siteName,
    wordCount: article.wordCount,
    extracted: true,
  });
  notify("classified");

  await embedItem(itemId, article);

  // Now that the item has a vector, see what the listeners already hold that
  // resembles it. Costs no API call — both sides are already embedded — and is
  // fail-soft inside, so a recommendation that cannot be written never affects
  // the capture that triggered it.
  if (userId) {
    const { recommendForItem } = await import("@/lib/phrases/match");
    await recommendForItem(userId, itemId);
  }
}

/**
 * The browser-sourced path: extract from HTML the user's own browser supplied,
 * rather than from a server fetch.
 *
 * This exists for pages a server cannot reach but a person can — a paywalled
 * article they are logged into, or one behind a bot check they passed in their
 * own session. The server never touches the origin; it runs the same Readability
 * and the same sanitize gate on HTML it is handed. Because the reader renders
 * the result with dangerouslySetInnerHTML, that sanitize step is not optional
 * and is exactly the one the fetch path already relies on.
 *
 * Throws with a human-readable message when the HTML yields no article, so the
 * caller can tell the user their selection did not contain a readable page.
 */
export async function applyProvidedContent(
  itemId: string,
  html: string
): Promise<void> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: { userId: true, url: true, resolvedUrl: true },
  });
  if (!item) throw new Error("Item not found");

  // Base the extraction on the article's own URL, so relative links resolve and
  // classification sees the real source — not the archive or reader wrapper the
  // HTML may have come through.
  const sourceUrl = item.resolvedUrl ?? item.url;
  const article = extractFromHtml(html, sourceUrl);

  // A pasted selection often has no <title> of its own, in which case
  // extraction falls back to the hostname. Keep whatever title the item already
  // had — captured from the original save — rather than replacing a real title
  // with "archive.is".
  if (article.title === new URL(sourceUrl).hostname) {
    const existing = await prisma.item.findUnique({
      where: { id: itemId },
      select: { title: true },
    });
    if (existing?.title && existing.title !== "Untitled") {
      article.title = existing.title;
    }
  }

  const notify = (cause: "extracted" | "classified") =>
    publish(item.userId, { type: "items-changed", cause, itemId });

  await persistArticle(itemId, article, item.userId, notify);
}

/**
 * Embeds an item for semantic search.
 *
 * Fail-soft like classification: a missing key or a flaky upstream leaves
 * `embedding` null, which simply means this item cannot be found semantically
 * yet. Keyword search still covers it, and `npm run search:backfill` fills the
 * gap later.
 */
async function embedItem(
  itemId: string,
  article: { title: string; siteName: string | null; excerpt: string | null; textContent: string }
): Promise<void> {
  try {
    const vector = await embed(embeddableText(article));
    await prisma.item.update({
      where: { id: itemId },
      data: {
        embedding: toBlob(vector),
        embeddingModel: EMBED_MODEL,
        embeddedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(
      `[rightread] embedding failed for item ${itemId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Classifies an item and stores the result with its provenance.
 *
 * Never throws and never overwrites a user's manual override — the whole point
 * of the override is that it sticks.
 */
async function classifyItem(itemId: string, evidence: PageEvidence): Promise<void> {
  try {
    const existing = await prisma.item.findUnique({
      where: { id: itemId },
      select: { kindSource: true },
    });
    if (existing?.kindSource === "user") return;

    const result = await classifyPage(evidence);
    await prisma.item.update({
      where: { id: itemId },
      data: {
        kind: result.kind,
        kindConfidence: result.confidence,
        kindSource: result.source,
        kindReason: result.reason,
      },
    });
  } catch (err) {
    // Classification is an enhancement; a failure must not affect the save.
    console.warn(
      `[rightread] classification failed for item ${itemId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
