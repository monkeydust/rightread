/**
 * Pure group rules — no database, no request context.
 *
 * Everything here is a plain function over plain values so it can be tested
 * the way the rest of this repo tests things: `node --experimental-strip-types`
 * with no fixtures and no running server. The database-touching half lives in
 * `./access.ts`.
 */

/** Longer than this and a group name stops being a label and starts being prose. */
export const MAX_GROUP_NAME = 80;

/**
 * Canonicalizes a group name typed by a person.
 *
 * Collapses runs of whitespace — a name pasted from somewhere else routinely
 * arrives with a newline in it, and "Reading  Club" and "Reading Club" being
 * two different groups would be a puzzle, not a feature.
 *
 * Returns null for anything that is not a usable name, so callers reject
 * rather than storing an empty string.
 */
export function normalizeGroupName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_GROUP_NAME);
}

/** The fields a share copies off an Item. See `snapshotFromItem`. */
export type ShareSnapshot = {
  title: string;
  siteName: string | null;
  excerpt: string | null;
  leadImage: string | null;
};

/**
 * Builds the snapshot a share carries, from the sharer's own extracted Item.
 *
 * A share deliberately does not point at the Item it came from — it takes a
 * copy. See the note on `GroupShare` in the schema for why. This is the one
 * place that decides what gets copied, so the shelf and a re-share always agree.
 *
 * Falls back to the host label when there is nothing better: capture returns
 * before extraction finishes, so a link shared in the first second or two of
 * its life genuinely has no title yet, and "Untitled" on someone else's shelf
 * is worse than the hostname.
 */
export function snapshotFromItem(
  item: {
    title?: string | null;
    siteName?: string | null;
    excerpt?: string | null;
    leadImage?: string | null;
  } | null,
  fallbackTitle: string
): ShareSnapshot {
  const title = item?.title?.trim();
  return {
    title: title && title !== "Untitled" ? title : fallbackTitle,
    siteName: item?.siteName ?? null,
    excerpt: item?.excerpt ?? null,
    leadImage: item?.leadImage ?? null,
  };
}

/**
 * Whether a snapshot is worth replacing with a newer one.
 *
 * Re-sharing a link refreshes the shelf entry, but must not *downgrade* it: if
 * someone shares a URL a second time before their own extraction has finished,
 * the incoming snapshot is a bare hostname and the one already on the shelf is
 * a real article. Keep the better of the two.
 */
export function isBetterSnapshot(next: ShareSnapshot, current: ShareSnapshot): boolean {
  const nextHasText = Boolean(next.excerpt?.trim());
  const currentHasText = Boolean(current.excerpt?.trim());
  if (nextHasText !== currentHasText) return nextHasText;
  return next.title.length > current.title.length;
}
