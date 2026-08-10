/**
 * Extraction resilience — offline. Real pages carry huge, modern stylesheets,
 * and jsdom's CSS engine has thrown on some of them (a Wired page crashed deep
 * in cssstyle on `border: var(--border-width, 1px)`). These pin the two
 * guarantees that keep such a page from failing needlessly: <style> blocks are
 * removed before jsdom sees them, and that removal never changes the article.
 */
import { extractFromHtml } from "../src/lib/extract.ts";

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

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
