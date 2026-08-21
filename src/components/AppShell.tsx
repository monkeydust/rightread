import Link from "next/link";
import { signOut } from "@/auth";
import { Wordmark } from "@/components/Wordmark";
import { OfflineDot } from "@/components/OfflineDot";

type Props = {
  active: "queue" | "archive" | "graph" | "discover" | "groups";
  counts: { unread: number; archived: number };
  /**
   * The graph needs room to be legible; the reading views deliberately do not.
   * An opt-in prop rather than a wider default, so nothing else changes.
   */
  wide?: boolean;
  /** Undismissed recommendations. Omitted on pages that have not counted them. */
  discoverCount?: number;
  /** Undismissed shares across my groups. Omitted where it has not been counted. */
  groupCount?: number;
  children: React.ReactNode;
};

/**
 * Shared by the header's link and its sign-out button so the two boxes are
 * identical — `leading-none` in particular, since a link and a button pick up
 * different default line heights and that alone knocks them out of alignment.
 * Matches the reader's "← Queue" / "Original ↗" controls.
 */
const headerAction =
  "rounded-md px-2 py-1.5 text-[13px] leading-none transition-colors " +
  "hover:bg-[var(--bg-subtle)]";

/** Colour stays inline, as elsewhere: `text-[var(--x)]` is ambiguous in
 *  Tailwind and can compile to a font-size rather than a colour. */
const headerActionStyle = { color: "var(--text-muted)" };

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="relative -mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
    >
      {children}
    </Link>
  );
}

export function AppShell({
  active,
  counts,
  wide = false,
  discoverCount,
  groupCount,
  children,
}: Props) {
  return (
    <div className={`mx-auto min-h-dvh ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
      <header
        className="sticky top-0 z-10 border-b px-3 pt-4 backdrop-blur sm:px-4"
        style={{
          borderColor: "var(--border)",
          background: "color-mix(in srgb, var(--bg) 88%, transparent)",
        }}
      >
        <div className="flex items-center justify-between">
          <Link href="/" aria-label="rightread — go to queue">
            <Wordmark />
          </Link>
          {/* Both controls use the identical box (see headerAction) and the
              form is display:flex — as a plain block it would generate a line
              box around the inline-block button, reserving descender space
              below it and pushing "Sign out" off the line "Settings" sits on. */}
          <div className="flex items-center gap-1">
            {/* Renders nothing while online, so this costs no space in the
                common case and never moves the controls beside it. */}
            <OfflineDot />
            <Link
              href="/settings"
              className={headerAction}
              style={headerActionStyle}
            >
              Settings
            </Link>
            {/* Graph sits up here rather than in the tab bar: it is a way of
                looking at the library, not another list to read from, and the
                tabs were getting crowded enough on a phone to start wrapping. */}
            <Link
              href="/graph"
              className={headerAction}
              style={
                active === "graph" ? { color: "var(--accent)" } : headerActionStyle
              }
            >
              Graph
            </Link>
            <form
              className="flex"
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className={headerAction}
                style={headerActionStyle}
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <nav className="mt-3 flex gap-4">
          <Tab href="/" active={active === "queue"}>
            Queue{counts.unread ? ` (${counts.unread})` : ""}
          </Tab>
          <Tab href="/archive" active={active === "archive"}>
            Archive{counts.archived ? ` (${counts.archived})` : ""}
          </Tab>
          <Tab href="/discover" active={active === "discover"}>
            Discover{discoverCount ? ` (${discoverCount})` : ""}
          </Tab>
          <Tab href="/groups" active={active === "groups"}>
            Groups{groupCount ? ` (${groupCount})` : ""}
          </Tab>
        </nav>
      </header>

      <main>{children}</main>
    </div>
  );
}
