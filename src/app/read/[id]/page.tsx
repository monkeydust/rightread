import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getItem } from "@/lib/items";
import { hostLabel } from "@/lib/url";
import { readingMinutes } from "@/lib/extract";
import { ReaderControls } from "@/components/ReaderControls";
import { ShareToGroup } from "@/components/ShareToGroup";
import { Suspense } from "react";
import { ArticleEndings } from "@/components/ArticleEndings";
import { ThreadSummary } from "@/components/ThreadSummary";
import { Working } from "@/components/Working";
import { listSummaries } from "@/lib/summarize/store";
import { threadAdapterFor } from "@/lib/threads";

export const dynamic = "force-dynamic";

/**
 * How many comments the stored thread has, for the "24 comments" hint before
 * any summary exists. A thread rendered by an adapter puts exactly one <cite>
 * per comment; a page that came through Readability (saved before the adapter
 * existed) has none, and gets no number rather than a wrong one — which is
 * also why zero reads as unknown here.
 */
function renderedCommentCount(item: { url: string; contentHtml: string | null }): number | null {
  if (!item.contentHtml || !threadAdapterFor(item.url)) return null;
  const n = (item.contentHtml.match(/<cite>/g) ?? []).length;
  return n > 0 ? n : null;
}

export async function generateMetadata(props: PageProps<"/read/[id]">) {
  const session = await auth();
  if (!session?.user?.id) return { title: "rightread" };
  const { id } = await props.params;
  const item = await getItem(session.user.id, id);
  return { title: item ? `${item.title} — rightread` : "rightread" };
}

export default async function ReadPage(props: PageProps<"/read/[id]">) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await props.params;
  const item = await getItem(session.user.id, id);
  if (!item) notFound();

  const failed = item.extractStatus === "failed";
  const pending = item.extractStatus === "pending";

  return (
    <div style={{ background: "var(--paper)", minHeight: "100dvh" }}>
      <header
        className="no-print sticky top-0 z-10 backdrop-blur"
        style={{
          background: "color-mix(in srgb, var(--paper) 85%, transparent)",
        }}
      >
        <div
          className="mx-auto flex items-center justify-between px-4 py-2"
          style={{ maxWidth: "var(--reader-width, 34rem)" }}
        >
          <Link
            href="/"
            className="rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-[var(--bg-subtle)]"
            style={{ color: "var(--text-muted)" }}
          >
            ← Queue
          </Link>
          <div className="flex items-center gap-1">
            {/* Always available, not just when extraction failed — the reader
                strips things (video, interactive charts, comments) that you
                sometimes need the real page for. */}
            <a
              href={item.resolvedUrl ?? item.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the original page"
              className="rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-[var(--bg-subtle)]"
              style={{ color: "var(--text-muted)" }}
            >
              Original ↗
            </a>
            <ShareToGroup url={item.url} title={item.title} />
            <ReaderControls
              itemId={item.id}
              title={item.title}
              initialProgress={item.progress}
              archived={item.status === "archived"}
            />
          </div>
        </div>
      </header>

      <article
        className="mx-auto px-5 pb-32 pt-6"
        style={{ maxWidth: "var(--reader-width, 34rem)" }}
      >
        <h1
          className="text-[1.75rem] font-semibold leading-tight tracking-tight"
          style={{ color: "var(--paper-text)" }}
        >
          {item.title}
        </h1>

        <div
          className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
          style={{ color: "color-mix(in srgb, var(--paper-text) 60%, transparent)" }}
        >
          {item.byline && <span>{item.byline}</span>}
          {item.byline && <span aria-hidden>·</span>}
          <a
            href={item.resolvedUrl ?? item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:no-underline"
          >
            {item.siteName || hostLabel(item.url)}
          </a>
          {item.wordCount ? (
            <>
              <span aria-hidden>·</span>
              <span>{readingMinutes(item.wordCount)} min read</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>
            saved{" "}
            {new Date(item.savedAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            })}
          </span>
        </div>

        <hr
          className="mt-6"
          style={{
            border: 0,
            borderTop:
              "1px solid color-mix(in srgb, var(--paper-text) 12%, transparent)",
          }}
        />

        {item.kind === "conversation" && (
          <ThreadSummary
            itemId={item.id}
            summaries={(await listSummaries(session.user.id, item.id)).map((s) => ({
              ...s,
              createdAt: s.createdAt.toISOString(),
              fetchedAt: s.fetchedAt.toISOString(),
            }))}
            commentCount={renderedCommentCount(item)}
          />
        )}

        {pending && (
          <p
            className="mt-8 flex items-center gap-2 text-sm"
            style={{ color: "color-mix(in srgb, var(--paper-text) 60%, transparent)" }}
          >
            <Working />
            Extracting the article…
          </p>
        )}

        {failed && (
          <div className="mt-8">
            <p className="text-sm" style={{ color: "var(--paper-text)" }}>
              This page couldn&apos;t be turned into a reader view.
            </p>
            <p
              className="mt-1 text-[13px]"
              style={{ color: "color-mix(in srgb, var(--paper-text) 60%, transparent)" }}
            >
              {item.extractError}
            </p>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-medium"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              Open the original
            </a>
          </div>
        )}

        {item.contentHtml && (
          <div
            className="prose-reader mt-8"
            /* A thread rendered from structure (nested blockquotes, one <cite>
               per comment) is styled as a thread, not as quoted prose. */
            data-thread={renderedCommentCount(item) != null ? "" : undefined}
            /* Sanitized in src/lib/sanitize.ts (DOMPurify, strict allowlist)
               before it was ever written to the database. */
            dangerouslySetInnerHTML={{ __html: item.contentHtml }}
          />
        )}

        {/* Behind Suspense so the article streams first — the old panel was
            awaited inline and blocked the text behind the candidate scan. A
            null fallback means the reader simply ends until the panel lands. */}
        <Suspense fallback={null}>
          <ArticleEndings userId={session.user.id} itemId={item.id} />
        </Suspense>
      </article>
    </div>
  );
}
