import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM ?? "rightread <onboarding@resend.dev>";

/**
 * Sends the magic-link sign-in email. With no AUTH_RESEND_KEY configured we log
 * the link to the server console instead, so local dev works with no account.
 */
export async function sendMagicLinkEmail(email: string, url: string) {
  if (!process.env.AUTH_RESEND_KEY) {
    console.log(`\n[rightread] Sign-in link for ${email}:\n${url}\n`);
    return;
  }

  const resend = new Resend(process.env.AUTH_RESEND_KEY);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Sign in to rightread",
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:20px;margin:0 0 8px">Sign in to rightread</h1>
        <p style="color:#666;font-size:14px;margin:0 0 24px">This link expires in 10 minutes.</p>
        <a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">Open rightread</a>
        <p style="color:#999;font-size:12px;margin:24px 0 0">If you didn't request this, you can ignore this email.</p>
      </div>`,
  });

  if (error) {
    // Surfaced so Auth.js shows the sign-in as failed rather than silently
    // pretending a mail went out.
    console.error(`[rightread] Resend rejected the send:`, error);
    throw new Error(`Resend failed: ${error.message}`);
  }

  // Resend accepting it is not the same as it landing — the id lets you follow
  // the delivery in the Resend dashboard if it doesn't show up.
  console.log(`[rightread] Sign-in email queued for ${email} (id: ${data?.id})`);
}

/**
 * The app's own address, for links in mail.
 *
 * `AUTH_URL` is already pinned in production for exactly this reason — so the
 * app stops deriving its host from client-supplied headers — which makes it the
 * one value here that is guaranteed to be the canonical origin.
 */
function appUrl(): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  return (configured ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Tells someone they have been added to a group, or invited to one.
 *
 * **Never throws.** This is the opposite contract to the magic-link mail above,
 * and deliberately so: that one must fail loudly, because a sign-in that
 * silently sends nothing leaves someone unable to get in. An invite has already
 * been recorded in the database by the time this runs — the person is in the
 * group, or their invitation is waiting — so a bounced notification is a
 * missing convenience, not a broken action, and it must not fail the invite.
 *
 * `hasAccount` decides where they are sent. Somebody who already has an account
 * goes straight to the shelf; somebody who does not has to sign in first, and
 * telling them to go to a group page they cannot open yet would be useless.
 */
export async function sendGroupInviteEmail(
  email: string,
  opts: { groupName: string; invitedBy: string; groupId: string; hasAccount: boolean }
): Promise<void> {
  const { groupName, invitedBy, groupId, hasAccount } = opts;
  const link = hasAccount ? `${appUrl()}/groups/${groupId}` : `${appUrl()}/login`;
  const heading = hasAccount
    ? `${invitedBy} added you to “${groupName}”`
    : `${invitedBy} invited you to “${groupName}”`;
  const lead = hasAccount
    ? "It's a shared shelf on rightread. Links people put on it are yours to save or ignore — nothing lands in your queue unless you choose it."
    : "It's a shared shelf on rightread. Sign in with this address and the group will be waiting for you.";

  try {
    if (!process.env.AUTH_RESEND_KEY) {
      console.log(`\n[rightread] Group invite for ${email}: ${heading}\n${link}\n`);
      return;
    }

    const resend = new Resend(process.env.AUTH_RESEND_KEY);
    const { data, error } = await resend.emails.send({
      from: FROM,
      to: email,
      subject: heading,
      html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(heading)}</h1>
        <p style="color:#666;font-size:14px;margin:0 0 24px">${lead}</p>
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${
          hasAccount ? "Open the group" : "Sign in to rightread"
        }</a>
        <p style="color:#999;font-size:12px;margin:24px 0 0">If this means nothing to you, you can ignore this email.</p>
      </div>`,
    });

    if (error) {
      console.error(`[rightread] Resend rejected the group invite to ${email}:`, error);
      return;
    }
    console.log(`[rightread] Group invite queued for ${email} (id: ${data?.id})`);
  } catch (err) {
    console.error(
      `[rightread] Could not send the group invite to ${email}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/** A group name is user-supplied and goes into the mail body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
