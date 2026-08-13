/**
 * Who is allowed to sign in.
 *
 * rightread is multi-user — every row is scoped by `userId` — but it is not
 * open registration. Anyone who can reach the login page can ask for a magic
 * link, so without a gate the only thing standing between a stranger and an
 * account is not knowing the URL. `RIGHTREAD_ALLOWED_EMAILS` is that gate: a
 * comma-separated list of the addresses permitted to hold an account.
 *
 * An unset or empty list DENIES EVERYONE, deliberately, and says so in the
 * log. The alternative — treating "no list configured" as "let everyone in" —
 * is the failure shape this codebase already refuses elsewhere (see
 * `lib/env.ts`): Docker Compose turns a variable listed under `environment:`
 * but absent from the env file into the empty string rather than into unset,
 * so a fail-open default would silently throw the door open in production and
 * nowhere else, with nothing in any log to explain it. Locking everyone out is
 * loud, immediate, and fixed by setting one variable; a silently public
 * read-later library is none of those things.
 */

const ENV_VAR = "RIGHTREAD_ALLOWED_EMAILS";

const warned = new Set<string>();

/** Logs a given complaint once per process — this runs on every sign-in attempt. */
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * Canonicalizes an address for comparison.
 *
 * Mirrors Auth.js's own `defaultNormalizer` (NFKC, lower-cased, trimmed, one
 * `@`, domain truncated at the first comma) so that what we compare is exactly
 * what Auth.js will store as `User.email`. Diverging here would let an address
 * pass this check and be persisted under a different spelling.
 *
 * NFKC before validation matters: U+FF20 FULLWIDTH COMMERCIAL AT survives a
 * naive single-`@` check and can be folded to ASCII `@` further downstream.
 *
 * Returns null rather than throwing — a malformed address is a "no", not a
 * crash.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.normalize("NFKC").toLowerCase().trim();
  // Quotes let an address parser be talked into a second recipient, e.g.
  // `"attacker@evil.com"@victim.com`.
  if (!trimmed || trimmed.includes('"')) return null;

  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;

  const [local, rest] = parts;
  const domain = rest.split(",")[0];
  if (!local || !domain) return null;

  return `${local}@${domain}`;
}

/**
 * The configured allow list, normalized and de-duplicated.
 *
 * Reads the environment on every call rather than at import time so that tests
 * can vary it, and so a container restart is all it takes to change who has
 * access. Separators are forgiving — comma, semicolon or whitespace — because
 * this value is typed by hand into an env file.
 */
export function allowedEmails(): string[] {
  const raw = process.env[ENV_VAR];
  if (!raw?.trim()) return [];

  const out: string[] = [];
  for (const entry of raw.split(/[,;\s]+/)) {
    if (!entry) continue;
    const normalized = normalizeEmail(entry);
    if (!normalized) {
      warnOnce(`[auth] ignoring unparseable ${ENV_VAR} entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Whether this address may sign in.
 *
 * The single source of truth for the question. Called from the Auth.js `signIn`
 * callback, which is the real enforcement point — it gates both halves of the
 * magic-link flow, the request for a link and the click on it — and from the
 * login page, which asks first purely so it can say why rather than dumping the
 * visitor on an error page.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowed = allowedEmails();

  if (allowed.length === 0) {
    warnOnce(
      `[auth] ${ENV_VAR} is unset or empty, so no one can sign in. ` +
        `Set it to a comma-separated list of permitted addresses.`
    );
    return false;
  }

  const normalized = normalizeEmail(email);
  return normalized !== null && allowed.includes(normalized);
}
