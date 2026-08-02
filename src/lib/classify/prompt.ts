import { KINDS, KIND_DESCRIPTIONS, type Kind } from "./kinds";

/** Enough text to judge the kind without paying for the whole article. */
const MAX_CHARS = 6_000;

export type PageEvidence = {
  url: string;
  title: string;
  /** Extracted article text, if extraction succeeded. */
  text?: string | null;
  /** Readability's byline. Its presence is itself a signal — authored prose. */
  byline?: string | null;
  siteName?: string | null;
  wordCount?: number | null;
  /** False when extraction failed — a paywall or JS app, which is evidence too. */
  extracted: boolean;
};

export const SYSTEM_PROMPT = `You classify saved web pages by what kind of thing they are, so a downstream summariser can choose the right approach.

Answer with exactly one of these kinds:

${KINDS.map((k) => `- ${k}: ${KIND_DESCRIPTIONS[k as Kind]}`).join("\n")}

How to decide:
- The distinction that matters most is whether the page is ONE author's prose (article, blog), MANY people talking (conversation), or material consulted rather than read (reference). Get that right before worrying about finer shades.
- article vs blog: reported journalism from an outlet is article; an argued or explanatory post in one person's or company's voice is blog. If genuinely torn, prefer blog — it is the more common case for a saved link.
- Judge what the page IS, not what it is about. A blog post discussing a Reddit thread is a blog. A news article about Wikipedia is an article.
- Do not infer conversation merely because a page has a comment section. It is a conversation only when the discussion is the substance of the page.
- A LISTING is not the thing it lists. Front pages, index pages, tag pages, archives and search results are "other" — even on a forum or news site. "conversation" means one specific thread; "article" and "blog" mean one specific piece. If the page is mostly links to other pages, it is "other".
- COMMERCIAL pages are "other", not "reference" — pricing, plans, product and marketing pages are structured and factual but they exist to sell, not to document. "reference" means neutral technical or encyclopedic material: documentation, specifications, API references, encyclopedia entries.
- "other" is a correct answer, not a failure. Use it for papers, videos, code repositories, product and landing pages, listings, and pages too broken or empty to judge.
- Judge only from the evidence given. If the text is missing or truncated, say so in your reason and lower your confidence rather than guessing confidently.

Set confidence honestly: 0.9+ when the evidence is unambiguous, 0.5-0.7 when you are choosing between two plausible kinds, below 0.5 when you are largely guessing.

Respond with a single JSON object and nothing else:
{"kind": "<one of the kinds above>", "confidence": <number 0-1>, "reason": "<at most 12 words>"}`;

export function buildUserMessage(page: PageEvidence): string {
  const parts: string[] = [`URL: ${page.url}`, `Title: ${page.title}`];

  if (page.siteName) parts.push(`Site: ${page.siteName}`);
  if (page.byline) parts.push(`Byline: ${page.byline}`);
  if (typeof page.wordCount === "number") parts.push(`Word count: ${page.wordCount}`);

  if (!page.extracted) {
    parts.push(
      "",
      "Article extraction FAILED for this page — no readable text could be pulled from it. That usually means a paywall, a login wall, or a JavaScript-rendered app. Classify from the URL and title alone, and keep confidence low."
    );
  } else {
    const text = (page.text ?? "").trim();
    if (!text) {
      parts.push("", "Extraction returned no body text. Classify from URL and title alone.");
    } else {
      const clipped = text.length > MAX_CHARS;
      parts.push(
        "",
        `Beginning of the extracted text${clipped ? " (truncated)" : ""}:`,
        "---",
        text.slice(0, MAX_CHARS)
      );
    }
  }

  return parts.join("\n");
}
