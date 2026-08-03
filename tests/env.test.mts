/**
 * Environment-variable parsing.
 *
 * These exist because of a specific production failure mode: Docker Compose
 * turns a variable listed under `environment:` but missing from the env file
 * into the EMPTY STRING, not into unset. `??` does not catch that, and
 * `Number("")` is 0 rather than NaN — so a missing similarity floor would
 * silently become a floor of zero and return the entire library as "related",
 * with nothing in any log to explain it.
 */

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

async function withEnv(vars: Record<string, string | undefined>, mod: string) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Cache-busted so module-level constants are re-evaluated per case.
    return await import(`${mod}?case=${encodeURIComponent(JSON.stringify(vars))}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const EMBED = "../src/lib/search/embed.ts";
const OR = "../src/lib/openrouter.ts";

for (const [label, value] of [
  ["unset", undefined],
  ["empty string (the compose case)", ""],
  ["whitespace only", "   "],
] as Array<[string, string | undefined]>) {
  const e = await withEnv({ OPENROUTER_EMBED_MODEL: value }, EMBED);
  check(`embed model falls back when ${label}`, e.EMBED_MODEL === "openai/text-embedding-3-small", `got ${JSON.stringify(e.EMBED_MODEL)}`);

  const o = await withEnv({ OPENROUTER_MODEL: value }, OR);
  check(`chat model falls back when ${label}`, o.MODEL === "openai/gpt-5.6-luna", `got ${JSON.stringify(o.MODEL)}`);
}

const e2 = await withEnv({ OPENROUTER_EMBED_MODEL: "some/other-model" }, EMBED);
check("embed model honours a real override", e2.EMBED_MODEL === "some/other-model", `got ${e2.EMBED_MODEL}`);

const o2 = await withEnv({ OPENROUTER_MODEL: "some/other-model" }, OR);
check("chat model honours a real override", o2.MODEL === "some/other-model", `got ${o2.MODEL}`);

// ── Semantic floor ────────────────────────────────────────────────
// The most dangerous of the three: a floor of 0 does not raise an error, it
// just quietly returns the entire library as "related by meaning".
const floorCases: Array<[string, string | undefined, number]> = [
  ["unset", undefined, 0.22],
  ["empty string (the compose case)", "", 0.22],
  ["whitespace only", "  ", 0.22],
  ["non-numeric", "high", 0.22],
  ["negative", "-1", 0.22],
  ["above 1", "1.5", 0.22],
  ["a real override", "0.4", 0.4],
  ["zero, stated explicitly", "0", 0],
  ["one, stated explicitly", "1", 1],
];
// readFloor() reads process.env when *called*, not when imported, so it has to
// be invoked while the variable is still set — withEnv restores on the way out.
// (An earlier version of this test called it afterwards and every case returned
// the default, which made the invalid-input cases pass for the wrong reason.)
const { readFloor } = await import(EMBED);
for (const [label, value, want] of floorCases) {
  const saved = process.env.OPENROUTER_SEMANTIC_FLOOR;
  if (value === undefined) delete process.env.OPENROUTER_SEMANTIC_FLOOR;
  else process.env.OPENROUTER_SEMANTIC_FLOOR = value;
  let got: number;
  try {
    got = readFloor();
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_SEMANTIC_FLOOR;
    else process.env.OPENROUTER_SEMANTIC_FLOOR = saved;
  }
  check(`floor: ${label} -> ${want}`, got === want, `got ${got}`);
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
