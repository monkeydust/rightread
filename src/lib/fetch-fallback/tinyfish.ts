/**
 * TinyFish Fetch API client — one page per call.
 *
 * https://docs.tinyfish.ai/fetch-api/reference.md
 *
 *   POST https://api.fetch.tinyfish.ai      X-API-Key: <key>
 *   { urls: [url], format: "html", links: true, page_metadata: true, … }
 *   → 200 { results: [{ url, final_url, title, text, links, … }], errors: [{ url, error }] }
 *
 * A per-URL failure is a 200 with the URL in `errors[]`, not an HTTP error, so
 * both arrays are read. Everything that comes back is a third party's account
 * of a page we could not see ourselves: it is typed defensively here and
 * treated as untrusted HTML by the caller.
 */

const ENDPOINT = "https://api.fetch.tinyfish.ai";

/** What TinyFish may spend on one page before giving up on it. */
const PER_URL_TIMEOUT_MS = 45_000;

/**
 * Our own ceiling on the whole call. The service can accept a request and
 * then never answer; nothing in this app may await a fetch that cannot give
 * up (see "Offline" in AGENTS.md — the same rule, server side).
 */
const CLIENT_TIMEOUT_MS = 60_000;

/** A page of extracted HTML is tens of KB. Far above that is not a page. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Accept a copy TinyFish fetched in the last five minutes. A retry or a
 * re-share straight after a save then costs the origin nothing, while a
 * refresh an hour later still gets the live thread.
 */
const CACHE_TTL_SECONDS = 300;

export type FallbackPage = {
  /** The URL we asked for. */
  url: string;
  /** Where it ended up after redirects, as reported — validate before use. */
  finalUrl: string;
  title: string | null;
  description: string | null;
  author: string | null;
  publishedDate: string | null;
  siteName: string | null;
  leadImage: string | null;
  /** Extracted HTML. Untrusted. */
  html: string;
  /** Every link on the page, absolute. Used only to find the next page. */
  links: string[];
  /** From the page's own `page-number` / `page-total` meta tags, when present. */
  pageNumber: number | null;
  pageTotal: number | null;
};

/**
 * A fallback failure, carrying a short machine-readable code — TinyFish's own
 * per-URL code (`bot_blocked`, `timeout`, …) or one of ours (`http_402`,
 * `client_timeout`, `bad_response`). The code is what gets logged and stored;
 * it never contains the key or any part of the response body.
 */
export class FallbackError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Fallback fetch failed: ${code}`);
    this.name = "FallbackError";
    this.code = code;
  }
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Reads `a.b.c` out of an unknown object without trusting any level of it. */
function dig(root: unknown, ...path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * `page_metadata` is documented only as "og, twitter and article tags, and
 * remaining named meta tags under `other`", so the exact nesting is not
 * pinned down. Try the plausible spellings rather than depend on one.
 */
function metaTag(meta: unknown, group: string, name: string): string | null {
  return (
    str(dig(meta, group, name)) ??
    str(dig(meta, group, `${group}:${name}`)) ??
    str(dig(meta, `${group}:${name}`)) ??
    str(dig(meta, "other", `${group}:${name}`))
  );
}

export async function fetchPage(
  url: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch
): Promise<FallbackPage> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        urls: [url],
        format: "html",
        links: true,
        page_metadata: true,
        ttl: CACHE_TTL_SECONDS,
        per_url_timeout_ms: PER_URL_TIMEOUT_MS,
      }),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new FallbackError(
      name === "TimeoutError" || name === "AbortError" ? "client_timeout" : "network_error"
    );
  }

  // 401 bad key, 402 allowance used, 429 rate limit, 5xx: all whole-request
  // failures. The status is the entire message; the body is never surfaced.
  if (!res.ok) throw new FallbackError(`http_${res.status}`);

  let data: unknown;
  try {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw new FallbackError("response_too_large");
    data = JSON.parse(new TextDecoder("utf-8").decode(buf));
  } catch (err) {
    if (err instanceof FallbackError) throw err;
    const name = err instanceof Error ? err.name : "";
    throw new FallbackError(
      name === "TimeoutError" || name === "AbortError" ? "client_timeout" : "bad_response"
    );
  }

  const errors = dig(data, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    // One URL in, so any entry is ours. Keep the code to a safe alphabet: it
    // ends up in a log line and in `extractError`.
    const code = str(dig(errors[0], "error")) ?? "unknown_error";
    const status = int(dig(errors[0], "status"));
    const safe = code.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) || "unknown_error";
    throw new FallbackError(status ? `${safe}_${status}` : safe);
  }

  const results = dig(data, "results");
  const result = Array.isArray(results) ? results[0] : undefined;
  if (!result || typeof result !== "object") throw new FallbackError("no_result");

  const html = dig(result, "text");
  if (typeof html !== "string" || !html.trim()) throw new FallbackError("empty_content");

  const links = dig(result, "links");
  const meta = dig(result, "page_metadata");

  return {
    url,
    finalUrl: str(dig(result, "final_url")) ?? url,
    title: str(dig(result, "title")),
    description: str(dig(result, "description")),
    author: str(dig(result, "author")),
    publishedDate: str(dig(result, "published_date")),
    siteName: metaTag(meta, "og", "site_name"),
    leadImage: metaTag(meta, "og", "image"),
    html,
    links: Array.isArray(links)
      ? links.filter((l): l is string => typeof l === "string")
      : [],
    pageNumber: int(dig(meta, "other", "page-number")),
    pageTotal: int(dig(meta, "other", "page-total")),
  };
}
