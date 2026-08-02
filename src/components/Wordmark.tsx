/**
 * The rightread wordmark.
 *
 * Two devices, neither of which costs any layout space:
 *
 *  - It's set in the *serif* — the same face the reader uses. Everything else
 *    in the chrome is sans, so the wordmark reads as editorial rather than as
 *    another label in the toolbar.
 *  - "read" takes the clay accent, splitting the compound word so the name is
 *    legible as right|read rather than one lowercase run.
 *
 * `leading-none` keeps it shorter than the 25px header buttons beside it, so
 * raising the size doesn't make the header taller.
 */
export function Wordmark({
  size = 19,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-block leading-none tracking-[-0.02em] ${className}`}
      style={{
        fontFamily: "var(--font-serif)",
        fontSize: size,
        fontWeight: 600,
      }}
    >
      <span style={{ color: "var(--text)" }}>right</span>
      <span style={{ color: "var(--accent)" }}>read</span>
    </span>
  );
}
