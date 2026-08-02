import { callModel, parseJSON, LLMUnavailableError } from "../openrouter";
import { isKind, UNCLASSIFIED, type Classification } from "./kinds";
import { matchUrl } from "./rules";
import { SYSTEM_PROMPT, buildUserMessage, type PageEvidence } from "./prompt";

export type { PageEvidence } from "./prompt";
export { KINDS, KIND_DESCRIPTIONS, isKind } from "./kinds";
export type { Kind, Classification, KindSource } from "./kinds";

/**
 * Classifies a saved page.
 *
 * Layers, in order:
 *   1. URL rules  — decisive hosts where extraction fails or misleads
 *   2. The model  — everything else
 *   3. "other"    — whenever the model is unavailable or unusable
 *
 * A user override is applied above all of this by the caller, and is never
 * recomputed. This function never throws: classification is an enhancement, and
 * a failure here must not break a capture.
 */
export async function classifyPage(page: PageEvidence): Promise<Classification> {
  const rule = matchUrl(page.url);
  if (rule) {
    return {
      kind: rule.kind,
      confidence: 1,
      source: "url",
      reason: rule.reason,
    };
  }

  try {
    const result = await callModel(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(page) },
      ],
      { json: true, maxTokens: 120, timeoutMs: 30_000 }
    );

    const parsed = parseJSON<{
      kind?: unknown;
      confidence?: unknown;
      reason?: unknown;
    }>(result.content);

    // Validate against the enum rather than trusting the model. Anything
    // unrecognised is treated as unclassified, not coerced into a guess.
    if (!isKind(parsed.kind)) {
      console.warn(
        `[classify] model returned unknown kind ${JSON.stringify(parsed.kind)} for ${page.url}`
      );
      return { ...UNCLASSIFIED, reason: "model returned an unknown kind" };
    }

    const raw = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
    // Cap below 1: only a deterministic rule earns full certainty.
    const confidence = Math.min(0.99, Math.max(0, raw));

    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 120)
        : "classified by model";

    return { kind: parsed.kind, confidence, source: "llm", reason };
  } catch (err) {
    const why =
      err instanceof LLMUnavailableError
        ? err.message
        : err instanceof Error
          ? `unparseable response: ${err.message}`
          : "unknown error";
    console.warn(`[classify] falling back to "other" for ${page.url}: ${why}`);
    return { ...UNCLASSIFIED, reason: "classification unavailable" };
  }
}
