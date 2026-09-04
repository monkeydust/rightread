/**
 * OpenRouter client — the single LLM entry point for rightread.
 *
 * One code path, one default model. The single exception is summaries, which
 * may name their own model (SUMMARY_MODEL): classification is a cheap
 * five-way label where a budget model measured 44/44, while a summary is
 * judgment — which three comments stand out, whether a consensus shifted —
 * and that is where a stronger model earns its price. Both fall back to the
 * same default, so an unset variable changes nothing.
 *
 * Every call here is fail-soft: LLM work is an enhancement, never a
 * prerequisite. A classification that can't run must not break a capture, the
 * same contract extraction already honours.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Cheap, fast, 1M context. Override per-deploy without touching code. */
// `|| default`, not `?? default`: Docker Compose turns a declared-but-unset
// variable into the empty string, which `??` happily accepts and then sends
// to the API as a blank model name.
export const MODEL = process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-5.6-luna";

/** The model summaries use. Defaults to MODEL, so it is opt-in per deploy. */
export const SUMMARY_MODEL = process.env.OPENROUTER_SUMMARY_MODEL?.trim() || MODEL;

export type LLMMessage = { role: "system" | "user"; content: string };

export type LLMResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** OpenRouter reports actual credits spent, so cost is measured, not modelled. */
  costUsd: number | null;
  durationMs: number;
};

export class LLMUnavailableError extends Error {}

/**
 * Parses JSON from a model response.
 *
 * Ported from rightmind/src/lib/llm.ts rather than rewritten — it already
 * handles the two failure modes that actually occur in production: models
 * wrapping JSON in markdown fences despite json mode, and truncation when the
 * completion hits max_tokens mid-object.
 */
export function parseJSON<T = unknown>(raw: string): T {
  let cleaned = raw.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch (firstError) {
    let repaired = cleaned;

    // Missing colon between key and value: "key""value" -> "key": "value"
    repaired = repaired.replace(/(?<=\w)"(\s*)"(?![:,}\]])/g, '": "');
    try {
      return JSON.parse(repaired) as T;
    } catch {
      // fall through to truncation recovery
    }

    // Truncation recovery: close an unterminated string, then any open braces.
    const quotes = (repaired.match(/"/g) || []).length;
    if (quotes % 2 !== 0) repaired = repaired.replace(/[^"]*$/, '"');

    const opens: string[] = [];
    let inStr = false;
    let escape = false;
    for (const ch of repaired) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") opens.push("}");
      else if (ch === "[") opens.push("]");
      else if (ch === "}" || ch === "]") opens.pop();
    }
    repaired = repaired.replace(/,\s*$/, "");
    repaired += opens.reverse().join("");

    try {
      console.warn(`[openrouter] recovered malformed JSON (${raw.length} chars)`);
      return JSON.parse(repaired) as T;
    } catch {
      throw firstError;
    }
  }
}

/**
 * Faults worth retrying once: a transient upstream hiccup, not a bad request.
 *
 * The empty-completion case is not hypothetical — it was observed in the
 * held-out evaluation, where one page came back with a valid HTTP 200 and no
 * content at all. Retrying rescued it; treating it as terminal silently lost a
 * classification that would otherwise have been correct.
 */
function isTransient(err: unknown): boolean {
  if (!(err instanceof LLMUnavailableError)) return false;
  const m = err.message;
  if (m === "empty completion") return true;
  if (/HTTP (408|409|429|5\d\d)/.test(m)) return true;
  return /timed out|timeout|abort|network|fetch failed|ECONN|socket/i.test(m);
}

/**
 * One chat completion, retried once on a transient fault. Throws
 * LLMUnavailableError when the call cannot be made or the response is unusable
 * — callers are expected to degrade, not crash.
 */
export type CallOptions = {
  json?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /** Defaults to MODEL. Only summaries pass anything else. */
  model?: string;
};

export async function callModel(
  messages: LLMMessage[],
  options: CallOptions = {}
): Promise<LLMResult> {
  try {
    return await callModelOnce(messages, options);
  } catch (err) {
    if (!isTransient(err)) throw err;
    console.warn(
      `[openrouter] transient failure, retrying once: ${(err as Error).message}`
    );
    await new Promise((r) => setTimeout(r, 750));
    return callModelOnce(messages, options);
  }
}

async function callModelOnce(
  messages: LLMMessage[],
  options: CallOptions = {}
): Promise<LLMResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new LLMUnavailableError("OPENROUTER_API_KEY is not set");
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attributes usage to these; helps identify spend later.
        "HTTP-Referer": "https://www.rightread.net",
        "X-Title": "rightread",
      },
      body: JSON.stringify({
        model: options.model ?? MODEL,
        messages,
        max_tokens: options.maxTokens ?? 300,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        // Ask OpenRouter to report what the call actually cost.
        usage: { include: true },
      }),
    });
  } catch (err) {
    throw new LLMUnavailableError(
      err instanceof Error ? err.message : "network error"
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LLMUnavailableError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new LLMUnavailableError("empty completion");
  }

  return {
    content,
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
    costUsd: typeof data?.usage?.cost === "number" ? data.usage.cost : null,
    durationMs: Date.now() - started,
  };
}
