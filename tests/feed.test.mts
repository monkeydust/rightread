/**
 * Feed parser tests — offline, fixture strings only.
 *
 * Real-world feeds are the risky input here: three formats (RSS 2.0, RSS 1.0
 * RDF, Atom), CDATA-wrapped HTML summaries, relative links, entries with no
 * link at all. The parser must reduce all of that to clean entries or throw a
 * message a person can act on — never hand junk to the ingest pipeline.
 */

import { parseFeed } from "../src/lib/sources/feed.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── RSS 2.0 ───────────────────────────────────────────────────────
const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <item>
      <title>First post</title>
      <link>https://example.com/first</link>
      <description><![CDATA[<p>Some <b>bold</b> HTML &amp; text.</p>]]></description>
      <pubDate>Mon, 03 Aug 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Relative link</title>
      <link>/second</link>
      <description>Plain summary</description>
    </item>
    <item>
      <title>No link at all</title>
      <description>Should be skipped</description>
    </item>
  </channel>
</rss>`;

const r = parseFeed(rss, "https://example.com/feed.xml");
check("rss: feed title", r.title === "Example Blog");
check("rss: site url", r.siteUrl === "https://example.com/");
check("rss: linkless entry skipped", r.entries.length === 2, `got ${r.entries.length}`);
check("rss: entry url", r.entries[0].url === "https://example.com/first");
check(
  "rss: HTML stripped from CDATA summary",
  r.entries[0].excerpt === "Some bold HTML & text.",
  JSON.stringify(r.entries[0].excerpt)
);
check(
  "rss: pubDate parsed",
  r.entries[0].publishedAt?.toISOString() === "2026-08-03T10:00:00.000Z"
);
check(
  "rss: relative link resolved against feed url",
  r.entries[1].url === "https://example.com/second",
  r.entries[1].url
);
check("rss: missing date is null, not Invalid Date", r.entries[1].publishedAt === null);

// ── Atom ──────────────────────────────────────────────────────────
const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.org/feed.atom"/>
  <link rel="alternate" href="https://example.org/"/>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.org/post/1"/>
    <summary type="html">&lt;em&gt;emphasised&lt;/em&gt; words</summary>
    <published>2026-07-01T09:30:00Z</published>
  </entry>
  <entry>
    <title>Bare link</title>
    <link href="https://example.org/post/2"/>
    <updated>2026-07-02T00:00:00Z</updated>
  </entry>
</feed>`;

const a = parseFeed(atom, "https://example.org/feed.atom");
check("atom: feed title", a.title === "Atom Example");
check(
  "atom: rel=alternate wins over rel=self",
  a.siteUrl === "https://example.org/",
  String(a.siteUrl)
);
check("atom: entry count", a.entries.length === 2);
check("atom: entry link", a.entries[0].url === "https://example.org/post/1");
check(
  "atom: entity-encoded HTML stripped",
  a.entries[0].excerpt === "emphasised words",
  JSON.stringify(a.entries[0].excerpt)
);
check(
  "atom: published parsed",
  a.entries[0].publishedAt?.toISOString() === "2026-07-01T09:30:00.000Z"
);
check("atom: rel-less link accepted", a.entries[1].url === "https://example.org/post/2");
check(
  "atom: updated used when published missing",
  a.entries[1].publishedAt?.toISOString() === "2026-07-02T00:00:00.000Z"
);

// ── RSS 1.0 (RDF) ─────────────────────────────────────────────────
const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.net/">
    <title>RDF Feed</title>
    <link>https://old.example.net/</link>
  </channel>
  <item rdf:about="https://old.example.net/a">
    <title>RDF item</title>
    <link>https://old.example.net/a</link>
    <dc:date>2026-06-15T12:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

const d = parseFeed(rdf, "https://old.example.net/rss");
check("rdf: feed title", d.title === "RDF Feed");
check("rdf: entry parsed", d.entries.length === 1 && d.entries[0].url === "https://old.example.net/a");
check(
  "rdf: dc:date parsed",
  d.entries[0].publishedAt?.toISOString() === "2026-06-15T12:00:00.000Z"
);

// ── Rejection cases ───────────────────────────────────────────────
check(
  "not xml throws",
  /XML/i.test(throws(() => parseFeed("<html><body>a web page", "https://x.com")) ?? ""),
  "should mention XML"
);
check(
  "xml but not a feed throws with root element named",
  /sitemap/.test(
    throws(() =>
      parseFeed('<?xml version="1.0"?><sitemap></sitemap>', "https://x.com")
    ) ?? ""
  )
);
check(
  "javascript: link dropped",
  parseFeed(
    `<rss version="2.0"><channel><title>t</title><item><title>x</title><link>javascript:alert(1)</link></item></channel></rss>`,
    "https://x.com"
  ).entries.length === 0
);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
