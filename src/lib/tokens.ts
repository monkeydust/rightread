import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";

/** Tokens are stored hashed; the plaintext is shown to the user exactly once. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return `rr_${randomBytes(24).toString("base64url")}`;
}

/**
 * Resolves a bearer token to a user id, or null.
 * The hash lookup is a unique-index hit; the timingSafeEqual afterwards keeps
 * the comparison constant-time on the off-chance of a hash prefix collision.
 */
export async function userIdFromToken(token: string): Promise<string | null> {
  if (!token) return null;

  const hash = hashToken(token);
  const record = await prisma.captureToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, userId: true, tokenHash: true },
  });
  if (!record) return null;

  const a = Buffer.from(record.tokenHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Fire-and-forget: last-used is informational, not worth blocking capture.
  prisma.captureToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return record.userId;
}

/** Reads a bearer token from the Authorization header or ?token= query param. */
export function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const url = new URL(request.url);
  return url.searchParams.get("token");
}
