/**
 * Plain-text assembly for "copy the article to the clipboard".
 *
 * The body is expected to come from the *rendered* reader (`innerText` of
 * `.prose-reader`), deliberately not from `Item.textContent`: extract.ts
 * collapses that one with `\s+ → " "` because it exists for FTS and the word
 * count, so by the time it reaches the database every paragraph break is gone.
 * Pasting it would produce a single unbroken wall of text.
 */

/** Assembles the clipboard payload: the title as a leading heading, then the body. */
export function buildCopyText(title: string, body: string): string {
  const heading = title.trim();
  const text = normalizeBlankLines(body);
  if (!heading) return text;
  if (!text) return heading;
  return `${heading}\n\n${text}`;
}

/**
 * `innerText` emits a newline per block box, so the wrapper divs and empty
 * paragraphs Readability leaves behind stack into runs of four or five blank
 * lines. Collapse any run to one, and drop trailing whitespace per line.
 */
export function normalizeBlankLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // `[^\S\n]` is "whitespace but not a newline" — it also catches the
    // non-breaking spaces that survive extraction as whole otherwise-blank lines.
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
