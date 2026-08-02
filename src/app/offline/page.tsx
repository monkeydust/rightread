import Link from "next/link";

export const metadata = { title: "Offline — rightread" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 text-center">
      <h1 className="text-lg font-semibold">You&apos;re offline</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        Articles you&apos;ve already opened are still readable. Anything new will
        load when you&apos;re back online.
      </p>
      <Link
        href="/"
        className="mt-8 rounded-lg px-4 py-2.5 text-sm font-medium"
        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
      >
        Back to queue
      </Link>
    </main>
  );
}
