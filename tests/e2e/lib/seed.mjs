/**
 * Signs the test user in, the only way that needs no email: by writing the
 * rows a completed sign-in leaves behind.
 *
 * Auth.js is configured with database sessions (src/auth.ts), so being signed
 * in means "a Session row whose sessionToken equals the cookie". This script
 * runs inside the app container against the throwaway database and inserts a
 * User and that Session. Nothing in the app is changed or bypassed to allow
 * it: it is ordinary access to a database file that only this test run owns.
 *
 * Run by run.sh and canary.sh as:
 *   docker exec -e E2E_SESSION_TOKEN=… <app> node /e2e/lib/seed.mjs
 *
 * Uses node:sqlite (Node 22+; the image is Node 24) so it needs nothing from
 * node_modules. Safe to run twice.
 */

import { DatabaseSync } from "node:sqlite";

const token = process.env.E2E_SESSION_TOKEN;
const dbUrl = process.env.DATABASE_URL ?? "";
if (!token || token.length < 32) {
  console.error("seed: E2E_SESSION_TOKEN must be set to a random token");
  process.exit(2);
}
if (!dbUrl.startsWith("file:") || dbUrl.includes("production")) {
  // start.sh applies the schema to whatever DATABASE_URL names. This script
  // must never be pointed at a real library.
  console.error("seed: refusing to touch a database that is not a throwaway file");
  process.exit(2);
}

const db = new DatabaseSync(dbUrl.slice("file:".length));
const now = Date.now();
const year = 365 * 24 * 60 * 60 * 1000;

db.prepare(
  `INSERT OR IGNORE INTO User (id, name, email, emailVerified, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?)`
).run("e2e-user", "Test Reader", "reader@e2e.test", now, now, now);

db.prepare(
  `INSERT OR REPLACE INTO Session (id, sessionToken, userId, expires)
   VALUES (?, ?, ?, ?)`
).run("e2e-session", token, "e2e-user", now + year);

const users = db.prepare("SELECT COUNT(*) AS n FROM User").get().n;
db.close();
console.log(`seed: user reader@e2e.test signed in (${users} user in the database)`);
