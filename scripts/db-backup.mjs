#!/usr/bin/env node
/**
 * Timestamped backup of a rightread database.
 *
 *   node scripts/db-backup.mjs [--db <path>] [--out <dir>] [--keep 20]
 *
 * Uses SQLite's own backup API rather than copying the file, so it is safe to
 * run against a database the server is actively writing to — a plain `cp` of a
 * live SQLite file can capture a torn page or miss the -wal contents.
 *
 * Defaults to DATABASE_URL, so on the server this just works:
 *   docker exec <container> node scripts/db-backup.mjs
 */

import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { argv, env, exit } from "node:process";

function parseArgs() {
  const args = { keep: 20 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--keep") args.keep = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${a}`);
      exit(2);
    }
  }
  return args;
}

/** DATABASE_URL is a Prisma "file:..." URL; strip the scheme. */
function dbPathFromEnv() {
  const url = env.DATABASE_URL;
  if (!url?.startsWith("file:")) return null;
  return url.slice("file:".length);
}

async function main() {
  const args = parseArgs();
  const dbPath = args.db ?? dbPathFromEnv();

  if (!dbPath) {
    console.error("No database given. Pass --db or set DATABASE_URL.");
    exit(2);
  }
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    exit(1);
  }

  const outDir = args.out ?? join(dirname(dbPath), "backups");
  mkdirSync(outDir, { recursive: true });

  // Colons are illegal in Windows filenames, so no ISO time-of-day separators.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = join(outDir, `${basename(dbPath, ".db")}-${stamp}.db`);

  const source = new DatabaseSync(dbPath, { readOnly: true });
  await backup(source, target);
  source.close();

  const counts = (() => {
    const db = new DatabaseSync(target, { readOnly: true });
    const rows = ["User", "Item", "CaptureToken"].map(
      (t) => `${t} ${db.prepare(`SELECT count(*) c FROM ${t}`).get().c}`
    );
    db.close();
    return rows.join(", ");
  })();

  console.log(`Backed up to ${target}`);
  console.log(`  ${(statSync(target).size / 1024).toFixed(0)} KB — ${counts}`);

  // Prune oldest, keeping the most recent N.
  if (args.keep > 0) {
    const backups = readdirSync(outDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => join(outDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    for (const old of backups.slice(args.keep)) {
      unlinkSync(old);
      console.log(`  pruned ${basename(old)}`);
    }
  }
}

main();
