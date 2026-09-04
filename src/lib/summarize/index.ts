import { callModel, parseJSON, MODEL, LLMUnavailableError } from "../openrouter";
import { isKind, type Kind } from "../classify/kinds";
import type { Thread } from "../threads";
import {
  systemPromptFor,
  buildUserMessage,
  type SummaryInput,
  type Summary,
  type PreviousSummary,
} from "./prompts";
import { threadText, THREAD_MAX_CHARS } from "./thread";

export type { Summary, SummaryInput, PreviousSummary } from "./prompts";
export { systemPromptFor } from "./prompts";
export { threadText, THREAD_MAX_CHARS } from "./thread";

export type SummaryResult = Summary & {
  model: string;
  costUsd: number | null;
  durationMs: number;
  /** Characters of page text the model was actually shown. */
  textChars: number;
};

export class NotSummarisableError extends Error {}

/** Below this there is nothing worth summarising — and saying so is cheaper. */
const MIN_WORDS = 60;

/** Caps that turn a runaway list into a rendering problem rather than a page. */
const MAX_POINTS = 8;
const MAX_STANDOUT = 3;
const MAX_LINKS = 6;

/**
 * Summarises a page using the prompt for its kind.
 *
 * Unlike classification this is user-initiated, so it throws rather than
 * degrading silently: the reader pressed a button and deserves to be told why
 * nothing happened.
 */
export async function summarizePage(input: SummaryInput): Promise<SummaryResult> {
  const text = input.text?.trim() ?? "";
  const words = text ? text.split(/\s+/).length : 0;

  if (words < MIN_WORDS) {
    throw new NotSummarisableError(
      words === 0
        ? "This page has no extracted text to summarise."
        : `This page only has ${words} words — there is nothing to summarise.`
    );
  }

  const kind: Kind = isKind(input.kind) ? input.kind : "other";
  const userMessage = buildUserMessage({ ...input, kind });

  const result = await callModel(
    [
      { role: "system", content: systemPromptFor(kind, input.previous) },
      { role: "user", content: userMessage },
    ],
    // Generous ceiling: truncating a summary mid-sentence is worse than the
    // handful of tokens saved, and the model is told to be brief anyway.
    { json: true, maxTokens: 1600, timeoutMs: 90_000 }
  );

  const parsed = parseJSON<{
    tldr?: unknown;
    points?: unknown;
    standout?: unknown;
    links?: unknown;
    verdict?: unknown;
    sinceLast?: unknown;
  }>(result.content);

  const tldr = typeof parsed.tldr === "string" ? parsed.tldr.trim() : "";
  if (!tldr) {
    throw new LLMUnavailableError("model returned a summary with no tldr");
  }

  const sinceLast =
    input.previous && typeof parsed.sinceLast === "string" && parsed.sinceLast.trim()
      ? parsed.sinceLast.trim()
      : null;

  return {
    tldr,
    points: stringList(parsed.points, MAX_POINTS),
    standout: kind === "conversation" ? stringList(parsed.standout, MAX_STANDOUT) : [],
    links: kind === "conversation" ? stringList(parsed.links, MAX_LINKS) : [],
    verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "",
    sinceLast,
    model: MODEL,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    textChars: Math.min(text.length, input.maxChars ?? 40_000),
  };
}

/**
 * Summarises a thread fetched as structure. The comment selection is made
 * here, with knowledge of what is new, rather than by clipping a wall of text.
 */
export async function summarizeThread(
  thread: Thread,
  previous?: PreviousSummary | null
): Promise<SummaryResult & { commentCount: number; newComments: number }> {
  const { text, commentCount, newComments } = threadText(
    thread,
    previous?.fetchedAt ?? null
  );

  if (commentCount === 0 && !thread.bodyText) {
    throw new NotSummarisableError("This thread has no comments yet — nothing to summarise.");
  }

  const result = await summarizePage({
    kind: "conversation",
    title: thread.title,
    url: thread.url,
    siteName: thread.siteName,
    byline: thread.author,
    text,
    previous,
    maxChars: THREAD_MAX_CHARS,
  });

  return { ...result, textChars: text.length, commentCount, newComments };
}

/** Model output is untrusted: keep only non-empty strings, and not too many. */
function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, cap);
}
