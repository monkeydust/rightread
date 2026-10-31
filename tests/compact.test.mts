/**
 * Compact's digest — offline, no database, no model.
 *
 * What these pin: the model's text cannot inject markup; a citation links to
 * exactly the archived item it numbers and an invented one disappears; every
 * archived article is listed whether or not the essay cites it; and links back
 * into the library survive the sanitizer without being forced into a new tab
 * (which in the installed app means leaving it).
 */

import { JSDOM } from "jsdom";
import { sanitizeArticleHtml } from "../src/lib/sanitize.ts";
import {
  buildDigestMessage,
  linkCitations,
  parseEssay,
  perItemBudget,
  renderDigestHtml,
  digestPlainText,
  DIGEST_MAX_PER_ITEM,
  DIGEST_MIN_PER_ITEM,
  type DigestSource,
} from "../src/lib/compact/digest.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const ORIGIN = "https://www.rightread.net";
const src = (id: string, extra: Partial<DigestSource> = {}): DigestSource => ({
  id,
  title: `Title ${id}`,
  siteName: null,
  url: `https://example.com/${id}`,
  excerpt: `Excerpt ${id}`,
  text: `Body text of ${id}. `.repeat(50),
  wordCount: 400,
  savedAt: new Date("2026-10-01T00:00:00Z"),
  ...extra,
});
const sources = [src("a"), src("b"), src("c")];

// ── Citations ────────────────────────────────────────────────────
const linked = linkCitations("Rates fell [1] and rose [2, 3].", sources, ORIGIN);
check(
  "citation [1] links to the first source",
  linked.includes(`<sup><a href="${ORIGIN}/read/a">1</a></sup>`),
  linked
);
check(
  "grouped citation [2, 3] links both",
  linked.includes(`<a href="${ORIGIN}/read/b">2</a>,<a href="${ORIGIN}/read/c">3</a>`),
  linked
);

const invented = linkCitations("A claim [9] and [0].", sources, ORIGIN);
check("out-of-range citations are dropped", !/\[|\]|read\//.test(invented), invented);

const hostile = linkCitations(`<script>alert(1)</script> "x" & [1]`, sources, ORIGIN);
check(
  "model text is escaped",
  hostile.includes("&lt;script&gt;") && !hostile.includes("<script>") && hostile.includes("&amp;"),
  hostile
);

// ── Essay parsing ────────────────────────────────────────────────
check("parseEssay: garbage is null", parseEssay("nope") === null && parseEssay({}) === null);
const parsed = parseEssay({
  title: " T ",
  overview: "O [1]",
  sections: [{ heading: "H", paragraphs: ["P", 3, ""] }, { heading: "Empty", paragraphs: [] }],
});
check(
  "parseEssay: keeps strings, drops empty sections",
  parsed?.title === "T" && parsed.sections.length === 1 && parsed.sections[0].paragraphs.length === 1,
  JSON.stringify(parsed)
);

// ── Rendering ────────────────────────────────────────────────────
const at = new Date("2026-10-31T12:00:00Z");
const cutoff = new Date("2026-10-24T12:00:00Z");
const html = renderDigestHtml({
  sources,
  essay: { title: "x", overview: "Overview [1].", sections: [{ heading: "Theme", paragraphs: ["Only b [2]."] }] },
  origin: ORIGIN,
  compactedAt: at,
  cutoff,
});
check(
  "every source is listed even if uncited",
  sources.every((s) => html.includes(`href="${ORIGIN}/read/${s.id}">Title ${s.id}</a>`)),
  html
);
check("list is an ordered list so [n] matches its number", /<ol><li>.*Title a.*Title b.*Title c/s.test(html));

const listOnly = renderDigestHtml({
  sources: [src("a"), src("z", { text: null, excerpt: null })],
  essay: null,
  origin: ORIGIN,
  compactedAt: at,
  cutoff,
  note: "Summary failed.",
});
check("fallback carries the note and excerpts", listOnly.includes("Summary failed.") && listOnly.includes("Excerpt a"));
check("textless source is labelled, not dropped", listOnly.includes("no extracted text") && listOnly.includes("Title z"));

// ── Sanitizer: internal links stay in the app ────────────────────
const { window } = new JSDOM("");
const clean = sanitizeArticleHtml(
  window,
  `<p>x<sup><a href="${ORIGIN}/read/a">1</a></sup> <a href="https://elsewhere.com/">out</a></p>`,
  ORIGIN,
  { internalPrefix: `${ORIGIN}/read/` }
);
const doc = new JSDOM(clean).window.document;
const [inner, outer] = Array.from(doc.querySelectorAll("a"));
check("internal link keeps its tab", inner?.getAttribute("target") === null, clean);
check("external link still opens a new tab", outer?.getAttribute("target") === "_blank", clean);

const plain = sanitizeArticleHtml(window, `<a href="${ORIGIN}/read/a">x</a>`, ORIGIN);
check(
  "without the option, behaviour is unchanged",
  new JSDOM(plain).window.document.querySelector("a")?.getAttribute("target") === "_blank",
  plain
);
check("sanitized digest keeps citations", sanitizeArticleHtml(window, html, ORIGIN, { internalPrefix: `${ORIGIN}/read/` }).includes("<sup>"));

// ── Budget and message ───────────────────────────────────────────
check("budget caps a short pile", perItemBudget(3) === DIGEST_MAX_PER_ITEM);
check("budget floors a huge pile", perItemBudget(10_000) === DIGEST_MIN_PER_ITEM);
const msg = buildDigestMessage(sources);
check("message numbers sources from 1", msg.startsWith("[1] Title a") && msg.includes("[3] Title c"));
check("plain text strips tags", !digestPlainText(html).includes("<"));

window.close();
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall compact tests passed");
