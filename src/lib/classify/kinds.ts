/**
 * Page kinds — the single source of truth.
 *
 * The test for adding a kind is "would this change the summary prompt?", not
 * "is this a distinct genre?". Every entry below gets its own summariser; if
 * two would share one, they should be one kind.
 */

export const KINDS = [
  "conversation",
  "article",
  "blog",
  "reference",
  "other",
] as const;

export type Kind = (typeof KINDS)[number];

/** Where a classification came from. Stored so a wrong answer is diagnosable. */
export type KindSource = "user" | "url" | "llm" | "none";

export type Classification = {
  kind: Kind;
  /** 0–1. Rules are certain; the model's own estimate is capped below 1. */
  confidence: number;
  source: KindSource;
  /** Short justification — the thing that makes a misclassification debuggable. */
  reason: string;
};

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/**
 * One-line discriminators, shown to the model. Written to separate the kinds
 * that are genuinely hard to tell apart, not to define them exhaustively —
 * "conversation vs prose" is the boundary that carries real weight.
 */
export const KIND_DESCRIPTIONS: Record<Kind, string> = {
  conversation:
    "A threaded discussion between many people — forum thread, Q&A, comment section, issue tracker. No single author, no thesis. Replies to replies.",
  article:
    "Reported journalism by a named outlet. Describes events or findings the author gathered. Has a lede, quotes sources, dated.",
  blog:
    "A post or essay arguing a position, explaining something, or recounting experience. One author's voice and thesis. Personal site, company engineering blog, newsletter.",
  reference:
    "Material consulted rather than read start to finish — encyclopedia entry, documentation, API reference, spec, wiki. Neutral, structured, no argument.",
  other:
    "Anything that fits none of the above cleanly — academic papers, video pages, code repositories, product or landing pages, aggregator front pages, paywalled stubs.",
};

/** Fallback used whenever nothing else can be established. */
export const UNCLASSIFIED: Classification = {
  kind: "other",
  confidence: 0,
  source: "none",
  reason: "not classified",
};
