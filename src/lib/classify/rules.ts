import type { Kind } from "./kinds";

/**
 * URL rules — the safety net beneath the LLM, not an optimisation.
 *
 * These exist because of a measured failure, not a hunch: a server-side fetch
 * of a Reddit thread returns an 8 KB JavaScript shell with no comment text and
 * no useful metadata. There is nothing for a language model to read, so the URL
 * is the only signal that survives. The same holds for other JS-rendered
 * discussion sites and for paywalled pages where extraction fails outright.
 *
 * The table is deliberately short. It covers hosts where extraction is known to
 * fail or mislead — everything else goes to the model, which handles the long
 * tail no hand-maintained list ever will.
 */

type Rule = {
  /** Matched against the lowercased hostname, with any leading "www." removed. */
  host: RegExp;
  /** Optional path constraint — without it, the whole host matches. */
  path?: RegExp;
  kind: Kind;
  reason: string;
};

const RULES: Rule[] = [
  // ── Threaded discussion ──────────────────────────────────────────
  {
    host: /^news\.ycombinator\.com$/,
    path: /^\/item/,
    kind: "conversation",
    reason: "Hacker News thread",
  },
  {
    // Front page and other listings are an aggregator, not a discussion.
    host: /^news\.ycombinator\.com$/,
    kind: "other",
    reason: "Hacker News listing page",
  },
  {
    // Every Reddit variant: old., new., np., i., and the redd.it shortener.
    host: /^(old\.|new\.|np\.|i\.|m\.)?reddit\.com$/,
    path: /\/comments\//,
    kind: "conversation",
    reason: "Reddit thread",
  },
  {
    host: /^(old\.|new\.|np\.|i\.|m\.)?reddit\.com$/,
    kind: "other",
    reason: "Reddit listing page",
  },
  {
    host: /^lobste\.rs$/,
    path: /^\/s\//,
    kind: "conversation",
    reason: "Lobsters thread",
  },
  {
    host: /^lobste\.rs$/,
    kind: "other",
    reason: "Lobsters listing page",
  },
  {
    // Stack Overflow and the whole Stack Exchange network.
    host: /^(.+\.)?(stackoverflow|stackexchange|superuser|serverfault|askubuntu)\.com$/,
    path: /^\/(questions|q)\//,
    kind: "conversation",
    reason: "Stack Exchange question thread",
  },
  {
    host: /^github\.com$/,
    path: /^\/[^/]+\/[^/]+\/(issues|pull|discussions)\/\d+/,
    kind: "conversation",
    reason: "GitHub issue or pull request thread",
  },

  // ── Reference ────────────────────────────────────────────────────
  {
    host: /(^|\.)wikipedia\.org$/,
    path: /^\/wiki\//,
    kind: "reference",
    reason: "Wikipedia article",
  },
  {
    host: /(^|\.)(wiktionary|wikisource|wikivoyage|fandom)\.(org|com)$/,
    kind: "reference",
    reason: "wiki",
  },

  // ── Not prose — the model cannot usefully summarise these either ──
  {
    host: /^(www\.)?(youtube\.com|youtu\.be)$/,
    kind: "other",
    reason: "video page",
  },
  {
    host: /^arxiv\.org$/,
    path: /^\/(abs|pdf)\//,
    kind: "other",
    reason: "academic preprint",
  },
];

export type RuleMatch = { kind: Kind; reason: string };

/**
 * Returns a match only when the URL is decisive. Order matters: specific paths
 * are listed before their host-wide fallbacks.
 */
export function matchUrl(rawUrl: string): RuleMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;

  for (const rule of RULES) {
    if (!rule.host.test(host)) continue;
    if (rule.path && !rule.path.test(path)) continue;
    return { kind: rule.kind, reason: rule.reason };
  }

  return null;
}
