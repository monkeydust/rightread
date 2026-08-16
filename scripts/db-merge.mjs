#!/usr/bin/env node
/**
 * Merges one rightread database into another. Additive only.
 *
 *   node scripts/db-merge.mjs --from <source.db> --to <target.db> [--dry-run]
 *                             [--only sources|items]
 *
 * --only sources  merges just the feed list and the harvested candidate pool,
 *                 leaving the reading library untouched. Seeding a server's
 *                 recommendation pool is a different job from importing
 *                 someone's saved articles, and conflating them would put
 *                 whatever happens to be in a dev database into the library.
 * --only items    the reverse: library and tokens only.
 *
 * Why not copy the file, as uk-property-analyzer does? Because that is a
 * one-way overwrite. It suits a project whose local database is the source of
 * truth, and would destroy a reading library that has been added to on the
 * server since the last deploy. This merges instead:
 *
 *   - rows are inserted, never updated and never deleted
 *   - where a row already exists on the target, the TARGET WINS — the live
 *     server is assumed to be ahead of whatever you are importing
 *   - running it twice changes nothing the second time
 *
 * So nothing is lost unless you delete it in the app.
 *
 * Identity is matched on natural keys, not row ids, because signing in on the
 * server creates a User row with a different cuid for the same person. Items
 * carry a userId, so importing them without remapping would orphan every one
 * of them. Users match on email, items on (userId, url) — the same uniqueness
 * the Prisma schema enforces.
 *
 * GROUPS ARE NOT MERGED, and the omission is deliberate rather than pending.
 * A Group has no natural key: `name` is not unique and any member can change
 * it. Matching on name would fuse two unrelated groups that happen to both be
 * called "Reading" and thereby hand each side's members access to the other's
 * shelf — a merge that manufactures a privacy breach. Matching on id instead
 * is safe but useless: ids only coincide when one database was copied from the
 * other, which is the case where there is nothing to merge.
 *
 * The honest price is that groups are recreated by hand after seeding a server
 * from a local database. A group is one row plus a few invitations, so that is
 * a minute of typing. If it ever stops being a minute, the fix is to match
 * Group on id — legitimate because, unlike a User, a group has no second
 * creation path — and to remap `MemberOf`, `GroupInvite`, `GroupShare` and
 * `GroupShareDismissal` through both a groupIdMap and the existing userIdMap.
 */

import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { argv, exit } from "node:process";

function parseArgs() {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--only") args.only = String(argv[++i] ?? "");
    else {
      console.error(`Unknown argument: ${a}`);
      exit(2);
    }
  }
  if (!args.from || !args.to) {
    console.error(
      "Usage: node scripts/db-merge.mjs --from <source.db> --to <target.db> " +
        "[--dry-run] [--only sources|items]"
    );
    exit(2);
  }
  return args;
}

const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function main() {
  const { from, to, dryRun, only: onlyArg } = parseArgs();

  for (const [label, path] of [["source", from], ["target", to]]) {
    if (!existsSync(path)) {
      console.error(`No ${label} database at ${path}`);
      exit(1);
    }
  }

  const only = onlyArg ?? "";
  if (only && only !== "sources" && only !== "items") {
    console.error(`--only takes "sources" or "items", not ${JSON.stringify(only)}`);
    exit(1);
  }
  const doSources = only !== "items";
  const doItems = only !== "sources";

  const src = new DatabaseSync(from, { readOnly: true });
  const dst = new DatabaseSync(to);

  // Foreign keys must hold at the end, but rows arrive out of order within a
  // transaction, so defer the check to COMMIT.
  dst.exec("PRAGMA foreign_keys = ON");
  dst.exec("BEGIN IMMEDIATE");

  const summary = [];
  let remapped = 0;

  try {
    // ── Users: match on email, remember how ids translate ──────────────
    const userIdMap = new Map();
    const srcUsers = src.prepare("SELECT * FROM User").all();
    const userCols = shared(src, dst, "User");
    let usersInserted = 0;

    for (const user of srcUsers) {
      const existing = dst
        .prepare("SELECT id FROM User WHERE email = ?")
        .get(user.email);

      if (existing) {
        if (existing.id !== user.id) remapped++;
        userIdMap.set(user.id, existing.id);
        continue;
      }

      if (!dryRun) insertRow(dst, "User", userCols, user);
      userIdMap.set(user.id, user.id);
      usersInserted++;
    }
    summary.push(["User", usersInserted, srcUsers.length - usersInserted]);

    // ── Everything owned by a user ─────────────────────────────────────
    // Deliberately not Session / VerificationToken / Account: those are
    // transient auth state, tied to a domain and regenerated at next sign-in,
    // so carrying them across would be noise at best.
    // Sources and candidates arrived later than this script did, so an older
    // backup will not have them. Guarding on the tables rather than assuming
    // them keeps a merge from a pre-recommendations database working — the
    // whole point of this script is that nothing is lost, including old copies.
    const canMergeSources =
      doSources &&
      hasTable(src, "Source") && hasTable(dst, "Source") &&
      hasTable(src, "Candidate") && hasTable(dst, "Candidate");

    // ── Sources: match on (userId, feedUrl), remember how ids translate ─
    // Candidates carry a sourceId, and ids do not survive across databases any
    // more than user ids do — importing them unremapped would either violate
    // the foreign key or attach every article to the wrong feed.
    const sourceIdMap = new Map();
    const srcSources = canMergeSources
      ? src.prepare("SELECT * FROM Source").all()
      : [];
    const sourceCols = canMergeSources ? shared(src, dst, "Source") : [];
    let sourcesInserted = 0;

    for (const source of srcSources) {
      const mappedUserId = userIdMap.get(source.userId);
      if (!mappedUserId) continue;

      const existing = dst
        .prepare("SELECT id FROM Source WHERE userId = ? AND feedUrl = ?")
        .get(mappedUserId, source.feedUrl);

      if (existing) {
        sourceIdMap.set(source.id, existing.id);
        continue;
      }
      if (!dryRun) {
        insertRow(dst, "Source", sourceCols, { ...source, userId: mappedUserId });
      }
      sourceIdMap.set(source.id, source.id);
      sourcesInserted++;
    }
    if (canMergeSources) {
      summary.push(["Source", sourcesInserted, srcSources.length - sourcesInserted]);
    }

    // ── Candidates: the harvested pool ──────────────────────────────────
    // Worth carrying because each one cost a fetch, an extraction and an
    // embedding. A fresh server would otherwise spend days rebuilding a pool
    // that already exists, and recommendations stay thin until it does.
    if (canMergeSources) {
      const cols = shared(src, dst, "Candidate");
      const rows = src.prepare("SELECT * FROM Candidate").all();
      let inserted = 0;

      for (const row of rows) {
        const mappedUserId = userIdMap.get(row.userId);
        const mappedSourceId = sourceIdMap.get(row.sourceId);
        if (!mappedUserId || !mappedSourceId) continue;

        // savedItemId points at an Item row id, which means nothing here. It is
        // reconciled by URL below, after Items have been merged.
        const candidate = {
          ...row,
          userId: mappedUserId,
          sourceId: mappedSourceId,
          savedItemId: null,
        };
        if (!dryRun) inserted += insertRow(dst, "Candidate", cols, candidate);
        else inserted++;
      }
      summary.push(["Candidate", inserted, rows.length - inserted]);
    }

    for (const table of doItems ? ["Item", "CaptureToken"] : []) {
      const cols = shared(src, dst, table);
      const rows = src.prepare(`SELECT * FROM ${table}`).all();
      let inserted = 0;

      for (const row of rows) {
        const mappedUserId = userIdMap.get(row.userId);
        if (!mappedUserId) {
          console.warn(
            `  ! ${table} ${row.id} belongs to unknown user ${row.userId} — skipped`
          );
          continue;
        }
        if (!dryRun) {
          // INSERT OR IGNORE is what makes "target wins" and "idempotent"
          // true: a clashing unique key is a no-op, not an overwrite.
          inserted += insertRow(dst, table, cols, { ...row, userId: mappedUserId });
        } else {
          inserted++;
        }
      }
      summary.push([table, inserted, rows.length - inserted]);
    }

    // ── Reconcile savedItemId ───────────────────────────────────────────
    // A candidate the user already saved must not come back as a
    // recommendation. Matched on URL, which is the only identity that survives
    // a database boundary — the same key similar.ts uses at query time.
    if (!dryRun && canMergeSources) {
      // Runs regardless of --only: the target's own items are what matter here,
      // not whether this run imported any.
      const linked = dst.prepare(
        `UPDATE Candidate SET savedItemId = (
           SELECT Item.id FROM Item
            WHERE Item.userId = Candidate.userId
              AND (Item.url = Candidate.url
                OR (Candidate.resolvedUrl IS NOT NULL AND Item.url = Candidate.resolvedUrl)
                OR (Item.resolvedUrl IS NOT NULL AND Item.resolvedUrl = Candidate.url))
            LIMIT 1)
          WHERE savedItemId IS NULL
            AND EXISTS (
              SELECT 1 FROM Item
               WHERE Item.userId = Candidate.userId
                 AND (Item.url = Candidate.url
                   OR (Candidate.resolvedUrl IS NOT NULL AND Item.url = Candidate.resolvedUrl)
                   OR (Item.resolvedUrl IS NOT NULL AND Item.resolvedUrl = Candidate.url)))`
      ).run();
      if (Number(linked.changes) > 0) {
        summary.push(["  (linked to saved)", Number(linked.changes), 0]);
      }
    }

    if (dryRun) {
      dst.exec("ROLLBACK");
    } else {
      dst.exec("COMMIT");
    }
  } catch (err) {
    dst.exec("ROLLBACK");
    console.error("\nMerge failed, nothing was written:", err.message);
    exit(1);
  }

  console.log(`\n${dryRun ? "Dry run" : "Merged"} ${from} -> ${to}\n`);
  for (const [table, inserted, skipped] of summary) {
    console.log(`  ${table.padEnd(14)} ${String(inserted).padStart(5)} added   ${String(skipped).padStart(5)} already present`);
  }
  if (remapped) {
    console.log(`\n  ${remapped} user(s) matched by email with a different id — items remapped.`);
  }
  console.log(
    `\n  Totals on target: ` +
      ["User", "Item", "CaptureToken", ...(hasTable(dst, "Source") ? ["Source", "Candidate"] : [])]
        .map((t) => `${t} ${dst.prepare(`SELECT count(*) c FROM ${t}`).get().c}`)
        .join(", ")
  );
  // Said out loud rather than left to the header comment: a merge that quietly
  // dropped a group would look exactly like a successful one.
  if (hasTable(src, "Group")) {
    const groups = src.prepare("SELECT count(*) c FROM `Group`").get().c;
    if (groups > 0) {
      console.log(
        `\n  Groups: not merged (${groups} in the source). A group has no natural key,` +
          `\n  so recreate them by hand on the target — see the note at the top of this script.`
      );
    }
  }
  if (dryRun) console.log("\n  Dry run — no changes written.");

  src.close();
  dst.close();
}

/** True when a table exists — older databases predate the newer features. */
function hasTable(db, table) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table)
  );
}

/** Columns present in both schemas; target-only columns fall back to defaults. */
function shared(src, dst, table) {
  const a = columnsOf(src, table);
  const b = new Set(columnsOf(dst, table));
  const common = a.filter((c) => b.has(c));
  const dropped = a.filter((c) => !b.has(c));
  if (dropped.length) {
    console.warn(
      `  ! ${table}: source columns not on target, ignored: ${dropped.join(", ")}`
    );
  }
  if (!common.length) throw new Error(`${table}: schemas share no columns`);
  return common;
}

/** @returns 1 if a row was written, 0 if an existing key made it a no-op. */
function insertRow(db, table, cols, row) {
  const sql =
    `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) ` +
    `VALUES (${cols.map(() => "?").join(",")})`;
  const result = db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
  return Number(result.changes) > 0 ? 1 : 0;
}

main();
