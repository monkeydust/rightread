/**
 * Feed discovery — offline. Runs against HTML fixtures, never the network.
 *
 * Only the *finding* is tested here: fetching and parsing already have their
 * own coverage in feed.test.mts, and discovery deliberately reuses both rather
 * than reimplementing either.
 */

import { feedLinks, normalise } from "../src/lib/sources/discover.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const page = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><p>hi</p></body></html>`;

// ── Finding an advertised feed ────────────────────────────────────
check(
  "finds an absolute RSS link",
  feedLinks(
    page('<link rel="alternate" type="application/rss+xml" href="https://ex.com/rss">'),
    "https://ex.com"
  )[0] === "https://ex.com/rss"
);

check(
  "resolves a relative href against the page",
  feedLinks(
    page('<link rel="alternate" type="application/atom+xml" href="/feed.xml">'),
    "https://ex.com/blog/index.html"
  )[0] === "https://ex.com/feed.xml"
);

check(
  "resolves a document-relative href",
  feedLinks(
    page('<link rel="alternate" type="application/rss+xml" href="feed.xml">'),
    "https://ex.com/blog/"
  )[0] === "https://ex.com/blog/feed.xml"
);

check(
  "handles rel with several tokens",
  feedLinks(
    page('<link rel="alternate home" type="application/rss+xml" href="/rss">'),
    "https://ex.com"
  ).length === 1
);

check(
  "is case-insensitive about the type",
  feedLinks(
    page('<link rel="ALTERNATE" type="APPLICATION/RSS+XML" href="/rss">'),
    "https://ex.com"
  ).length === 1
);

// ── Not a feed ────────────────────────────────────────────────────
check(
  "ignores a stylesheet",
  feedLinks(
    page('<link rel="stylesheet" href="/style.css">'),
    "https://ex.com"
  ).length === 0
);

check(
  "ignores an alternate that is not a feed type",
  feedLinks(
    page('<link rel="alternate" hreflang="fr" href="/fr/">'),
    "https://ex.com"
  ).length === 0
);

check(
  "ignores a canonical link",
  feedLinks(page('<link rel="canonical" href="/">'), "https://ex.com").length === 0
);

check(
  "a page advertising nothing yields nothing",
  feedLinks(page("<title>No feed here</title>"), "https://ex.com").length === 0
);

check(
  "empty html does not throw",
  feedLinks("", "https://ex.com").length === 0
);

// ── Ordering and duplicates ───────────────────────────────────────
{
  // A specific rss/atom type should be preferred over generic application/xml,
  // which sitemaps also use.
  const links = feedLinks(
    page(
      '<link rel="alternate" type="application/xml" href="/generic.xml">' +
        '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'
    ),
    "https://ex.com"
  );
  check(
    "prefers an explicit feed type over generic xml",
    links[0] === "https://ex.com/atom.xml",
    JSON.stringify(links)
  );
  check("but still offers the generic one as a fallback", links.length === 2);
}

check(
  "the same feed advertised twice appears once",
  feedLinks(
    page(
      '<link rel="alternate" type="application/rss+xml" href="/feed">' +
        '<link rel="alternate" type="application/atom+xml" href="/feed">'
    ),
    "https://ex.com"
  ).length === 1
);

// ── Normalising what people actually type ─────────────────────────
for (const [input, want] of [
  ["lobste.rs", "https://lobste.rs/"],
  ["  lobste.rs  ", "https://lobste.rs/"],
  ["https://lobste.rs", "https://lobste.rs/"],
  ["http://example.com/feed", "http://example.com/feed"],
  ["news.ycombinator.com/rss", "https://news.ycombinator.com/rss"],
] as Array<[string, string]>) {
  check(`normalise(${JSON.stringify(input)})`, normalise(input) === want, normalise(input));
}

for (const bad of ["", "   "]) {
  let threw = false;
  try {
    normalise(bad);
  } catch {
    threw = true;
  }
  check(`normalise rejects ${JSON.stringify(bad)}`, threw);
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
