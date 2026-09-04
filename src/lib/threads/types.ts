/**
 * A discussion thread, as a structure rather than a page.
 *
 * Readability is the wrong tool for a comment thread: it looks for the one
 * block of prose on a page and treats everything around it as clutter, which
 * is exactly backwards for a thread — the "clutter" is the substance. On a
 * Hacker News item it kept 43 words of a 24-comment thread; on another it
 * flattened 64,000 words into a wall with no attribution. Neither can be
 * summarised honestly, and neither knows how many comments there are, which
 * is the one number a "has this moved since yesterday?" question needs.
 *
 * An adapter fetches the thread from wherever the site exposes it as data
 * and returns this shape. Comments are in the site's own rank order,
 * depth-first, so `comments[0]` is the top-ranked reply and its subtree
 * follows it — a summariser reading top-down sees the thread the way a reader
 * would.
 */

export type ThreadComment = {
  id: string;
  /** Null when the site has removed the author (deleted account, dead post). */
  author: string | null;
  createdAt: Date;
  /** 0 for a direct reply to the post. */
  depth: number;
  /** Plain text, whitespace-normalised. What the model reads. */
  text: string;
  /** The site's own HTML for the comment. Sanitised before rendering. */
  html: string;
};

export type Thread = {
  /** Canonical URL of the thread itself, not of anything it links to. */
  url: string;
  siteName: string;
  title: string;
  author: string | null;
  createdAt: Date;
  points: number | null;
  /** Where the post points, when it is a link post. */
  linkUrl: string | null;
  /** The post's own text, as HTML, for a text post. */
  bodyHtml: string | null;
  bodyText: string | null;
  comments: ThreadComment[];
  /** When the adapter fetched it — what a later "since" is measured against. */
  fetchedAt: Date;
};

export type ThreadAdapter = {
  /** Short stable tag stored on each summary: "hn", later "reddit" etc. */
  kind: string;
  /** The thread's id when the URL is one this adapter handles, else null. */
  match(url: string): string | null;
  fetch(url: string, id: string): Promise<Thread>;
};
