/**
 * Key-phrase selection rules — offline, no network, no database, no API key.
 *
 * `selectHits()` is the whole decision: what clears the floor, in what order,
 * and how many survive. Everything else in match.ts is Prisma plumbing around
 * it, so this is the part worth pinning down.
 *
 * The database-level invariants — that a repeated sweep is idempotent via the
 * composite unique index, and that a dismissed candidate never resurfaces
 * under any origin — were verified against the real 202-article pool rather
 * than mocked here, because mocking Prisma would only test the mock.
 */

import { selectHits, PHRASE_FLOOR } from "../src/lib/phrases/match.ts";
import { readUnitFloat } from "../src/lib/env.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const DIMS = 8;

/** Unit vector along `axis`, optionally tilted towards the next one. */
function vec(axis: number, tilt = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[axis % DIMS] = 1;
  if (tilt) v[(axis + 1) % DIMS] = tilt;
  return v;
}

function bytes(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

const cand = (id: string, v: Float32Array | null) => ({
  id,
  embedding: v ? bytes(v) : null,
});

const query = vec(0);

// ── The floor is applied ──────────────────────────────────────────
{
  // cos(query, vec(0, t)) = 1/sqrt(1+t^2): t=0 -> 1.00, t=1 -> 0.71, t=3 -> 0.32
  const pool = [
    cand("exact", vec(0)),
    cand("close", vec(0, 1)),
    cand("far", vec(0, 3)),
    cand("orthogonal", vec(4)),
  ];

  const strict = selectHits(query, pool, 0.5);
  check(
    "floor 0.5 keeps only the two strong matches",
    strict.map((h) => h.id).join(",") === "exact,close",
    JSON.stringify(strict)
  );

  const loose = selectHits(query, pool, 0.3);
  check(
    "floor 0.3 also admits the weak one",
    loose.map((h) => h.id).join(",") === "exact,close,far",
    JSON.stringify(loose.map((h) => h.id))
  );

  check(
    "an orthogonal candidate never clears any positive floor",
    !selectHits(query, pool, 0.01).some((h) => h.id === "orthogonal")
  );

  check(
    "a floor nothing reaches returns nothing, and does not throw",
    // "exact" is excluded deliberately: it is the same vector as the query and
    // so scores exactly 1.0, which clears any floor <= 1. An earlier version of
    // this assertion left it in and failed — correctly.
    selectHits(query, pool.filter((c) => c.id !== "exact"), 0.99).length === 0
  );
}

// ── Ordering and cap ──────────────────────────────────────────────
{
  const pool = Array.from({ length: 30 }, (_, i) => cand(`c${i}`, vec(0, i * 0.1)));

  const hits = selectHits(query, pool, 0, 10);
  check("respects the cap", hits.length === 10, `${hits.length}`);
  check(
    "returns the best matches, not the first ones",
    hits[0].id === "c0" && hits[9].id === "c9",
    JSON.stringify(hits.map((h) => h.id))
  );
  check(
    "sorted strongest first",
    hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score)
  );
  check("scores are finite", hits.every((h) => Number.isFinite(h.score)));
}

// ── Degenerate input must not throw ───────────────────────────────
{
  check("empty pool yields nothing", selectHits(query, [], 0.3).length === 0);
  check(
    "candidates without embeddings are skipped, not counted",
    selectHits(query, [cand("a", null), cand("b", null)], 0).length === 0
  );
  check(
    "a mix of embedded and unembedded returns only the embedded",
    selectHits(query, [cand("a", null), cand("b", vec(0))], 0.5)
      .map((h) => h.id)
      .join(",") === "b"
  );
  check(
    "a zero vector scores 0 rather than NaN",
    selectHits(query, [cand("z", new Float32Array(DIMS))], 0).every((h) =>
      Number.isFinite(h.score)
    )
  );
  check(
    "a zero query vector does not throw",
    Number.isFinite(selectHits(new Float32Array(DIMS), [cand("a", vec(0))], 0)[0]?.score ?? 0)
  );
}

// ── The measured default ──────────────────────────────────────────
// 0.32 comes from scoring eight phrases against a real 202-article pool: the
// weakest genuine on-topic match landed at 0.349 and the strongest unrelated
// one at 0.256, so the floor sits between them. It is deliberately NOT the
// 0.45 document-to-document recommendation floor (a phrase is short, which is
// a different distribution) nor search's 0.22 (which favours recall).
check(
  "default phrase floor is the measured 0.32",
  Math.abs(PHRASE_FLOOR - 0.32) < 1e-9,
  `${PHRASE_FLOOR}`
);
check(
  "phrase floor sits between search's 0.22 and the 0.45 doc-to-doc floor",
  PHRASE_FLOOR > 0.22 && PHRASE_FLOOR < 0.45
);

// ── Env parsing ───────────────────────────────────────────────────
// The compose empty-string trap, which has now bitten this codebase twice.
for (const [label, value, want] of [
  ["unset", undefined, 0.32],
  ["empty string (the compose case)", "", 0.32],
  ["whitespace", "   ", 0.32],
  ["non-numeric", "high", 0.32],
  ["out of range", "2", 0.32],
  ["valid override", "0.4", 0.4],
] as Array<[string, string | undefined, number]>) {
  const saved = process.env.TEST_PHRASE_FLOOR;
  if (value === undefined) delete process.env.TEST_PHRASE_FLOOR;
  else process.env.TEST_PHRASE_FLOOR = value;
  const got = readUnitFloat("TEST_PHRASE_FLOOR", 0.32, "test");
  if (saved === undefined) delete process.env.TEST_PHRASE_FLOOR;
  else process.env.TEST_PHRASE_FLOOR = saved;
  check(`floor env: ${label} -> ${want}`, got === want, `got ${got}`);
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
