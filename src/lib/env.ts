/**
 * Defensive environment parsing.
 *
 * This exists because of one specific production failure mode: Docker Compose
 * turns a variable listed under `environment:` but absent from the env file
 * into the EMPTY STRING, not into unset. `??` does not catch that, and
 * `Number("")` is 0 rather than NaN — so `Number(process.env.X ?? 0.22)`
 * silently yields 0 in production and nowhere else.
 *
 * For a similarity threshold that is the worst possible shape of bug: a floor
 * of 0 raises no error, it just quietly matches everything.
 *
 * `readFloor()` in search/embed.ts and `recFloor()` in sources/similar.ts are
 * the same logic written twice. This is the shared version; those two can
 * adopt it whenever they are next touched, but they are correct as they stand
 * and one of them is mid-flight in the working tree, so neither is rewritten
 * here just to route through it.
 */

/**
 * Reads a 0–1 value from the environment, falling back loudly.
 *
 * Refuses empty, non-numeric and out-of-range values rather than coercing
 * them: a threshold that silently means "match everything" is far worse than
 * one that is obviously wrong in a log line.
 */
export function readUnitFloat(name: string, fallback: number, tag: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[${tag}] ignoring ${name}=${JSON.stringify(raw)} ` +
        `(want a number 0-1); using ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

/** As above, for a positive whole number — sizes and caps rather than ratios. */
export function readPositiveInt(name: string, fallback: number, tag: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[${tag}] ignoring ${name}=${JSON.stringify(raw)} ` +
        `(want a positive whole number); using ${fallback}`
    );
    return fallback;
  }
  return parsed;
}
