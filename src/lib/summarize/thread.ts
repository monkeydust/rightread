import type { Thread, ThreadComment } from "@/lib/threads";

/**
 * A thread can run to hundreds of thousands of characters; the model gets a
 * budget. Higher than the prose ceiling because a thread's value is spread
 * thin across many voices, where an article's is front-loaded.
 */
export const THREAD_MAX_CHARS = 60_000;

/**
 * One comment's share. A 4,000-character comment is almost never worth 5
 * short ones; the clip keeps the opening, which is where a comment makes
 * its point.
 */
const COMMENT_CLIP = 800;

export type ThreadTextResult = {
  text: string;
  /** How many comments made it into the text. */
  included: number;
  commentCount: number;
  /** Comments newer than `since`; 0 when `since` is not given. */
  newComments: number;
};

/**
 * Flattens a thread for the model, within a budget, preferring what is new.
 *
 * Order matters twice here. Comments are emitted in the site's rank order so
 * the model reads the thread as a reader would. But when the budget is tight,
 * which comments *survive* is decided differently: comments newer than
 * `since` are admitted first, up to half the budget, and only then the rest in
 * rank order. Without that, a busy thread refreshed a day later would spend
 * its whole budget on the same top comments as last time and the "since last
 * time" section would have nothing new to read — the exact question the
 * refresh exists to answer would be the one it could not see.
 */
export function threadText(
  thread: Thread,
  since?: Date | null,
  budget = THREAD_MAX_CHARS
): ThreadTextResult {
  const sinceMs = since ? since.getTime() : null;
  const isNew = (c: ThreadComment) => sinceMs != null && c.createdAt.getTime() > sinceMs;

  const line = (c: ThreadComment) => {
    const clipped = c.text.length > COMMENT_CLIP ? c.text.slice(0, COMMENT_CLIP) + "…" : c.text;
    const tags = [c.author ?? "[deleted]", `depth ${c.depth}`, ...(isNew(c) ? ["NEW"] : [])];
    return `[${tags.join(" · ")}] ${clipped}`;
  };

  const head: string[] = [];
  if (thread.linkUrl) head.push(`Post links to: ${thread.linkUrl}`);
  if (thread.bodyText) head.push(`Post: ${thread.bodyText.slice(0, 4_000)}`);
  if (thread.points != null) head.push(`${thread.points} points, ${thread.comments.length} comments`);
  else head.push(`${thread.comments.length} comments`);
  const headText = head.join("\n");

  let remaining = budget - headText.length;
  const keep = new Set<string>();

  // Pass 1: new comments, up to half the budget.
  let newBudget = Math.floor(budget / 2);
  let newComments = 0;
  for (const c of thread.comments) {
    if (!isNew(c)) continue;
    newComments++;
    const cost = line(c).length + 1;
    if (cost <= newBudget && cost <= remaining) {
      keep.add(c.id);
      newBudget -= cost;
      remaining -= cost;
    }
  }

  // Pass 2: everything else, in rank order, until the budget runs out.
  for (const c of thread.comments) {
    if (keep.has(c.id)) continue;
    const cost = line(c).length + 1;
    if (cost > remaining) continue;
    keep.add(c.id);
    remaining -= cost;
  }

  const lines = thread.comments.filter((c) => keep.has(c.id)).map(line);
  const omitted = thread.comments.length - lines.length;

  return {
    text: [
      headText,
      "",
      ...lines,
      ...(omitted > 0 ? [`(${omitted} more comment${omitted === 1 ? "" : "s"} omitted for length)`] : []),
    ].join("\n"),
    included: lines.length,
    commentCount: thread.comments.length,
    newComments,
  };
}
