import { callModel, parseJSON, MODEL, LLMUnavailableError } from "../openrouter";
import { isKind, type Kind } from "../classify/kinds";
import {
  systemPromptFor,
  buildUserMessage,
  type SummaryInput,
  type Summary,
} from "./prompts";

export type { Summary, SummaryInput } from "./prompts";
export { systemPromptFor } from "./prompts";

export type SummaryResult = Summary & {
  model: string;
  costUsd: number | null;
  durationMs: number;
};

export class NotSummarisableError extends Error {}

/** Below this there is nothing worth summarising — and saying so is cheaper. */
const MIN_WORDS = 60;

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

  const result = await callModel(
    [
      { role: "system", content: systemPromptFor(kind) },
      { role: "user", content: buildUserMessage({ ...input, kind }) },
    ],
    // Generous ceiling: truncating a summary mid-sentence is worse than the
    // handful of tokens saved, and the model is told to be brief anyway.
    { json: true, maxTokens: 1200, timeoutMs: 90_000 }
  );

  const parsed = parseJSON<{
    tldr?: unknown;
    points?: unknown;
    verdict?: unknown;
  }>(result.content);

  const tldr = typeof parsed.tldr === "string" ? parsed.tldr.trim() : "";
  if (!tldr) {
    throw new LLMUnavailableError("model returned a summary with no tldr");
  }

  const points = Array.isArray(parsed.points)
    ? parsed.points
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim())
        // A runaway list is a failure mode worth capping rather than rendering.
        .slice(0, 8)
    : [];

  const verdict = typeof parsed.verdict === "string" ? parsed.verdict.trim() : "";

  return {
    tldr,
    points,
    verdict,
    model: MODEL,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}
