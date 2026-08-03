#!/usr/bin/env node
/**
 * Drops the FTS5 search index and its triggers. Run immediately BEFORE
 * `prisma db push` at startup.
 *
 * Why this exists
 * ---------------
 * `prisma db push` reconciles the entire database against schema.prisma. The
 * ItemSearch virtual table and the Item_ai/ad/au triggers cannot be expressed
 * in a Prisma schema, so push sees objects it does not own, classifies
 * dropping them as data loss, and refuses to run without --accept-data-loss.
 * Under `set -e` that kills the container on boot — which is exactly what
 * happened the first time the app restarted after search shipped.
 *
 * Why not just pass --accept-data-loss
 * ------------------------------------
 * Because that flag is not scoped to the search index. It would equally
 * authorize dropping a real column on any future schema drift, silently, at
 * boot, in production. This app's whole premise is that nothing is lost unless
 * the user deletes it, so the destructive step is made narrow and explicit
 * here rather than blanket-approved there.
 *
 * Why dropping is safe
 * --------------------
 * The index is 100% derived from Item — title, excerpt, textContent, url. It
 * holds no original data. ensureSearchIndex() recreates it on the next search
 * and, finding it empty, rebuilds it from Item. Embeddings are unaffected:
 * they live in Item.embedding, a real Prisma column that push manages.
 *
 * The cost is a reindex per deploy. That is a full table scan of text already
 * in memory — milliseconds at this size, and still seconds at tens of
 * thousands of items. If it ever stops being cheap, the fix is to move to
 * `prisma migrate deploy`, which applies recorded migrations instead of
 * diffing whole-database state and so leaves unmanaged objects alone.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { env, exit } from "node:process";

const url = env.DATABASE_URL ?? "file:./prisma/dev.db";
if (!url.startsWith("file:")) {
  console.log("[search] DATABASE_URL is not a file: URL; nothing to drop.");
  exit(0);
}

const dbPath = url.slice("file:".length);

// First boot on a fresh volume: push is about to create the database. Nothing
// exists to drop, and opening the file here would create an empty one.
if (!existsSync(dbPath)) {
  console.log(`[search] ${dbPath} does not exist yet; nothing to drop.`);
  exit(0);
}

try {
  const db = new DatabaseSync(dbPath);
  for (const sql of [
    "DROP TRIGGER IF EXISTS Item_ai",
    "DROP TRIGGER IF EXISTS Item_ad",
    "DROP TRIGGER IF EXISTS Item_au",
    "DROP TABLE IF EXISTS ItemSearch",
  ]) {
    db.exec(sql);
  }
  db.close();
  console.log("[search] index dropped; it rebuilds from Item on first search.");
} catch (err) {
  // Never block startup. Worst case push fails loudly on the next line, which
  // is a better failure than the app refusing to boot because a cleanup step
  // for a derived cache did not work.
  console.warn("[search] could not drop index objects:", err.message);
}
