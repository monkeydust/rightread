import { JSDOM } from "jsdom";
import { tidyArticleHtml } from "../src/lib/tidy.ts";

const dom = new JSDOM("<!doctype html><body>");
const tidy = (html: string) => tidyArticleHtml(dom.window, html);

const cases: Array<[string, string, (out: string) => boolean]> = [
  [
    "unwraps attribute-less nesting",
    `<div><div><div><p>Hello</p></div></div></div>`,
    (o) => o === "<p>Hello</p>",
  ],
  [
    "keeps wrappers that carry allowlisted attributes",
    `<div><a href="https://x.com/a" target="_blank" rel="noopener">link</a></div>`,
    (o) => o.includes("href=") && o.includes("link"),
  ],
  [
    "drops empty paragraphs",
    `<p>Real</p><p></p><p>   </p><p>&nbsp;</p><p>Also real</p>`,
    (o) => (o.match(/<p>/g) ?? []).length === 2,
  ],
  [
    "keeps a paragraph holding only an image",
    `<p><img src="https://x.com/a.png" alt="a"></p>`,
    (o) => o.includes("<img"),
  ],
  [
    "removes wiki edit links",
    `<h2>Section<span><a href="https://w.org/e">edit</a></span></h2><p>Body</p>`,
    (o) => !/edit/i.test(o) && o.includes("Section") && o.includes("Body"),
  ],
  [
    "removes [edit] variant",
    `<h2>T<a href="https://w.org/e">[edit]</a></h2>`,
    (o) => !/edit/i.test(o),
  ],
  [
    "cascades: emptied wrapper is pruned after its only child goes",
    `<div><span><a href="https://w.org/e">edit</a></span></div><p>Kept</p>`,
    (o) => o === "<p>Kept</p>",
  ],
  [
    "strips leading and trailing br",
    `<br><p>Body</p><br>`,
    (o) => !o.includes("<br"),
  ],
  [
    "keeps br between content",
    `<p>a<br>b</p>`,
    (o) => o.includes("<br"),
  ],
  [
    "keeps tables and empty cells",
    `<table><tr><td>a</td><td></td></tr></table>`,
    (o) => (o.match(/<td/g) ?? []).length === 2,
  ],
  [
    "keeps hr",
    `<p>a</p><hr><p>b</p>`,
    (o) => o.includes("<hr"),
  ],
  [
    "preserves text order through unwrapping",
    `<div><p>One</p><div><p>Two</p></div><p>Three</p></div>`,
    (o) => o.indexOf("One") < o.indexOf("Two") && o.indexOf("Two") < o.indexOf("Three"),
  ],
  [
    "survives deeply nested junk without hanging",
    `<div>`.repeat(40) + `<p>Deep</p>` + `</div>`.repeat(40),
    (o) => o.includes("Deep"),
  ],
  [
    "leaves already-clean content untouched",
    `<p>One</p><h2>Two</h2><p>Three</p>`,
    (o) => o === `<p>One</p><h2>Two</h2><p>Three</p>`,
  ],
];

let failed = 0;
for (const [name, input, check] of cases) {
  let out = "";
  try {
    out = tidy(input);
  } catch (e) {
    out = `THREW: ${e}`;
  }
  const ok = check(out);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got: ${out.slice(0, 180)}`);
}
console.log(failed ? `\n${failed} FAILED` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
