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
 * params stripped, empty query and fragment removed.
 * Throws if the input is not a valid http(s) URL.
 *
 * **The trailing slash is deliberately left alone.** It used to be stripped, on
 * the reasonable-sounding grounds that `/a` and `/a/` are the same page — but
 * they are genuinely different resources, and directory-style static hosting
 * (S3, GitHub Pages, anything without DirectorySlash) serves the article at one
 * and a 404 at the other, without redirecting. Stripping it therefore took a
 * URL that worked and stored one that did not, which broke both the fetch and
 * the "Original ↗" link in the reader, silently and permanently.
 *
 * The cost is that saving both forms of a page makes two rows. That is rare and
 * obvious; the alternative was an article that could never be read.
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

/**
 * What the user meant by what they typed into the combined search/save box.
 *
 * Pure and separate from the component so the rule is testable, because this
 * one decision is the whole feature: get it wrong and searching quietly saves
 * a page, or pasting a link searches for it.
 *
 * A value counts as a link only when the WHOLE trimmed value is a single
 * token that parses. That is what keeps "rust async" a search while
 * "danluu.com" is a link — extractFirstUrl already refuses a bare hostname
 * when there is surrounding text, and requiring one token stops a sentence
 * that merely mentions a URL from being treated as one.
 *
 * A bare token additionally needs a plausible TLD. Without that check a
 * single-word search — "rust", "sqlite", "data*" — classifies as a link,
 * because `new URL("https://rust")` is perfectly valid: a single-label host is
 * legal, it just isn't what anyone typing one word into a search box meant.
 * Tests caught this, and it is the dangerous direction of the two: reading a
 * search as a link offers to save a page nobody asked for.
 *
 * An explicit scheme bypasses the TLD rule. "http://localhost:3000" and
 * intranet hostnames are real links, and typing the scheme is a clear enough
 * statement of intent to be taken at face value.
 */
export function classifyInput(value: string): { kind: "empty" } | { kind: "link"; url: string } | { kind: "search"; term: string } {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return { kind: "empty" };

  if (!/\s/.test(trimmed)) {
    const explicitScheme = /^https?:\/\//i.test(trimmed);
    const url = extractFirstUrl(trimmed);
    if (url && (explicitScheme || hasPlausibleTld(url))) {
      return { kind: "link", url };
    }
  }
  return { kind: "search", term: trimmed };
}

/**
 * Does this URL's host look like a public domain rather than a stray word?
 * At least two labels, and a final label that is alphabetic and 2+ characters
 * — which "example.com" and "bbc.co.uk" satisfy and "rust" and "e.g" do not.
 */
function hasPlausibleTld(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return false;
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]);
}
