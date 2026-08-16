/**
 * Inline SVG icons.
 *
 * These replace the emoji the row used to use (📌 / 📍 / ✓ / ↩ / ×). Emoji are
 * drawn by the OS font — Noto on Android, Segoe UI Emoji on Windows — so they
 * differed per device, carried their own colours regardless of the palette,
 * and 📌 vs 📍 were indistinguishable at 15px, which is precisely the state the
 * control needed to convey.
 *
 * All of these inherit `currentColor` and sit on a 24-unit grid at 1.6 stroke,
 * so they align optically with each other at any size.
 */

type IconProps = {
  size?: number;
  className?: string;
  /** Star only: draws it solid to show the active state. */
  filled?: boolean;
};

function Svg({
  size = 18,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Svg>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Svg>
  );
}

/** Move to top — an arrow meeting a ceiling, so it reads as "to the end". */
export function ArrowToTop(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h14" />
      <path d="M12 20V8" />
      <path d="m6 14 6-6 6 6" />
    </Svg>
  );
}

export function Star({ filled, ...props }: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.78l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Svg>
  );
}

/** Send back to the queue from the archive. */
export function Undo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h12a5 5 0 0 1 0 10H9" />
      <path d="m7 4-4 4 4 4" />
    </Svg>
  );
}

export function Trash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

/**
 * Share with a group.
 *
 * Two figures rather than the usual share glyph (a node-and-branches or an
 * arrow leaving a box): both of those read as "send this elsewhere", and the
 * action here is narrower — it puts the article on a shelf a few named people
 * share. Nothing leaves the app.
 */
export function People(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16.5 5.5a3 3 0 0 1 0 5.8" />
      <path d="M18 14.2a6 6 0 0 1 3 5.8" />
    </Svg>
  );
}

export function ExternalLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}
