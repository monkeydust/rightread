import { JSDOM } from "jsdom";
import { prisma } from "@/lib/db";
import { publish } from "@/lib/events";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { topPosition } from "@/lib/capture";
import { callModel, parseJSON, SUMMARY_MODEL } from "@/lib/openrouter";
import {
  DIGEST_SYSTEM_PROMPT,
  buildDigestMessage,
  defaultDigestTitle,
  digestPlainText,
  hasText,
  parseEssay,
  renderDigestHtml,
  type DigestSource,
} from "./digest";

/**
 * Compact: clear the backlog without losing it.
 *
 * Unread, unstarred items saved more than COMPACT_AGE_DAYS ago move to the
 * archive, and one new item — a digest — goes to the top of the queue,
 * synthesising what they were about and linking each archived copy.
 *
 * Order of work is the contract. The archive and the digest row (holding the
 * plain list of everything archived) are written together in one transaction
 * before any model is called, so the backlog is cleared and accounted for
 * even if the summariser never answers. The essay is written afterwards, in
 * the background, and only ever replaces that list with something better.
 * Starred items are left alone: a star is the one explicit "this matters".
 */

export const COMPACT_AGE_DAYS = 7;

export class NothingToCompactError extends Error {}

/** Where digest links point. AUTH_URL is pinned to the canonical host in prod. */
export function appOrigin(): string {
  return (process.env.AUTH_URL?.trim() || "https://www.rightread.net").replace(/\/+$/, "");
}

export function compactCutoff(now = new Date()): Date {
  return new Date(now.getTime() - COMPACT_AGE_DAYS * 24 * 60 * 60 * 1000);
}

function eligible(userId: string, cutoff: Date) {
  return { userId, status: "unread", starred: false, savedAt: { lt: cutoff } };
}

export async function previewCompaction(userId: string, now = new Date()) {
  const cutoff = compactCutoff(now);
  const [items, starredKept] = await Promise.all([
    prisma.item.findMany({
      where: eligible(userId, cutoff),
      orderBy: { savedAt: "asc" },
      select: { id: true, title: true, siteName: true, url: true, savedAt: true, digest: true },
    }),
    prisma.item.count({
      where: { userId, status: "unread", starred: true, savedAt: { lt: cutoff } },
    }),
  ]);
  return { cutoff, items, starredKept };
}

/**
 * Archives the backlog and creates the digest. Returns once both are written;
 * the essay follows in the background (see writeDigest).
 */
export async function compact(userId: string, now = new Date()) {
  const cutoff = compactCutoff(now);

  const rows = await prisma.item.findMany({
    where: eligible(userId, cutoff),
    orderBy: { savedAt: "asc" },
    select: {
      id: true,
      title: true,
      siteName: true,
      url: true,
      excerpt: true,
      textContent: true,
      wordCount: true,
      savedAt: true,
      digest: true,
    },
  });
  if (rows.length === 0) throw new NothingToCompactError("Nothing older than a week to compact.");

  // An older digest still unread is archived like anything else, but it is
  // not an article: summarising a summary says nothing new.
  const sources: DigestSource[] = rows
    .filter((r) => !r.digest)
    .map((r) => ({
      id: r.id,
      title: r.title,
      siteName: r.siteName,
      url: r.url,
      excerpt: r.excerpt,
      text: r.textContent,
      wordCount: r.wordCount,
      savedAt: r.savedAt,
    }));

  const origin = appOrigin();
  const listHtml = cleanHtml(
    renderDigestHtml({ sources, essay: null, origin, compactedAt: now, cutoff }),
    origin
  );
  const text = digestPlainText(listHtml);
  const position = await topPosition(userId);

  const [archived, digest] = await prisma.$transaction([
    prisma.item.updateMany({
      // Re-checked status: a second press racing the first archives nothing twice.
      where: { id: { in: rows.map((r) => r.id) }, userId, status: "unread" },
      data: { status: "archived", readAt: now },
    }),
    prisma.item.create({
      data: {
        userId,
        digest: true,
        // Synthetic and unique per run. Nothing is served here; it exists
        // because Item.url is required and unique per user.
        url: `${origin}/digest/${now.toISOString()}`,
        title: defaultDigestTitle(sources.length, now),
        siteName: "rightread",
        excerpt: `${sources.length} unread ${
          sources.length === 1 ? "article" : "articles"
        } from before ${cutoff.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        })}, now in your archive.`,
        contentHtml: listHtml,
        textContent: text,
        wordCount: text.split(/\s+/).length,
        position,
        // "pending" while the essay is being written: the list polls it and
        // the reader says so. The list is already readable underneath.
        extractStatus: sources.some(hasText) ? "pending" : "ok",
        extractedAt: now,
      },
    }),
  ]);

  publish(userId, { type: "items-changed", cause: "updated", itemId: digest.id });

  if (digest.extractStatus === "pending") {
    void writeDigest(userId, digest.id, sources, now, cutoff);
  }

  return { digestId: digest.id, archived: archived.count };
}

/**
 * Writes the essay into an existing digest. Never throws: on any failure the
 * digest keeps its list, gains a note saying why, and stops being pending.
 */
export async function writeDigest(
  userId: string,
  digestId: string,
  sources: DigestSource[],
  compactedAt: Date,
  cutoff: Date
): Promise<void> {
  const origin = appOrigin();
  const readable = sources.filter(hasText);
  let html: string;
  let title: string | undefined;
  let error: string | null = null;

  try {
    // The model sees only the sources with text, numbered as it sees them;
    // the rendered list keeps every source. Citations therefore index into
    // `readable`, and the list numbering must match — so render with
    // readable first, then the textless ones.
    const ordered = [...readable, ...sources.filter((s) => !hasText(s))];
    const result = await callModel(
      [
        { role: "system", content: DIGEST_SYSTEM_PROMPT },
        { role: "user", content: buildDigestMessage(readable) },
      ],
      { json: true, maxTokens: 5000, timeoutMs: 240_000, model: SUMMARY_MODEL }
    );
    const essay = parseEssay(parseJSON(result.content));
    if (!essay) throw new Error("the model returned no usable digest");

    html = renderDigestHtml({ sources: ordered, essay, origin, compactedAt, cutoff });
    if (essay.title) title = essay.title.slice(0, 120);
    console.log(
      `[compact] digest ${digestId}: ${readable.length} sources, ${result.durationMs}ms, $${
        result.costUsd ?? "?"
      }`
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[compact] digest ${digestId} essay failed: ${error}`);
    html = renderDigestHtml({
      sources,
      essay: null,
      origin,
      compactedAt,
      cutoff,
      note: "The summary couldn't be written this time, so this is just the list. Nothing was lost.",
    });
  }

  const clean = cleanHtml(html, origin);
  const text = digestPlainText(clean);
  await prisma.item
    .update({
      where: { id: digestId },
      data: {
        contentHtml: clean,
        textContent: text,
        wordCount: text.split(/\s+/).length,
        ...(title ? { title } : {}),
        extractStatus: "ok",
        extractError: error ? error.slice(0, 300) : null,
        extractedAt: new Date(),
      },
    })
    .catch((e) => console.error(`[compact] could not store digest ${digestId}: ${e}`));

  publish(userId, { type: "items-changed", cause: "extracted", itemId: digestId });
}

/**
 * A restart mid-essay would leave a digest "pending" for ever. It already
 * holds the full list, so at boot just stop calling it pending.
 */
export async function settleInterruptedDigests(): Promise<void> {
  const { count } = await prisma.item.updateMany({
    where: { digest: true, extractStatus: "pending" },
    data: { extractStatus: "ok", extractError: "interrupted by a restart; list only" },
  });
  if (count) console.warn(`[compact] settled ${count} interrupted digest(s)`);
}

/**
 * Everything stored in contentHtml goes through the sanitizer, digests
 * included — the text in it came from a model.
 */
function cleanHtml(html: string, origin: string): string {
  const { window } = new JSDOM("");
  try {
    return sanitizeArticleHtml(window, html, origin, { internalPrefix: `${origin}/read/` });
  } finally {
    window.close();
  }
}
