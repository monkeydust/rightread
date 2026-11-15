/**
 * The notification framework, minus the database: who gets a notification,
 * what it says, and how a batch is delivered and counted.
 *
 * Everything here takes its storage and its sender as arguments, so the rules
 * are tested without a database or a network. `./index.ts` supplies the real
 * ones.
 */

import { wantsType } from "./types";
import { MAX_PLAINTEXT_BYTES, type PushOutcome, type PushTarget } from "./webpush";

/** What a notification shows and where a tap goes. Channel-neutral. */
export type Message = {
  title: string;
  body: string;
  /** An in-app path. A tap must stay inside the PWA, so never a full URL. */
  path: string;
  /** A later message with the same tag replaces the earlier one on the device. */
  tag: string;
};

export type DeliveryCount = { sent: number; failed: number; pruned: number };

/**
 * A way of reaching a user. Push is the only one; email would be a second
 * object of this shape and nothing else would change.
 */
export type Channel = {
  id: string;
  /** False when the channel has no keys. An unavailable channel is never called. */
  available(): boolean;
  /** Delivers to every device (or address) the user has on this channel. Never throws. */
  deliver(userId: string, typeId: string, message: Message): Promise<DeliveryCount>;
};

// ── Text ─────────────────────────────────────────────────────────

/** Collapses whitespace and cuts to a length a lock screen can show. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Only ever an in-app path: one leading slash, no scheme, no `//host`. */
export function safePath(path: string): string {
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(path) ? path : "/";
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * What to call a sharer who has no display name: the part of their address
 * before the `@`. A notification shows on a lock screen, so the full address
 * never goes into one. Empty when there is nothing usable.
 */
export function addressName(email: string | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return (at === -1 ? email : email.slice(0, at)).trim();
}

/**
 * What a group share says.
 *
 * Carries only what every member can already see on the shelf card: the
 * group's name, who shared, the title and the site. Never the note (it can be
 * long and personal), never anything from a library. A sharer with no name is
 * shown by the first part of their address, never the whole of it.
 */
export function groupShareMessage(input: {
  groupId: string;
  groupName: string;
  shareId: string;
  sharerName: string | null;
  sharerEmail: string | null;
  title: string;
  url: string;
}): Message {
  const who = clip(input.sharerName?.trim() || addressName(input.sharerEmail) || "Someone", 60);
  const site = host(input.url);
  const title = clip(input.title || site || "a link", 120);
  return {
    title: clip(input.groupName || "rightread", 60),
    body: site && site !== title ? `${who} shared: ${title} (${site})` : `${who} shared: ${title}`,
    path: safePath(`/groups/${input.groupId}`),
    tag: `share-${input.shareId}`,
  };
}

/** The test notification from Settings. */
export function testMessage(): Message {
  return {
    title: "rightread",
    body: "Notifications are working on this device.",
    path: "/settings",
    tag: "test",
  };
}

/**
 * The JSON the service worker receives. `v` lets the worker ignore a shape it
 * does not know rather than show something broken.
 */
export function pushPayload(type: string, message: Message): string {
  const build = (body: string) =>
    JSON.stringify({
      v: 1,
      type,
      title: clip(message.title, 80),
      body,
      path: safePath(message.path),
      tag: clip(message.tag, 64),
    });
  let payload = build(clip(message.body, 300));
  // Non-Latin text can be three bytes a character. Never over the record size.
  if (Buffer.byteLength(payload, "utf8") > MAX_PLAINTEXT_BYTES) payload = build("");
  return payload;
}

/**
 * A short name for a device, from its user agent: "Chrome on Android". The
 * full user agent is never stored; this is only so a list of devices could be
 * shown one day.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const system = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return system ? `${browser} on ${system}` : browser;
}

// ── Recipients ───────────────────────────────────────────────────

/**
 * Who hears about something that happened in a group: its current members,
 * except the person who did it.
 */
export function othersInGroup(memberIds: readonly string[], actorId: string): string[] {
  return [...new Set(memberIds)].filter((id) => id !== actorId);
}

/** Drops anyone who has switched this type off. */
export function recipientsWanting(
  typeId: string,
  userIds: readonly string[],
  stored: ReadonlyArray<{ userId: string; enabled: boolean }>
): string[] {
  const choice = new Map(stored.map((row) => [row.userId, row.enabled]));
  return [...new Set(userIds)].filter((id) => wantsType(typeId, choice.get(id)));
}

// ── Delivery ─────────────────────────────────────────────────────

export type DispatchDeps = {
  channels: readonly Channel[];
  /** Stored choices for this type, for these users. Missing rows mean "default". */
  preferences(typeId: string, userIds: string[]): Promise<Array<{ userId: string; enabled: boolean }>>;
  log(line: string): void;
};

export type DispatchResult = DeliveryCount & { recipients: number };

/**
 * Sends one notification to a set of users and logs one line about it.
 *
 * Never throws: whatever goes wrong is counted or logged, because the thing
 * that triggered it (a share) has already happened and must stay happened.
 * The log line carries counts only — no title, no address, no endpoint.
 */
export async function dispatch(
  deps: DispatchDeps,
  typeId: string,
  userIds: readonly string[],
  message: Message
): Promise<DispatchResult> {
  const total: DispatchResult = { recipients: 0, sent: 0, failed: 0, pruned: 0 };
  try {
    const channels = deps.channels.filter((c) => c.available());
    if (channels.length === 0 || userIds.length === 0) return total;

    const unique = [...new Set(userIds)];
    const recipients = recipientsWanting(typeId, unique, await deps.preferences(typeId, unique));
    total.recipients = recipients.length;

    for (const channel of channels) {
      const counts = await Promise.all(
        recipients.map((userId) =>
          channel.deliver(userId, typeId, message).catch(() => ({ sent: 0, failed: 1, pruned: 0 }))
        )
      );
      for (const c of counts) {
        total.sent += c.sent;
        total.failed += c.failed;
        total.pruned += c.pruned;
      }
    }

    deps.log(
      `[notify] type=${typeId} recipients=${total.recipients} sent=${total.sent} ` +
        `failed=${total.failed} pruned=${total.pruned}`
    );
  } catch (err) {
    deps.log(`[notify] type=${typeId} error=${err instanceof Error ? err.name : "unknown"}`);
  }
  return total;
}

// ── The push channel ─────────────────────────────────────────────

export type PushStore = {
  /** Every device the user has switched on. */
  targets(userId: string): Promise<Array<PushTarget & { id: string }>>;
  /** The push service said these no longer exist. */
  remove(ids: string[]): Promise<void>;
  /** The push service accepted a message for these. */
  touch(ids: string[]): Promise<void>;
};

/**
 * Push as a channel. `send` is the one place a request leaves the server; a
 * device whose subscription is gone (404/410) is deleted on the spot.
 */
export function pushChannel(deps: {
  available(): boolean;
  store: PushStore;
  send(target: PushTarget, payload: string): Promise<PushOutcome>;
}): Channel {
  return {
    id: "push",
    available: deps.available,
    async deliver(userId, typeId, message) {
      const count: DeliveryCount = { sent: 0, failed: 0, pruned: 0 };
      const targets = await deps.store.targets(userId);
      if (targets.length === 0) return count;

      const payload = pushPayload(typeId, message);
      const outcomes = await Promise.all(
        targets.map((t) => deps.send(t, payload).catch((): PushOutcome => "failed"))
      );

      const gone: string[] = [];
      const ok: string[] = [];
      outcomes.forEach((outcome, i) => {
        if (outcome === "sent") {
          count.sent++;
          ok.push(targets[i].id);
        } else if (outcome === "gone") {
          count.pruned++;
          gone.push(targets[i].id);
        } else {
          count.failed++;
        }
      });

      // Bookkeeping must not turn a delivered message into a failure.
      if (gone.length) await deps.store.remove(gone).catch(() => {});
      if (ok.length) await deps.store.touch(ok).catch(() => {});
      return count;
    },
  };
}
