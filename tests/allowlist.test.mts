/**
 * Sign-in allow list.
 *
 * The case that matters most is the empty one. Docker Compose turns a variable
 * listed under `environment:` but absent from the env file into the EMPTY
 * STRING rather than into unset, so "no list configured" is a state that
 * happens in production and nowhere else. It must deny, not admit — a gate
 * that silently opens is worse than one that visibly jams shut.
 */

import { allowedEmails, isEmailAllowed, normalizeEmail } from "../src/lib/allowlist.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const VAR = "RIGHTREAD_ALLOWED_EMAILS";

/** Runs `fn` with the allow list set to `value`, then puts the env back. */
function withList<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  }
}

// ── No list configured: everyone is refused ───────────────────────
for (const [label, value] of [
  ["unset", undefined],
  ["empty string (the compose case)", ""],
  ["whitespace only", "   "],
  ["separators but no addresses", " , ; "],
] as Array<[string, string | undefined]>) {
  withList(value, () => {
    check(`${label}: nobody is allowed`, !isEmailAllowed("jklondon@gmail.com"));
    check(`${label}: list reads as empty`, allowedEmails().length === 0);
  });
}

// ── The configured pair ───────────────────────────────────────────
const BOTH = "jklondon@gmail.com,mailsve@gmail.com";

withList(BOTH, () => {
  check("first address allowed", isEmailAllowed("jklondon@gmail.com"));
  check("second address allowed", isEmailAllowed("mailsve@gmail.com"));
  check("a stranger is refused", !isEmailAllowed("someone@else.com"));
  check("both parsed", allowedEmails().length === 2, JSON.stringify(allowedEmails()));
});

// ── Shapes a human types into an env file ─────────────────────────
const forgiving: Array<[string, string]> = [
  ["spaces after commas", "jklondon@gmail.com, mailsve@gmail.com"],
  ["spaces around everything", "  jklondon@gmail.com ,  mailsve@gmail.com  "],
  ["semicolons", "jklondon@gmail.com;mailsve@gmail.com"],
  ["plain whitespace", "jklondon@gmail.com mailsve@gmail.com"],
  ["a newline", "jklondon@gmail.com\nmailsve@gmail.com"],
  ["a trailing comma", "jklondon@gmail.com,mailsve@gmail.com,"],
];
for (const [label, value] of forgiving) {
  withList(value, () => {
    check(
      `${label}: both still allowed`,
      isEmailAllowed("jklondon@gmail.com") && isEmailAllowed("mailsve@gmail.com"),
      JSON.stringify(allowedEmails())
    );
  });
}

// ── Case and canonicalization ─────────────────────────────────────
// Auth.js lower-cases and NFKC-normalizes before it stores User.email, so the
// allow list has to compare the same way or an address passes the gate and is
// then persisted under a spelling the gate would refuse.
withList("JKLondon@Gmail.COM", () => {
  check("list entry case is ignored", isEmailAllowed("jklondon@gmail.com"));
  check("submitted case is ignored", isEmailAllowed("JKLONDON@GMAIL.COM"));
  check("entry is stored lower-cased", allowedEmails()[0] === "jklondon@gmail.com");
});

withList(BOTH, () => {
  // U+FF20 FULLWIDTH COMMERCIAL AT survives a naive single-`@` check and can be
  // folded to ASCII `@` downstream. NFKC-first means it lands on the real
  // address rather than sneaking past as a different string.
  check("fullwidth @ folds to the real address", isEmailAllowed("jklondon＠gmail.com"));
  check("quoted address refused", !isEmailAllowed('"jklondon@gmail.com"@evil.com'));
  check("two @ refused", !isEmailAllowed("jklondon@gmail.com@evil.com"));
  check("no @ refused", !isEmailAllowed("jklondon"));
  check("empty refused", !isEmailAllowed(""));
  check("null refused", !isEmailAllowed(null));
  check("undefined refused", !isEmailAllowed(undefined));
  check("a lookalike domain is refused", !isEmailAllowed("jklondon@gmai1.com"));
  check("a plus-alias is not the same address", !isEmailAllowed("jklondon+x@gmail.com"));
});

// ── Junk in the list doesn't take the good entries down with it ───
withList("not-an-email, jklondon@gmail.com, @, mailsve@gmail.com", () => {
  check("valid entries survive junk", allowedEmails().length === 2, JSON.stringify(allowedEmails()));
  check("junk grants nothing", !isEmailAllowed("not-an-email"));
  check("good entry still allowed", isEmailAllowed("mailsve@gmail.com"));
});

withList("jklondon@gmail.com, JKLondon@gmail.com, jklondon@gmail.com", () => {
  check("duplicates collapse", allowedEmails().length === 1, JSON.stringify(allowedEmails()));
});

// ── normalizeEmail directly ───────────────────────────────────────
check("normalize trims and lowers", normalizeEmail("  Foo@Bar.COM ") === "foo@bar.com");
check("normalize truncates domain at a comma", normalizeEmail("foo@bar.com,evil.com") === "foo@bar.com");
check("normalize rejects a bare local part", normalizeEmail("foo") === null);
check("normalize rejects an empty domain", normalizeEmail("foo@") === null);
check("normalize rejects an empty local part", normalizeEmail("@bar.com") === null);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
