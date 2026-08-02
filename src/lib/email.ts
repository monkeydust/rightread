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
