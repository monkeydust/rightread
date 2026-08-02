import path from "path";

/**
 * Resolves DATABASE_URL to an absolute path.
 *
 * Prisma resolves a relative `file:` URL differently depending on who is
 * asking: the CLI resolves it against the schema directory (prisma/), the
 * runtime against process.cwd(). That silently gives you two different
 * databases. Everything therefore goes through this, so both agree on the
 * project root.
 *
 * Absolute URLs (Docker's file:/app/data/production.db) pass through untouched.
 */
export function resolveDatabaseUrl(raw = process.env.DATABASE_URL): string {
  const url = raw ?? "file:./prisma/dev.db";
  if (!url.startsWith("file:")) return url;

  const filePath = url.slice("file:".length);
  // Already absolute — POSIX (/data/x.db) or Windows (C:\data\x.db).
  if (path.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) return url;

  const absolute = path.resolve(process.cwd(), filePath);
  return `file:${absolute.replace(/\\/g, "/")}`;
}
