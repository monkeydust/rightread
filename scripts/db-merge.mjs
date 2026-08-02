#!/usr/bin/env node
/**
 * Merges one rightread database into another. Additive only.
 *
 *   node scripts/db-merge.mjs --from <source.db> --to <target.db> [--dry-run]
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
 */

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
    else {
      console.error(`Unknown argument: ${a}`);
      exit(2);
    }
  }
  if (!args.from || !args.to) {
    console.error(
      "Usage: node scripts/db-merge.mjs --from <source.db> --to <target.db> [--dry-run]"
    );
    exit(2);
  }
  return args;
}

const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function main() {
  const { from, to, dryRun } = parseArgs();

  for (const [label, path] of [["source", from], ["target", to]]) {
    if (!existsSync(path)) {
      console.error(`No ${label} database at ${path}`);
      exit(1);
    }
  }

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
    for (const table of ["Item", "CaptureToken"]) {
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
      ["User", "Item", "CaptureToken"]
        .map((t) => `${t} ${dst.prepare(`SELECT count(*) c FROM ${t}`).get().c}`)
        .join(", ")
  );
  if (dryRun) console.log("\n  Dry run — no changes written.");

  src.close();
  dst.close();
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
