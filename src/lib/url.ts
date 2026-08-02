/** Tracking params that change nothing about the content but break dedupe. */
const JUNK_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^mc_(cid|eid)$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^si$/i,
  /^_hs(enc|mi)$/i,
  /^vero_(id|conv)$/i,
  /^spm$/i,
];

/**
 * Normalizes a URL for storage and dedupe: https-only scheme check, tracking
 * params stripped, trailing slash and empty query/hash removed.
 * Throws if the input is not a valid http(s) URL.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty URL");

  // Accept bare "example.com/article" from a paste box, but only when there is
  // no scheme at all — prepending https:// to "ftp://a.com" would otherwise
  // produce a string that parses as https and sails past the protocol check.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error("Not a valid URL");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https URLs can be saved");
  }

  for (const key of [...u.searchParams.keys()]) {
    if (JUNK_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }

  let out = u.toString();
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

/**
 * Pulls the first usable link out of arbitrary text and normalises it.
 *
 * Shared by the share target and the paste box, which face the same problem:
 * what arrives is often not a bare URL. Android apps hand over "Great read
 * https://example.com/x" as one string, and copying from a page picks up
 * surrounding whitespace or a trailing bracket.
 *
 * Returns null rather than throwing — both callers treat "no link here" as an
 * ordinary outcome, not an error.
 */
export function extractFirstUrl(text: string): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  // An explicit scheme wins, and the scan must come first even when the text
  // has no spaces: "(https://a.com/x)" is a single token, so treating it as a
  // bare hostname would prepend a scheme to the bracket and mangle it.
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  if (match) {
    // Trailing punctuation is almost always the sentence, not the URL.
    const candidate = match[0].replace(/[.,;:!?)\]}>'"]+$/, "");
    try {
      return normalizeUrl(candidate);
    } catch {
      return null;
    }
  }

  // No scheme anywhere. Accept a bare hostname only when the whole thing is one
  // token — "example.com/article" is a link, a sentence mentioning a domain is
  // not — after shedding any wrapping punctuation.
  const bare = trimmed.replace(/^[([{<'"]+/, "").replace(/[.,;:!?)\]}>'"]+$/, "");
  if (!bare || /\s/.test(bare)) return null;
  try {
    return normalizeUrl(bare);
  } catch {
    return null;
  }
}

/** "theverge.com" — for the source label in the list. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
