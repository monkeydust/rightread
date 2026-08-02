"use client";

import Link from "next/link";
import { useState } from "react";
import type { ListItem } from "@/lib/items";
import { hostLabel } from "@/lib/url";
import { ArrowUp, ArrowDown, Star, Check, Undo, Trash } from "@/components/icons";

type Props = {
  item: ListItem;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onMove: (id: string, move: "up" | "down" | "top" | "bottom") => void;
  onStar: (id: string, starred: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
};

function savedLabel(savedAt: Date): string {
  const saved = new Date(savedAt);
  const mins = Math.round((Date.now() - saved.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return saved.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: saved.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid h-9 w-9 place-items-center rounded-md transition-colors
        disabled:opacity-25 disabled:cursor-default
        ${danger ? "hover:bg-red-500/10 hover:text-red-600" : "hover:bg-[var(--bg-subtle)]"}`}
      style={{ color: active ? "var(--accent)" : "var(--text-muted)" }}
    >
      {children}
    </button>
  );
}

export function ItemRow({
  item,
  isFirst,
  isLast,
  busy,
  onMove,
  onStar,
  onArchive,
  onDelete,
  onRetry,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const minutes = Math.max(1, Math.round((item.wordCount ?? 0) / 200));
  const extracting = item.extractStatus === "pending";
  const failed = item.extractStatus === "failed";
  const archived = item.status === "archived";

  return (
    <li
      className="group relative flex gap-2 border-b px-2 py-3 sm:gap-3 sm:px-4"
      style={{
        borderColor: "var(--border)",
        opacity: busy ? 0.55 : 1,
        transition: "opacity 120ms",
      }}
    >
      {/* Ordering. Always visible rather than hover-revealed, since hover
          doesn't exist on the phone this is mostly used from. */}
      {!archived && (
        <div className="-my-1 flex shrink-0 flex-col justify-center">
          <IconButton
            label="Move up"
            onClick={() => onMove(item.id, "up")}
            disabled={isFirst || busy}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            label="Move down"
            onClick={() => onMove(item.id, "down")}
            disabled={isLast || busy}
          >
            <ArrowDown />
          </IconButton>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <Link
          href={`/read/${item.id}`}
          className="block text-[15px] font-medium leading-snug hover:underline"
          style={{ color: "var(--text)" }}
        >
          {item.title}
        </Link>

        {item.excerpt && (
          <p
            className="mt-1 line-clamp-2 text-[13px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {item.excerpt}
          </p>
        )}

        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
          style={{ color: "var(--text-muted)" }}
        >
          {/* The source doubles as the escape hatch to the real page. */}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open the original on ${hostLabel(item.url)}`}
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {item.siteName || hostLabel(item.url)} ↗
          </a>
          <span aria-hidden>·</span>
          <time dateTime={new Date(item.savedAt).toISOString()}>
            {savedLabel(item.savedAt)}
          </time>

          {extracting && (
            <>
              <span aria-hidden>·</span>
              <span className="animate-pulse">extracting…</span>
            </>
          )}

          {!extracting && !failed && item.wordCount ? (
            <>
              <span aria-hidden>·</span>
              <span>{minutes} min</span>
            </>
          ) : null}

          {item.progress > 0.02 && item.progress < 0.98 && (
            <>
              <span aria-hidden>·</span>
              <span>{Math.round(item.progress * 100)}% read</span>
            </>
          )}

          {failed && (
            <>
              <span aria-hidden>·</span>
              <span className="text-red-600" title={item.extractError ?? undefined}>
                couldn&apos;t extract
              </span>
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                className="underline hover:no-underline"
              >
                retry
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={item.starred ? "Remove star" : "Star"}
          onClick={() => onStar(item.id, !item.starred)}
          disabled={busy}
          active={item.starred}
        >
          <Star filled={item.starred} />
        </IconButton>
        <IconButton
          label={archived ? "Move back to queue" : "Mark as done"}
          onClick={() => onArchive(item.id, !archived)}
          disabled={busy}
        >
          {archived ? <Undo /> : <Check />}
        </IconButton>
        {confirmDelete ? (
          <button
            type="button"
            onClick={() => onDelete(item.id)}
            onBlur={() => setConfirmDelete(false)}
            autoFocus
            className="h-9 rounded-md px-2 text-[12px] font-medium text-red-600 hover:bg-red-500/10"
          >
            Delete?
          </button>
        ) : (
          <IconButton
            label="Delete"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            danger
          >
            <Trash />
          </IconButton>
        )}
      </div>
    </li>
  );
}
