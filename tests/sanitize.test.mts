import { JSDOM } from "jsdom";
import { sanitizeArticleHtml } from "../src/lib/sanitize.ts";

const dom = new JSDOM("<!doctype html><body>", { url: "https://example.com/post" });

const cases: Array<[string, string, (out: string) => boolean]> = [
  ["script tag", `<p>hi</p><script>alert(1)</script>`, o => !/script|alert/i.test(o)],
  ["onerror attr", `<img src="x.png" onerror="alert(1)">`, o => !/onerror/i.test(o)],
  ["javascript: href", `<a href="javascript:alert(1)">x</a>`, o => !/javascript:/i.test(o)],
  ["JaVaScRiPt case", `<a href="JaVaScRiPt:alert(1)">x</a>`, o => !/javascript:/i.test(o)],
  ["tab-split scheme", `<a href="java\tscript:alert(1)">x</a>`, o => !/javascript:/i.test(o)],
  ["iframe", `<iframe src="https://evil.com"></iframe>`, o => !/iframe/i.test(o)],
  ["style attr", `<p style="position:fixed">x</p>`, o => !/style=/i.test(o)],
  ["svg payload", `<svg><animate onbegin=alert(1)></svg>`, o => !/onbegin|<svg/i.test(o)],
  ["form", `<form action="https://evil.com"><input name=a></form>`, o => !/<form|<input/i.test(o)],
  ["data: html", `<a href="data:text/html,evil">x</a>`, o => !/data:text\/html/i.test(o)],
  ["srcset", `<img src="a.png" srcset="evil.png 2x">`, o => !/srcset/i.test(o)],
  ["relative img absolute", `<img src="/pics/a.png">`, o => o.includes("https://example.com/pics/a.png")],
  ["relative link absolute", `<a href="/other">x</a>`, o => o.includes("https://example.com/other")],
  ["keeps text", `<p>Hello <b>world</b></p>`, o => o.includes("Hello") && o.includes("world")],
  ["link hardened", `<a href="https://x.com/a">x</a>`, o => /rel="noopener noreferrer nofollow"/.test(o)],
  ["data: image kept", `<img src="data:image/png;base64,iVBORw0KGgo=">`, o => o.includes("data:image/png")],
  ["nested mXSS", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`, o => !/onerror/i.test(o)],
];

let failed = 0;
for (const [name, input, check] of cases) {
  let out = "";
  try { out = sanitizeArticleHtml(dom.window, input, "https://example.com/post"); }
  catch (e) { out = `THREW: ${e}`; }
  const ok = check(out);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got: ${out.slice(0, 200)}`);
}
console.log(failed ? `\n${failed} FAILED` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
