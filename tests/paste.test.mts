/**
 * Browser-sourced extraction — offline. The paste path shares extractFromHtml
 * with the fetch path, so this pins the behaviours specific to a paste: a full
 * page, a bare selection fragment, and the plain-text fallback shape.
 */
import { extractFromHtml } from "../src/lib/extract.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// A selection with real structure — the common archive.is case.
const article = extractFromHtml(
  `<div><h1>How caching works</h1>
   <p>A cache stores the result of an expensive computation so the next request
   for the same input can skip the work entirely, which is the whole point.</p>
   <p>The hard part, as the saying goes, is invalidation: knowing when a stored
   result no longer reflects the underlying data it was derived from.</p></div>`,
  "https://example.com/caching"
);
check("extracts a real title from a fragment", /caching works/i.test(article.title), article.title);
check("keeps the body", article.wordCount > 30, `${article.wordCount} words`);
check("produces paragraphs, not one blob", (article.contentHtml.match(/<p>/g) ?? []).length >= 2);

// Script and style must not survive — same gate as the fetch path.
const nasty = extractFromHtml(
  `<article><h1>Safe</h1><p>${"body ".repeat(40)}</p>
   <script>window.evil=1</script><style>body{display:none}</style>
   <img src="x" onerror="alert(1)"></article>`,
  "https://example.com/x"
);
check("strips <script>", !/<script/i.test(nasty.contentHtml), nasty.contentHtml.slice(0, 80));
check("strips inline handlers", !/onerror/i.test(nasty.contentHtml));

// Empty / junk selections throw rather than storing an empty article.
let threw = false;
try {
  extractFromHtml("<div></div>", "https://example.com/y");
} catch {
  threw = true;
}
check("an empty selection is rejected, not stored", threw);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
