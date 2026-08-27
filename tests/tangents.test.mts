/**
 * Reader endings and trails — offline, synthetic vectors, no database.
 *
 * These pin the geometry rules: which band an item falls into decides what the
 * panel *claims* about it ("a step away" vs "a leap"), and the trail's drift
 * objective is the difference between a walk and an orbit. A silent mistake in
 * either mislabels rather than crashes, which is why they get tests.
 */

import { estimateBands, type Bands } from "../src/lib/graph/bands.ts";
import { pickEndings } from "../src/lib/sources/endings.ts";
import { walkTrail } from "../src/lib/trail/walk.ts";
import type { VectorMatrix } from "../src/lib/search/vectors.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

/**
 * A matrix whose rows are unit vectors on a 2-D circle embedded in `dims`.
 * Angle controls similarity exactly: cos(a-b). This makes band membership a
 * function of arithmetic, not of luck.
 */
function circleMatrix(angles: number[], dims = 8): VectorMatrix {
  const flat = new Float32Array(angles.length * dims);
  angles.forEach((angle, i) => {
    flat[i * dims] = Math.cos(angle);
    flat[i * dims + 1] = Math.sin(angle);
  });
  return { ids: angles.map((_, i) => `item-${i}`), dims, flat };
}

// ── estimateBands ─────────────────────────────────────────────────
{
  // 24 items spread over a quarter circle: plenty of pairs, a real spread.
  const angles = Array.from({ length: 24 }, (_, i) => (i / 24) * (Math.PI / 2));
  const bands = estimateBands(circleMatrix(angles));
  check("bands exist on a real corpus", bands !== null);
  if (bands) {
    check(
      "bands are ordered: leap < moderate < strong",
      bands.leapAt < bands.moderateAt && bands.moderateAt < bands.strongAt,
      JSON.stringify(bands)
    );
    check("sampled every pair on a small corpus", bands.pairsSampled === (24 * 23) / 2);
  }

  check("too few items yields null, not noise", estimateBands(circleMatrix([0, 0.1, 0.2])) === null);

  // Unembedded rows (all zero) must not drag the percentiles down.
  const withZeros = circleMatrix(angles);
  const padded: VectorMatrix = {
    ids: [...withZeros.ids, "z1", "z2", "z3"],
    dims: withZeros.dims,
    flat: (() => {
      const f = new Float32Array((angles.length + 3) * withZeros.dims);
      f.set(withZeros.flat);
      return f;
    })(),
  };
  const b2 = estimateBands(padded);
  check(
    "zero rows are ignored entirely",
    b2 !== null && b2.pairsSampled === (24 * 23) / 2,
    JSON.stringify(b2)
  );

  // Determinism: the same corpus always yields the same bands.
  const again = estimateBands(circleMatrix(angles));
  check("bands are deterministic", JSON.stringify(again) === JSON.stringify(bands));
}

// ── pickEndings ───────────────────────────────────────────────────
{
  const bands: Bands = { leapAt: 0.3, moderateAt: 0.5, strongAt: 0.8, pairsSampled: 999 };
  const rows = [
    { id: "dup", score: 0.995, kind: "article", status: "unread" },
    { id: "strong", score: 0.85, kind: "article", status: "archived" },
    { id: "unreadNear", score: 0.6, kind: "article", status: "unread" },
    { id: "stepArch", score: 0.55, kind: "article", status: "archived" },
    { id: "leapSameKind", score: 0.4, kind: "article", status: "archived" },
    { id: "leapOtherKind", score: 0.45, kind: "reference", status: "archived" },
    { id: "noise", score: 0.1, kind: "article", status: "unread" },
  ];

  const picked = pickEndings(rows, "article", bands);
  check("backlog takes the best unread neighbour", picked.backlogId === "unreadNear");
  check(
    "step falls in the moderate band, excluding backlog's pick",
    picked.stepId === "stepArch",
    String(picked.stepId)
  );
  check(
    "leap prefers a different kind even at a higher score",
    picked.leapId === "leapOtherKind",
    String(picked.leapId)
  );

  // Same-kind only: the weakest qualifying connection wins — a leap leaps.
  const sameKind = rows.filter((r) => r.kind === "article");
  const p2 = pickEndings(sameKind, "article", bands);
  check("without a kind contrast, the leap takes the weakest", p2.leapId === "leapSameKind");

  check(
    "near-duplicates never appear",
    ![picked.backlogId, picked.stepId, picked.leapId].includes("dup")
  );
  const ids = [picked.backlogId, picked.stepId, picked.leapId].filter(Boolean);
  check("no id fills two slots", new Set(ids).size === ids.length);

  const noBands = pickEndings(rows, "article", null);
  check(
    "no bands means no claims",
    noBands.backlogId === null && noBands.stepId === null && noBands.leapId === null
  );

  // The backlog floor never sits below the measured precision floor (0.45).
  const lowBands: Bands = { leapAt: 0.1, moderateAt: 0.2, strongAt: 0.3, pairsSampled: 999 };
  const weakUnread = [{ id: "w", score: 0.25, kind: "article", status: "unread" }];
  check(
    "backlog respects the precision floor when bands run low",
    pickEndings(weakUnread, "article", lowBands).backlogId === null
  );
}

// ── walkTrail ─────────────────────────────────────────────────────
{
  // A chain around the circle: each item ~15° from its neighbours, so the
  // moderate band connects neighbours and drift means walking the arc.
  const step = Math.PI / 12;
  const angles = Array.from({ length: 12 }, (_, i) => i * step);
  const matrix = circleMatrix(angles);
  const bands = estimateBands(matrix)!;
  check("chain corpus has bands", bands !== null);

  const walk = walkTrail(matrix, "item-0", bands)!;
  check("walk exists", walk !== null);
  const ids = walk.stops.map((s) => s.id);
  check("starts at the start", ids[0] === "item-0");
  check("never revisits", new Set(ids).size === ids.length);
  check(
    "drifts: the last stop is farther from the start than the first hop",
    walk.stops[walk.stops.length - 1].simToStart < walk.stops[1].simToStart,
    JSON.stringify(walk.stops.map((s) => s.simToStart.toFixed(2)))
  );

  const again = walkTrail(matrix, "item-0", bands)!;
  check(
    "deterministic at seed 0",
    JSON.stringify(again.stops) === JSON.stringify(walk.stops)
  );

  const seeded = walkTrail(matrix, "item-0", bands, { seed: 7 })!;
  check("a seed can walk differently (or at worst identically)", seeded !== null);

  check("unknown start returns null", walkTrail(matrix, "nope", bands) === null);

  // An unembedded start has no geometry to walk.
  const withZero: VectorMatrix = {
    ids: [...matrix.ids, "zero"],
    dims: matrix.dims,
    flat: (() => {
      const f = new Float32Array((angles.length + 1) * matrix.dims);
      f.set(matrix.flat);
      return f;
    })(),
  };
  check("unembedded start returns null", walkTrail(withZero, "zero", bands) === null);

  // A tiny fragmented corpus ends early and says so, rather than throwing or
  // padding. Three tight items + the start: at most a couple of real hops.
  const tiny = circleMatrix([0, 0.1, 0.2, 0.25]);
  const tinyBands: Bands = { leapAt: 0.9, moderateAt: 0.97, strongAt: 0.995, pairsSampled: 6 };
  const short = walkTrail(tiny, "item-0", tinyBands);
  check(
    "a thin corpus gives a short honest trail",
    short !== null && short.endedEarly && short.stops.length >= 2,
    JSON.stringify(short)
  );

  // Duplicate vectors are skipped: two copies of the same article are one stop.
  const dupMatrix = circleMatrix([0, 0.5, 0.5, 1.0]);
  const dupBands: Bands = { leapAt: 0.5, moderateAt: 0.7, strongAt: 0.999, pairsSampled: 6 };
  const dupWalk = walkTrail(dupMatrix, "item-0", dupBands);
  if (dupWalk) {
    const stopIds = dupWalk.stops.map((s) => s.id);
    check(
      "near-duplicate stops collapse to one",
      !(stopIds.includes("item-1") && stopIds.includes("item-2")),
      JSON.stringify(stopIds)
    );
  } else {
    check("duplicate-vector walk at least runs", false, "walk returned null");
  }
}

console.log(failed === 0 ? "\nAll tangent rules pass." : `\n${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
