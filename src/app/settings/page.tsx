import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { TokenManager } from "@/components/TokenManager";
import { SourceManager } from "@/components/SourceManager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — rightread" };

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const tokens = await prisma.captureToken.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });

  const sources = (
    await prisma.source.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        feedUrl: true,
        title: true,
        active: true,
        lastFetchedAt: true,
        lastError: true,
        _count: { select: { candidates: true } },
      },
    })
  ).map(({ _count, ...s }) => ({ ...s, candidateCount: _count.candidates }));

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-6">
      <Link
        href="/"
        className="text-[13px] hover:underline"
        style={{ color: "var(--text-muted)" }}
      >
        ← Queue
      </Link>

      <h1 className="mt-4 text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
        Signed in as {session.user.email}
      </p>

      <div className="mt-8">
        <SourceManager sources={sources} />
      </div>

      <div className="mt-10">
        <TokenManager tokens={tokens} />
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">Install on your phone</h2>
        <ol
          className="mt-2 list-decimal space-y-1 pl-5 text-[13px]"
          style={{ color: "var(--text-muted)" }}
        >
          <li>Open this site in Chrome on Android.</li>
          <li>Menu → &quot;Add to Home screen&quot; / &quot;Install app&quot;.</li>
          <li>
            rightread now appears in the share sheet from any app — share a link
            to it and it&apos;s saved.
          </li>
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Browser extension</h2>
        <ol
          className="mt-2 list-decimal space-y-1 pl-5 text-[13px]"
          style={{ color: "var(--text-muted)" }}
        >
          <li>
            Open <code>edge://extensions</code> or <code>chrome://extensions</code>{" "}
            and turn on Developer mode.
          </li>
          <li>
            &quot;Load unpacked&quot; → select the <code>extension/</code> folder
            in the rightread project.
          </li>
          <li>
            Open the extension&apos;s options, paste a capture token from above
            and this site&apos;s address.
          </li>
        </ol>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Then click the toolbar button, press Ctrl+Shift+S, or right-click a
          link → Save to rightread.
        </p>
      </section>
    </div>
  );
}
