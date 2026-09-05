/**
 * The app's one "something is happening" mark: three short lines that fill
 * in sequence, like text being written. Styles in globals.css (`.working`).
 *
 * Two sizes. The default is inline and follows the text it sits beside —
 * put it inside a button label or a meta row and it takes that text's size
 * and colour. `size="lg"` is for a surface with no label: a panel while it
 * regenerates, a page region while it loads.
 *
 * No client JS: it is CSS animation on three empty elements, so it can sit in
 * a server component as easily as a client one. Marked decorative — the word
 * beside it ("Extracting…", "Saving…") is what a screen reader should get,
 * so callers keep the word.
 */
export function Working({
  size = "sm",
  className = "",
}: {
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span
      className={`working ${size === "lg" ? "lg" : ""} ${className}`.trim()}
      aria-hidden
    >
      <i />
      <i />
      <i />
    </span>
  );
}
