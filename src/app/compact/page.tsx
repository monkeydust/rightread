import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { previewCompaction, COMPACT_AGE_DAYS } from "@/lib/compact";
import { hostLabel } from "@/lib/url";
import { CompactConfirm } from "@/components/CompactConfirm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compact — rightread" };

/**
 * The preview. Compact moves a lot at once, so it is never one tap: this page
 * says exactly what will move, and the button below it does it.
 */
export default async function CompactPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { cutoff, items, starredKept } = await previewCompaction(session.user.id);
  const muted = { color: "var(--text-muted)" };
  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-6">
      <Link href="/" className="text-[13px] hover:underline" style={muted}>
        ← Queue
      </Link>

      <h1 className="mt-4 text-xl font-semibold tracking-tight">Compact</h1>
      <p className="mt-1 text-[13px]" style={muted}>
        Moves everything unread from more than {COMPACT_AGE_DAYS} days ago into the
        archive, and leaves one digest at the top of your queue: what they were
        about, with a link to each one. Nothing is deleted. Starred items stay
        where they are.
      </p>

      {items.length === 0 ? (
        <p className="mt-8 text-sm">
          Nothing to compact. Everything unread was saved after {day(cutoff)}
          {starredKept ? `, or is starred (${starredKept})` : ""}.
        </p>
      ) : (
        <>
          <p className="mt-8 text-sm font-medium">
            {items.length} {items.length === 1 ? "item" : "items"} saved before{" "}
            {day(cutoff)} will move to the archive
            {starredKept ? `; ${starredKept} starred will stay` : ""}.
          </p>

          <CompactConfirm count={items.length} />

          <ul className="mt-6 border-t text-[13px]" style={{ borderColor: "var(--border)" }}>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-baseline justify-between gap-3 border-b py-2"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="min-w-0 truncate">
                  {item.digest ? "Earlier digest: " : ""}
                  {item.title}
                </span>
                <span className="shrink-0" style={muted}>
                  {item.siteName || hostLabel(item.url)} · {day(item.savedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
