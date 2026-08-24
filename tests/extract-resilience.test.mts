/**
 * Extraction resilience — offline. Real pages carry huge, modern stylesheets,
 * and jsdom's CSS engine has thrown on some of them (a Wired page crashed deep
 * in cssstyle on `border: var(--border-width, 1px)`). These pin the two
 * guarantees that keep such a page from failing needlessly: <style> blocks are
 * removed before jsdom sees them, and that removal never changes the article.
 */
import { extractFromHtml, slashVariant } from "../src/lib/extract.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const body = `<h1>The Title</h1>${Array.from(
  { length: 6 },
  (_, i) => `<p>Paragraph ${i} with enough genuine words that Readability keeps it as real body content and not boilerplate.</p>`
).join("")}`;

// The exact CSS shape reported in the crash, embedded as a page would carry it.
const css = `<style>:root{--border-width:1px}.card{border:var(--border-width, 1px);font:var(--f,12px/1.5 serif);grid-template:var(--g,"a" 1fr)}</style>`;

const withCss = extractFromHtml(`<html><head>${css}</head><body><article>${body}</article></body></html>`, "https://example.com/a");
const without = extractFromHtml(`<html><head></head><body><article>${body}</article></body></html>`, "https://example.com/a");

check("extracts a page carrying modern CSS without throwing", withCss.wordCount > 30, `${withCss.wordCount}`);
check("stripping CSS leaves the article identical", withCss.contentHtml === without.contentHtml);
check("title survives", /The Title/.test(withCss.title), withCss.title);

// A <style> written as text in a code sample must NOT be stripped from content.
const codeSample = extractFromHtml(
  `<article><h1>On CSS</h1><p>You write a rule like this in your document head to theme the whole page at once, which is the modern approach most sites now take.</p><pre><code>&lt;style&gt;.x{color:red}&lt;/style&gt;</code></pre><p>And that is how a stylesheet is declared inline within a single HTML document.</p></article>`,
  "https://example.com/b"
);
check("escaped <style> in a code block is preserved", /style/i.test(codeSample.contentHtml));

// Multiple <style> blocks, including one with an unusual close, all go.
const multi = extractFromHtml(
  `<style>a{}</style><article>${body}</article><style media="print">b{}</style>`,
  "https://example.com/c"
);
check("multiple style blocks are all removed", multi.wordCount > 30 && !/<style/i.test(multi.contentHtml));


// ── Trailing-slash recovery ───────────────────────────────────────
// Directory-style static hosts serve the article at exactly one of /post and
// /post/ and answer the other with a 404 rather than a redirect, so a link that
// works in a browser can fail here purely because of which form we were handed.
// safeFetch gives a 404 one second look with the slash flipped; this pins the
// flip itself, which is the part that can silently go wrong.
{
  const flip = (u: string) => slashVariant(u);

  check("adds a missing slash", flip("https://a.com/post") === "https://a.com/post/");
  check("removes a present slash", flip("https://a.com/post/") === "https://a.com/post");
  check("handles nested paths", flip("https://a.com/a/b/c") === "https://a.com/a/b/c/");

  // The root is the one place the slash is not optional, so there is no
  // variant to try and no point spending a second request on it.
  check("root has no variant", flip("https://a.com/") === null);
  check("bare origin has no variant", flip("https://a.com") === null);

  // The query and fragment belong to the request, not the path.
  check(
    "query is preserved",
    flip("https://a.com/post?x=1") === "https://a.com/post/?x=1",
    String(flip("https://a.com/post?x=1"))
  );

  check("garbage is refused rather than guessed at", flip("not a url") === null);
}


console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
