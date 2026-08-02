/**
 * Proves the merge's contract: additive, idempotent, target-wins, and correct
 * across the user-id remapping that a fresh server sign-in forces.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rr-merge-"));
const SCHEMA = `
CREATE TABLE User (
  id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
  emailVerified DATETIME, image TEXT, createdAt DATETIME, updatedAt DATETIME
);
CREATE TABLE Item (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT DEFAULT 'Untitled', contentHtml TEXT, status TEXT DEFAULT 'unread',
  starred INTEGER DEFAULT 0, position REAL DEFAULT 0, progress REAL DEFAULT 0,
  savedAt DATETIME, updatedAt DATETIME, extractStatus TEXT DEFAULT 'pending',
  UNIQUE(userId, url),
  FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE
);
CREATE TABLE CaptureToken (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT, tokenHash TEXT UNIQUE,
  lastUsedAt DATETIME, createdAt DATETIME,
  FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE
);
`;

function makeDb(file, users, items) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [id, email] of users) {
    db.prepare("INSERT INTO User (id,email,createdAt,updatedAt) VALUES (?,?,1,1)").run(id, email);
  }
  for (const [id, userId, url, title] of items) {
    db.prepare(
      "INSERT INTO Item (id,userId,url,title,savedAt,updatedAt,extractStatus) VALUES (?,?,?,?,1,1,'ok')"
    ).run(id, userId, url, title);
  }
  db.close();
}

const merge = (from, to, extra = []) =>
  execFileSync("node", ["scripts/db-merge.mjs", "--from", from, "--to", to, ...extra], {
    encoding: "utf8",
  });

const q = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(sql).all();
  db.close();
  return rows;
};

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── The real first-deploy shape: the server already has a User row for the
//    same person, created by signing in, with a DIFFERENT id.
const local = join(dir, "local.db");
const server = join(dir, "server.db");

makeDb(local, [["local-uid", "me@example.com"]], [
  ["i1", "local-uid", "https://a.com/one", "One"],
  ["i2", "local-uid", "https://a.com/two", "Two"],
]);
makeDb(server, [["server-uid", "me@example.com"]], [
  ["i9", "server-uid", "https://a.com/two", "Two (edited on server)"],
  ["i8", "server-uid", "https://a.com/three", "Three"],
]);

merge(local, server);

const items = q(server, "SELECT id,userId,url,title FROM Item ORDER BY url");
check("no duplicate users", q(server, "SELECT * FROM User").length === 1);
check(
  "imported items remapped to the server's user id",
  items.every((i) => i.userId === "server-uid"),
  JSON.stringify(items)
);
check("local-only item was added", items.some((i) => i.url === "https://a.com/one"));
check("server-only item survived", items.some((i) => i.url === "https://a.com/three"));
check(
  "target wins on conflict — server's edit not overwritten",
  items.find((i) => i.url === "https://a.com/two")?.title === "Two (edited on server)"
);
check("nothing deleted, 3 items total", items.length === 3, `got ${items.length}`);

// ── Idempotence: a second run must change nothing.
const before = JSON.stringify(q(server, "SELECT * FROM Item ORDER BY id"));
const out = merge(local, server);
const after = JSON.stringify(q(server, "SELECT * FROM Item ORDER BY id"));
check("re-running the merge changes nothing", before === after);
check("second run reports 0 added", /Item\s+0 added/.test(out), out.split("\n").filter(l=>l.includes("Item")).join(" "));

// ── Dry run writes nothing.
const fresh = join(dir, "fresh.db");
makeDb(fresh, [["u", "other@example.com"]], []);
merge(local, fresh, ["--dry-run"]);
check("dry run writes nothing", q(fresh, "SELECT * FROM Item").length === 0);

// ── Empty target: a genuinely first deploy.
const empty = join(dir, "empty.db");
makeDb(empty, [], []);
merge(local, empty);
check("seeds an empty server", q(empty, "SELECT * FROM Item").length === 2);
check("carries the user across", q(empty, "SELECT * FROM User").length === 1);
check(
  "foreign keys intact after seeding",
  q(empty, "PRAGMA foreign_key_check").length === 0
);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
