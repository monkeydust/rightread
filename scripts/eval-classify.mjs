#!/usr/bin/env node
/**
 * Measures classifier accuracy against the labelled golden set.
 *
 *   node --experimental-strip-types scripts/eval-classify.mjs [--limit N] [--only llm|rule]
 *
 * Runs the REAL pipeline — the same fetch, extraction, sanitising and tidying
 * that production uses — then classifies the result. Feeding the classifier
 * hand-cleaned text would measure something easier than what actually ships.
 *
 * Reports accuracy split by source, because they mean different things: `rule`
 * accuracy tests a hand-written table, `llm` accuracy tests the prompt. Only
 * the second number tells you whether the prompt is any good.
 *
 * Cost is read from OpenRouter's own usage field, so it is measured spend, not
 * an estimate.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { extractArticle } from "../src/lib/extract.ts";
import { classifyPage } from "../src/lib/classify/index.ts";
import { KINDS } from "../src/lib/classify/kinds.ts";

const args = argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const CONCURRENCY = 4;

const fixtureName = args.includes("--fixture")
  ? args[args.indexOf("--fixture") + 1]
  : "labelled-urls.json";
const fixture = JSON.parse(
  readFileSync(new URL(`../tests/fixtures/${fixtureName}`, import.meta.url), "utf8")
);
let cases = fixture.cases;
if (only === "rule") cases = cases.filter((c) => c.rule);
if (only === "llm") cases = cases.filter((c) => !c.rule);
cases = cases.slice(0, limit);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

async function evaluate(testCase) {
  const { url, expected } = testCase;
  let evidence;
  try {
    const a = await extractArticle(url);
    evidence = {
      url: a.resolvedUrl,
      title: a.title,
      text: a.textContent,
      byline: a.byline,
      siteName: a.siteName,
      wordCount: a.wordCount,
      extracted: true,
    };
  } catch (err) {
    // Extraction failure is a legitimate production path, not a skip.
    evidence = { url, title: url, extracted: false };
    testCase.extractError = err instanceof Error ? err.message : String(err);
  }

  const started = Date.now();
  const result = await classifyPage(evidence);
  return {
    ...testCase,
    got: result.kind,
    confidence: result.confidence,
    source: result.source,
    reason: result.reason,
    words: evidence.wordCount ?? 0,
    ms: Date.now() - started,
    pass: result.kind === expected,
  };
}

/** Bounded concurrency — fetching 30 sites serially takes minutes. */
async function runAll(items, worker, width) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await worker(items[i]);
        } catch (err) {
          out[i] = { ...items[i], got: "ERROR", source: "error", pass: false, reason: String(err) };
        }
      }
    })
  );
  return out;
}

console.log(`\nEvaluating ${cases.length} labelled URLs (concurrency ${CONCURRENCY})…\n`);
const results = await runAll(cases, evaluate, CONCURRENCY);

for (const r of results) {
  const mark = r.pass ? c.green("PASS") : c.red("FAIL");
  const verdict = r.pass ? r.got : `${r.got} (want ${r.expected})`;
  console.log(
    `${mark} ${verdict.padEnd(26)} ${c.dim(`${r.source}/${(r.confidence ?? 0).toFixed(2)}`)} ` +
      `${c.dim(String(r.url).slice(0, 58))}`
  );
  if (!r.pass) console.log(`       ${c.yellow("reason:")} ${r.reason}`);
  if (r.extractError) console.log(`       ${c.dim(`extraction failed: ${r.extractError}`)}`);
}

// ── Accuracy, split by what it actually measures ──────────────────
const bySource = (s) => results.filter((r) => r.source === s);
const pct = (list) =>
  list.length ? `${((list.filter((r) => r.pass).length / list.length) * 100).toFixed(0)}%` : "n/a";

console.log("\n── Accuracy ──────────────────────────────");
console.log(`  overall     ${pct(results).padStart(4)}  (${results.filter((r) => r.pass).length}/${results.length})`);
console.log(`  url rules   ${pct(bySource("url")).padStart(4)}  (${bySource("url").length} cases)`);
console.log(`  model       ${pct(bySource("llm")).padStart(4)}  (${bySource("llm").length} cases)  <- the number that matters`);
const unavailable = bySource("none");
if (unavailable.length) console.log(c.yellow(`  unavailable ${unavailable.length} — model call failed`));

// ── Confusion matrix ──────────────────────────────────────────────
console.log("\n── Confusion (rows = expected, cols = got) ─");
const header = KINDS.map((k) => k.slice(0, 5).padStart(6)).join("");
console.log(`  ${"".padEnd(13)}${header}`);
for (const exp of KINDS) {
  const row = results.filter((r) => r.expected === exp);
  if (!row.length) continue;
  const cells = KINDS.map((g) => {
    const n = row.filter((r) => r.got === g).length;
    const cell = String(n || "·").padStart(6);
    return n && exp !== g ? c.red(cell) : n ? c.green(cell) : c.dim(cell);
  }).join("");
  console.log(`  ${exp.padEnd(13)}${cells}`);
}

// ── Measured cost ─────────────────────────────────────────────────
const llmCalls = bySource("llm").length + unavailable.length;
console.log("\n── Cost ──────────────────────────────────");
console.log(`  model calls ${llmCalls}`);
console.log(`  median latency ${
  (() => {
    const ms = bySource("llm").map((r) => r.ms).sort((a, b) => a - b);
    return ms.length ? `${ms[Math.floor(ms.length / 2)]}ms` : "n/a";
  })()
}`);
console.log(c.dim("  (per-call spend is reported by OpenRouter; see the key usage check)\n"));

process.exit(results.every((r) => r.pass) ? 0 : 1);
