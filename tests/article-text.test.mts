import { buildCopyText, normalizeBlankLines } from "../src/lib/article-text.ts";

let failed = 0;

function check(name: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

// ── buildCopyText — title leads, body follows ──
check(
  "title then body",
  buildCopyText("How it works", "First para.\n\nSecond para."),
  "How it works\n\nFirst para.\n\nSecond para.",
);
check("title is trimmed", buildCopyText("  Spaced  ", "Body."), "Spaced\n\nBody.");
check("no body — heading alone", buildCopyText("Untitled", "   \n\n "), "Untitled");
check("no title — body alone", buildCopyText("", "Body."), "Body.");

// ── normalizeBlankLines — innerText leaves runs of blanks behind ──
const NBSP = " ";
const cases: Array<[string, string, string]> = [
  ["collapses a run of blanks", "a\n\n\n\n\nb", "a\n\nb"],
  ["keeps one blank line", "a\n\nb", "a\n\nb"],
  ["keeps a single newline", "a\nb", "a\nb"],
  ["strips trailing spaces", "a   \nb\t\nc", "a\nb\nc"],
  ["blank line of spaces collapses", "a\n   \n   \nb", "a\n\nb"],
  ["nbsp-only line collapses", `a\n${NBSP}\n${NBSP}\nb`, "a\n\nb"],
  ["normalises CRLF", "a\r\n\r\nb", "a\n\nb"],
  ["trims the ends", "\n\n  a\n\n", "a"],
  ["nbsp inside a line survives", `a${NBSP}b`, `a${NBSP}b`],
];
for (const [name, input, want] of cases) {
  check(name, normalizeBlankLines(input), want);
}

// A realistic Readability-shaped body: wrapper divs and empty paragraphs.
check(
  "wrapper noise",
  normalizeBlankLines("\n\nHeading\n\n\n\nPara one.\n\n\n\n\nPara two.\n \n\n"),
  "Heading\n\nPara one.\n\nPara two.",
);

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
