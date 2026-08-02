import type { Kind } from "../classify/kinds";

/**
 * Per-kind summary prompts.
 *
 * A read-later summary has two jobs, and they pull in the same direction:
 *   1. Triage  — is this worth my time right now?
 *   2. Recall  — what was this, six months later?
 *
 * Both are served by the same shape, so the output schema is shared and only
 * the guidance differs. What changes per kind is what "the key points" even
 * means: a discussion has no thesis to state, and a reference page has no
 * argument to summarise.
 *
 * Reference points, none adopted verbatim:
 *  - Fabric's `summarize` — the community default, but its hard word caps
 *    ("10 points of 16 words each") produce stilted, telegraphic output.
 *  - Fabric's `extract_wisdom` — eight sections, tuned for podcast
 *    transcripts; on a saved blog post the summary outruns the article.
 *  - Chain of Density (Adams et al. 2023) — the useful finding is that
 *    readers prefer summaries dense in named entities up to ~0.15
 *    entities/token, past which readability suffers. That insight is applied
 *    directly ("name the specific things"); the five-pass loop is not worth
 *    five times the tokens here.
 */

const SHARED = `You summarise a saved web page for someone deciding whether to read it now, and for their own recall months later.

Rules that apply to every summary:
- Be specific. Name the actual things — people, products, numbers, versions, places. "A new approach to caching" is useless; "a write-through cache in Redis cutting p99 from 800ms to 40ms" is the summary. Specific detail is what makes a summary worth more than the title.
- Never pad. If the page is thin, say less. Do not invent structure the page does not have.
- Only state what the page says. If something is unclear or the text is truncated, leave it out rather than guessing. Do not add your own opinions, caveats or recommendations.
- Write plain sentences. No markdown, no bullets inside a field, no headings — the app renders the structure.
- Assume the reader has seen the title. Do not restate it.

Respond with a single JSON object and nothing else:
{"tldr": "<1-2 sentences>", "points": ["<3-6 items>"], "verdict": "<one sentence: who should read this, or why to skip it>"}`;

/** What "the key points" means for each kind. */
const PER_KIND: Record<Kind, string> = {
  conversation: `This page is a DISCUSSION between many people. There is no single author and usually no thesis, so do not write as if there were — never say "the author argues".

- tldr: what was being discussed, and where the discussion landed overall.
- points: the substance of the disagreement and agreement. What did most people accept? What split the room, and what were the competing positions? Include any specific claim, number, benchmark or war story worth remembering — those are usually the value in a thread. Attribute contested claims ("several commenters reported…", "one maintainer replied…") rather than stating them as fact.
- verdict: whether the thread is worth reading in full, or whether these points are the whole of it. Threads are often 90% noise — say so when true.`,

  article: `This page is REPORTED JOURNALISM.

- tldr: what happened. Lead with the event or finding, not with framing.
- points: the facts that carry the story — who, what, when, how much, according to whom. Keep attribution where the article attributes. Note explicitly if a central claim rests on a single unnamed source.
- verdict: whether this is worth reading in full or whether the facts above are the story.`,

  blog: `This page is an ARGUED or EXPLANATORY POST by one author.

- tldr: the author's central claim, in their terms. Not the topic — the claim.
- points: the argument's actual moves — the reasoning, the evidence offered, the concrete examples, and any caveat the author themselves raises. If the post is a how-to rather than an argument, the points are the approach and the decisions that matter.
- verdict: who this is for, and whether the argument is the point or the examples are.`,

  reference: `This page is REFERENCE MATERIAL — consulted, not read start to finish.

- tldr: what this documents and its scope.
- points: what it actually covers — the key concepts, parameters, behaviours or sections a reader would come here for. Include the gotchas and non-obvious constraints, which are usually why someone saved it.
- verdict: what question this page answers, so future-you knows when to come back to it.`,

  other: `The kind of this page could not be established, so do not assume a shape. Work from what the text actually is.

- tldr: what this page is and what it contains.
- points: whatever is genuinely useful in it.
- verdict: whether it is worth returning to, and what for.

If the text is too thin or broken to summarise honestly, say exactly that in tldr, leave points empty, and say so in verdict. An honest "there is not enough here" is far more useful than an invented summary.`,
};

/** Enough text for a good summary without paying for a whole book. */
const MAX_CHARS = 40_000;

export type SummaryInput = {
  kind: Kind;
  title: string;
  url: string;
  text: string;
  byline?: string | null;
  siteName?: string | null;
};

export function systemPromptFor(kind: Kind): string {
  return `${SHARED}\n\n---\n\n${PER_KIND[kind]}`;
}

export function buildUserMessage(input: SummaryInput): string {
  const head = [`Title: ${input.title}`, `URL: ${input.url}`];
  if (input.siteName) head.push(`Site: ${input.siteName}`);
  if (input.byline) head.push(`Byline: ${input.byline}`);

  const text = input.text.trim();
  const clipped = text.length > MAX_CHARS;

  return [
    ...head,
    "",
    clipped
      ? `Page text (truncated to the first ${MAX_CHARS.toLocaleString()} characters — summarise only what is here, and do not speculate about the rest):`
      : "Page text:",
    "---",
    text.slice(0, MAX_CHARS),
  ].join("\n");
}

export type Summary = {
  tldr: string;
  points: string[];
  verdict: string;
};
