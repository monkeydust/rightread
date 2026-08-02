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

/** "theverge.com" — for the source label in the list. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
