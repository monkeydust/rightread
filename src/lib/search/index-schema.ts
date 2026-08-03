import { prisma } from "@/lib/db";

/**
 * The full-text index, and the triggers that keep it honest.
 *
 * Prisma cannot express a virtual table, so this is raw SQL run idempotently
 * at startup and before any search. Everything is IF NOT EXISTS, so it is safe
 * to call repeatedly and it self-heals if `prisma db push` ever drops it.
 *
 * Sync is done with triggers rather than from application code on purpose.
 * Application-code sync is only as complete as the set of write paths you
 * remembered — one `updateMany` somewhere and the index silently rots, which
 * is the worst failure mode a search index has. Triggers cannot be bypassed by
 * a query that goes through the database at all.
 */

let ready: Promise<void> | null = null;

const STATEMENTS = [
  // Standalone (not `content=`) FTS5 table: the source rows live in Item,
  // which has a TEXT cuid primary key, and external-content FTS5 requires an
  // INTEGER rowid to join on. Storing the id as an UNINDEXED column costs a
  // little space and avoids the mismatch entirely.
  `CREATE VIRTUAL TABLE IF NOT EXISTS ItemSearch USING fts5(
     itemId UNINDEXED,
     userId UNINDEXED,
     title,
     excerpt,
     body,
     url,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,

  `CREATE TRIGGER IF NOT EXISTS Item_ai AFTER INSERT ON Item BEGIN
     INSERT INTO ItemSearch(itemId, userId, title, excerpt, body, url)
     VALUES (new.id, new.userId, coalesce(new.title,''), coalesce(new.excerpt,''),
             coalesce(new.textContent,''), coalesce(new.url,''));
   END`,

  `CREATE TRIGGER IF NOT EXISTS Item_ad AFTER DELETE ON Item BEGIN
     DELETE FROM ItemSearch WHERE itemId = old.id;
   END`,

  // Only rewrite the index when indexed content actually changed — a scroll
  // position or star toggle should not churn the FTS table.
  `CREATE TRIGGER IF NOT EXISTS Item_au AFTER UPDATE ON Item
     WHEN old.title IS NOT new.title
       OR old.excerpt IS NOT new.excerpt
       OR old.textContent IS NOT new.textContent
       OR old.url IS NOT new.url
   BEGIN
     DELETE FROM ItemSearch WHERE itemId = old.id;
     INSERT INTO ItemSearch(itemId, userId, title, excerpt, body, url)
     VALUES (new.id, new.userId, coalesce(new.title,''), coalesce(new.excerpt,''),
             coalesce(new.textContent,''), coalesce(new.url,''));
   END`,
];

/** Runs the DDL. Idempotent, and cheap enough to call before any index work. */
async function createSearchObjects(): Promise<void> {
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
  }
}

/** Creates the index and triggers once per process. Safe to call anywhere. */
export function ensureSearchIndex(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await createSearchObjects();
      // First run on an existing database: the triggers only fire on future
      // writes, so anything already saved would be invisible to search.
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        "SELECT count(*) AS n FROM ItemSearch"
      );
      if (Number(n) === 0) await reindexAll();
    })().catch((err) => {
      // Don't cache a failure — a transient error would otherwise disable
      // search for the life of the process.
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** Rebuilds the whole index from Item. Used on first run and by `npm run search:reindex`. */
export async function reindexAll(): Promise<number> {
  // Callable standalone (the backfill script runs it first), so it cannot
  // assume ensureSearchIndex has already created the table.
  await createSearchObjects();
  await prisma.$executeRawUnsafe("DELETE FROM ItemSearch");
  await prisma.$executeRawUnsafe(
    `INSERT INTO ItemSearch(itemId, userId, title, excerpt, body, url)
     SELECT id, userId, coalesce(title,''), coalesce(excerpt,''),
            coalesce(textContent,''), coalesce(url,'') FROM Item`
  );
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT count(*) AS n FROM ItemSearch"
  );
  return Number(n);
}
