/**
 * The digest Compact writes: prompt in, HTML out. Pure — no database, no
 * network — so the rules that matter are testable offline:
 *
 *  - The model never writes markup or URLs. It writes plain text and cites
 *    articles as [n]; this file escapes the text and turns each [n] into a
 *    link to /read/<id> of the n-th source. A model cannot link anywhere we
 *    did not put in the list, and a citation it invents is dropped.
 *  - Every archived article is listed at the end, cited or not. The essay is a
 *    reading of the pile; the list is the guarantee that nothing vanished into
 *    the archive unmentioned.
 */

export type DigestSource = {
  id: string;
  title: string;
  siteName: string | null;
  url: string;
  excerpt: string | null;
  /** Plain extracted text; null when extraction failed or never finished. */
  text: string | null;
  wordCount: number | null;
  savedAt: Date;
};

export type DigestEssay = {
  title: string;
  overview: string;
  sections: { heading: string; paragraphs: string[] }[];
};

/** Total characters of article text the model is shown, across every source. */
export const DIGEST_TOTAL_CHARS = 200_000;
/** Per-article bounds: enough to know what a piece argues, not the whole of it. */
export const DIGEST_MAX_PER_ITEM = 6_000;
export const DIGEST_MIN_PER_ITEM = 800;

export const DIGEST_SYSTEM_PROMPT = `You write a reading digest for one person.

They saved the articles below to read later and did not get to them. They are
now being archived. Your digest is how the person learns what was in the pile,
and decides which few deserve opening in full.

Write a synthesis, not a list of summaries: group the articles by theme, say
what each group is about, where articles agree or disagree, and what is new or
surprising. Be concrete — claims, numbers, names — and never vague praise.

Cite articles with their number in square brackets, e.g. "[3]" or "[2][7]",
right after the claim they support. Cite EVERY article at least once. Only use
numbers from the list. Do not write URLs, markdown or HTML.

Return JSON only, in this shape:
{
  "title": "a short headline for the digest, under 70 characters",
  "overview": "2-4 sentences: the shape of the whole pile",
  "sections": [
    { "heading": "theme name", "paragraphs": ["prose with [n] citations", "..."] }
  ]
}

Use as many sections as there are real themes (usually 2-6). An article that
fits nowhere goes in a final section headed "Also in the pile".`;

/** Characters of text each source gets, so the total stays within budget. */
export function perItemBudget(count: number): number {
  if (count <= 0) return DIGEST_MAX_PER_ITEM;
  return Math.max(
    DIGEST_MIN_PER_ITEM,
    Math.min(DIGEST_MAX_PER_ITEM, Math.floor(DIGEST_TOTAL_CHARS / count))
  );
}

/** Sources that have something for a model to read. */
export function hasText(s: DigestSource): boolean {
  return Boolean(s.text?.trim() || s.excerpt?.trim());
}

export function buildDigestMessage(sources: DigestSource[]): string {
  const budget = perItemBudget(sources.length);
  return sources
    .map((s, i) => {
      const body = (s.text?.trim() || s.excerpt?.trim() || "").slice(0, budget);
      const site = s.siteName || hostOf(s.url);
      return `[${i + 1}] ${s.title}\nSource: ${site}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** Model output is untrusted: keep what has the right shape, drop the rest. */
export function parseEssay(value: unknown): DigestEssay | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

  const sections = Array.isArray(v.sections)
    ? v.sections
        .map((sec) => {
          const s = (sec ?? {}) as Record<string, unknown>;
          const paragraphs = Array.isArray(s.paragraphs)
            ? s.paragraphs.map(str).filter(Boolean)
            : [];
          return { heading: str(s.heading), paragraphs };
        })
        .filter((s) => s.paragraphs.length > 0)
    : [];

  const overview = str(v.overview);
  if (!overview && sections.length === 0) return null;
  return { title: str(v.title), overview, sections };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escapes a paragraph and links its citations. "[3]" and "[2, 5]" both work;
 * a number outside the list is removed rather than shown dangling.
 */
export function linkCitations(text: string, sources: DigestSource[], origin: string): string {
  return escapeHtml(text)
    .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums: string) => {
      const links = nums
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= sources.length)
        .map((n) => `<a href="${readHref(origin, sources[n - 1].id)}">${n}</a>`);
      return links.length ? `<sup>${links.join(",")}</sup>` : "";
    });
}

/** The full reader HTML for a digest. `essay` null means "list only". */
export function renderDigestHtml(opts: {
  sources: DigestSource[];
  essay: DigestEssay | null;
  origin: string;
  compactedAt: Date;
  cutoff: Date;
  /** Shown above the list when the essay could not be written. */
  note?: string;
}): string {
  const { sources, essay, origin, compactedAt, cutoff, note } = opts;
  const parts: string[] = [];

  parts.push(
    `<p><em>Compacted ${escapeHtml(formatDate(compactedAt))}: ${sources.length} unread ` +
      `${sources.length === 1 ? "article" : "articles"} saved before ` +
      `${escapeHtml(formatDate(cutoff))} moved to your archive. ` +
      `Every one is listed at the end.</em></p>`
  );

  if (note) parts.push(`<p><em>${escapeHtml(note)}</em></p>`);

  if (essay) {
    if (essay.overview) parts.push(`<p>${linkCitations(essay.overview, sources, origin)}</p>`);
    for (const section of essay.sections) {
      if (section.heading) parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
      for (const p of section.paragraphs) {
        parts.push(`<p>${linkCitations(p, sources, origin)}</p>`);
      }
    }
    parts.push("<hr>");
  }

  parts.push(`<h2>The articles</h2>`);
  parts.push(
    "<ol>" +
      sources
        .map((s) => {
          const meta = [s.siteName || hostOf(s.url)];
          if (s.wordCount) meta.push(`${Math.max(1, Math.round(s.wordCount / 200))} min`);
          if (!hasText(s)) meta.push("no extracted text");
          const excerpt = !essay && s.excerpt ? `<br>${escapeHtml(s.excerpt)}` : "";
          return (
            `<li><a href="${readHref(origin, s.id)}">${escapeHtml(s.title)}</a>` +
            ` <small>${escapeHtml(meta.join(" · "))}</small>${excerpt}</li>`
          );
        })
        .join("") +
      "</ol>"
  );

  return parts.join("\n");
}

/** Plain text for search and the word count, mirroring what the reader shows. */
export function digestPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function defaultDigestTitle(count: number, compactedAt: Date): string {
  return `Digest: ${count} ${count === 1 ? "article" : "articles"} you didn't get to (${formatDate(compactedAt)})`;
}

function readHref(origin: string, id: string): string {
  return `${origin}/read/${encodeURIComponent(id)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
