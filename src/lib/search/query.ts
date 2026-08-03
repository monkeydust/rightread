/**
 * Turns whatever someone typed into a valid FTS5 MATCH expression.
 *
 * FTS5 has its own query language, and raw user input routinely breaks it: an
 * unbalanced quote, a bare `AND`, a stray `(` or `-` all raise a syntax error
 * rather than returning no results. Since the input here is a search box, not
 * a query language, every token is quoted and the operators are ours to add.
 *
 * Supported deliberately:
 *   rust async        -> both words must appear (FTS5 ANDs by default)
 *   "exact phrase"    -> adjacent words, in order
 *   data*             -> prefix wildcard: data, database, dataset
 *   "web assem"*      -> prefix wildcard on a phrase
 *
 * Everything else — parentheses, NEAR, OR, AND, NOT, column filters — is
 * treated as literal text rather than syntax. That is the right trade for a
 * search box: a query can never fail, it can only match nothing.
 */

export type ParsedQuery = {
  /** Ready to pass to `... MATCH ?`. Null when there is nothing to search for. */
  match: string | null;
  /** The bare terms, for highlighting and for building the semantic query. */
  terms: string[];
  /** True if any term used a wildcard — surfaced in the UI so the behaviour is legible. */
  hasWildcard: boolean;
};

/** A quoted phrase (optionally followed by *), or a run of non-space characters. */
const TOKEN = /"([^"]*)"(\*?)|(\S+)/g;

/**
 * FTS5 tokenises on punctuation, so a term of pure punctuation indexes to
 * nothing and would produce an empty quoted string — itself a syntax error.
 */
function isSearchable(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

export function parseQuery(input: string): ParsedQuery {
  const raw = (input ?? "").trim();
  if (!raw) return { match: null, terms: [], hasWildcard: false };

  const parts: string[] = [];
  const terms: string[] = [];
  let hasWildcard = false;

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(raw)) !== null) {
    const isPhrase = m[1] !== undefined;
    let term = isPhrase ? m[1] : m[3];
    let prefix = isPhrase ? m[2] === "*" : false;

    if (!isPhrase) {
      // A trailing run of asterisks means prefix search; asterisks anywhere
      // else are literal, because FTS5 has no infix wildcard to map them to.
      const stripped = term.replace(/\*+$/, "");
      if (stripped !== term) prefix = true;
      term = stripped;

      // A quote inside a bare token is always the remains of an unbalanced
      // pair — `rust "async` tokenises as `rust` and `"async`. Escaping it
      // would produce a literal search for a quote character, which matches
      // nothing; the user plainly meant the word.
      term = term.replace(/"/g, "");
    }

    term = term.trim();
    if (!term || !isSearchable(term)) continue;

    if (prefix) hasWildcard = true;
    terms.push(term);
    // Doubling internal quotes is FTS5's own escape, and quoting the whole
    // token means its contents are never parsed as operators.
    parts.push(`"${term.replace(/"/g, '""')}"${prefix ? "*" : ""}`);
  }

  return {
    match: parts.length ? parts.join(" ") : null,
    terms,
    hasWildcard,
  };
}
