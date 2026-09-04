import { prisma } from "@/lib/db";
import { getItem } from "@/lib/items";
import { publish } from "@/lib/events";
import { persistArticle, runExtraction } from "@/lib/capture";
import { threadAdapterFor, fetchThread, renderThread } from "@/lib/threads";
import { summarizePage, summarizeThread } from "./index";
import { listSummaries, asPrevious, saveSummary, type StoredSummary } from "./store";

export class NotFoundError extends Error {}
export class ThreadFetchError extends Error {}

/**
 * The whole "Summarise" / "Refresh" action, from button to stored row.
 *
 * Refresh means re-fetch. A summary of the copy saved last week says nothing
 * about what happened since, and "what happened since" is the reason anyone
 * refreshes a thread. So the thread is fetched again, the reader's stored copy
 * is replaced with it (through the ordinary pipeline, so it is re-embedded and
 * its shelf cards updated), and only then is the new text summarised — with
 * the previous summary in hand so the model can say what moved.
 *
 * Two sources:
 *  - an adapter site (HN today): structured comments, a real comment count,
 *    and per-comment timestamps so "new" is a fact rather than an impression.
 *  - anything else: ordinary extraction, re-run. No comment structure, so the
 *    model compares summaries rather than comments. If the site cannot be
 *    reached the old copy is kept (runExtraction's own rule) and summarised
 *    again; Reddit, whose server fetch always fails, is summarised from
 *    whatever the paste path stored.
 *
 * Not fail-soft, on purpose: the user pressed a button. Every failure surfaces
 * as a typed error the route turns into a message.
 */
export async function refreshSummary(userId: string, itemId: string): Promise<StoredSummary> {
  const item = await getItem(userId, itemId);
  if (!item) throw new NotFoundError("Not found");

  const history = await listSummaries(userId, itemId);
  const previous = asPrevious(history[0]);
  const notify = (cause: "extracted" | "classified") =>
    publish(userId, { type: "items-changed", cause, itemId });

  const found = threadAdapterFor(item.url);

  if (found) {
    let thread;
    try {
      thread = await fetchThread(item.url);
    } catch (err) {
      throw new ThreadFetchError(
        err instanceof Error ? err.message : "Could not fetch the thread"
      );
    }

    await persistArticle(itemId, renderThread(thread), userId, notify);
    const result = await summarizeThread(thread, previous);

    return saveSummary({
      userId,
      itemId,
      kind: "conversation",
      tldr: result.tldr,
      points: result.points,
      standout: result.standout,
      links: result.links,
      verdict: result.verdict,
      sinceLast: result.sinceLast,
      sourceKind: found.adapter.kind,
      fetchedAt: thread.fetchedAt,
      commentCount: result.commentCount,
      newComments: previous ? result.newComments : null,
      textChars: result.textChars,
      model: result.model,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    });
  }

  // Page path. runExtraction never throws and keeps a working copy when the
  // fetch fails, so whatever is on the row afterwards is the best we have.
  const fetchedAt = new Date();
  await runExtraction(itemId, item.url);
  const fresh = await prisma.item.findFirst({
    where: { id: itemId, userId },
    select: { title: true, url: true, resolvedUrl: true, textContent: true, byline: true, siteName: true, kind: true },
  });
  if (!fresh) throw new NotFoundError("Not found");

  const result = await summarizePage({
    kind: fresh.kind,
    title: fresh.title,
    url: fresh.resolvedUrl ?? fresh.url,
    text: fresh.textContent ?? "",
    byline: fresh.byline,
    siteName: fresh.siteName,
    previous,
  });

  return saveSummary({
    userId,
    itemId,
    kind: fresh.kind,
    tldr: result.tldr,
    points: result.points,
    standout: result.standout,
    links: result.links,
    verdict: result.verdict,
    sinceLast: result.sinceLast,
    sourceKind: "page",
    fetchedAt,
    commentCount: null,
    newComments: null,
    textChars: result.textChars,
    model: result.model,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });
}
