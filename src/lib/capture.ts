import { prisma } from "@/lib/db";
import { normalizeUrl, hostLabel } from "@/lib/url";
import { extractArticle } from "@/lib/extract";

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

  void runExtraction(item.id, url);
  return { item, alreadySaved: false };
}

/**
 * Extraction runs detached from the request. Any failure is recorded on the row
 * as extractStatus "failed" — the item stays in the list with a link out and a
 * retry button, which beats losing the save.
 */
export async function runExtraction(itemId: string, url: string): Promise<void> {
  try {
    const article = await extractArticle(url);
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
  }
}
