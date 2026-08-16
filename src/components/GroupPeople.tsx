"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Member = { userId: string; email: string; joinedAt: Date; isMe: boolean };
type Invite = { id: string; email: string; createdAt: Date; canSignIn: boolean };

/**
 * Who is in the group, and the controls for changing that.
 *
 * There are no roles, so every control here is available to every member —
 * including removing someone else. That is the deliberate shape of a small
 * group of people who already trust each other.
 */
export function GroupPeople({
  groupId,
  groupName,
  members,
  invites,
}: {
  groupId: string;
  groupName: string;
  members: Member[];
  invites: Invite[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(groupName);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const lastOneHere = members.length <= 1;

  async function call(path: string, init?: RequestInit) {
    const response = await fetch(path, init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error ?? "That didn't work");
    }
    return response.json().catch(() => ({}));
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || inviting) return;

    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await call(`/api/groups/${groupId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setEmail("");
      if (result.status === "already-member") {
        setNotice(`${result.email} is already in this group.`);
      } else if (result.status === "joined") {
        setNotice(`${result.email} has been added.`);
      } else if (!result.canSignIn) {
        setNotice(
          `Invited ${result.email} — but that address can't sign in to this server yet.`
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not invite that address");
    } finally {
      setInviting(false);
    }
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || name === groupName) return;
    setError(null);
    try {
      await call(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the group");
    }
  }

  async function remove(userId: string) {
    setError(null);
    try {
      await call(`/api/groups/${groupId}/members?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove them");
    }
  }

  async function revoke(inviteId: string) {
    setError(null);
    try {
      await call(`/api/groups/${groupId}/invites?inviteId=${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw the invite");
    }
  }

  async function leave() {
    setError(null);
    try {
      await call(`/api/groups/${groupId}`, { method: "DELETE" });
      router.push("/groups");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not leave the group");
    }
  }

  return (
    <div className="mt-12 px-3 pb-16 sm:px-4">
      <section>
        <h2 className="text-sm font-semibold">People</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Everyone here is equal — any member can invite, rename the group, or
          remove anyone.
        </p>

        <form onSubmit={invite} className="mt-3 flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            aria-label="Email to invite"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
          <button
            type="submit"
            disabled={inviting || !email.trim()}
            className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
            style={{ borderColor: "var(--border)" }}
          >
            {inviting ? "…" : "Invite"}
          </button>
        </form>

        {error && (
          <p className="mt-2 text-[13px] text-red-600" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {notice}
          </p>
        )}

        <ul className="mt-3">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex items-center justify-between gap-3 border-b py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="min-w-0 truncate">
                {member.email}
                {member.isMe && (
                  <span className="ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    you
                  </span>
                )}
              </span>
              {!member.isMe && (
                <button
                  onClick={() => remove(member.userId)}
                  className="shrink-0 rounded-md px-2 py-1 text-[13px] text-red-600 hover:bg-red-500/10"
                >
                  Remove
                </button>
              )}
            </li>
          ))}

          {invites.map((pending) => (
            <li
              key={pending.id}
              className="flex items-center justify-between gap-3 border-b py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="min-w-0">
                <span className="block truncate" style={{ color: "var(--text-muted)" }}>
                  {pending.email}
                </span>
                {/* The allow list is the gate on who may hold an account at all.
                    An invite to an address that is not on it is real but
                    dormant, and saying "invited" alone would be a lie. */}
                <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {pending.canSignIn ? (
                    "invited — waiting for them to sign in"
                  ) : (
                    <span className="text-red-600">
                      invited, but this address can&apos;t sign in yet — it needs
                      adding to RIGHTREAD_ALLOWED_EMAILS on the server
                    </span>
                  )}
                </span>
              </span>
              <button
                onClick={() => revoke(pending.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)]"
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">Group name</h2>
        <form onSubmit={rename} className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Group name"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
          <button
            type="submit"
            disabled={!name.trim() || name === groupName}
            className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
            style={{ borderColor: "var(--border)" }}
          >
            Rename
          </button>
        </form>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">Leave</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {lastOneHere
            ? "You're the last member, so leaving deletes this group and everything on its shelf. Anything you already saved stays in your queue."
            : "Anything you already saved stays in your queue. Links you shared stay with the group."}
        </p>
        {/* Inline confirm rather than a dialog, matching how deleting an item
            works in the queue. */}
        {confirmLeave ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={leave}
              className="rounded-lg px-3 py-2 text-sm font-medium text-white"
              style={{ background: "#dc2626" }}
            >
              {lastOneHere ? "Leave and delete" : "Leave group"}
            </button>
            <button
              onClick={() => setConfirmLeave(false)}
              className="rounded-lg border px-3 py-2 text-sm font-medium"
              style={{ borderColor: "var(--border)" }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmLeave(true)}
            className="mt-3 rounded-lg border px-3 py-2 text-sm font-medium text-red-600"
            style={{ borderColor: "var(--border)" }}
          >
            Leave group
          </button>
        )}
      </section>
    </div>
  );
}
