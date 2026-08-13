import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { sendMagicLinkEmail } from "@/lib/email";
import { isEmailAllowed } from "@/lib/allowlist";

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "database",
    // Long session: this is a phone-first app, re-auth on mobile is friction.
    maxAge: 365 * 24 * 60 * 60,
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/login/check-email",
    // Sends a refused or expired magic-link click back to the login page with
    // ?error=..., rather than to Auth.js's own unstyled error page.
    error: "/login",
  },
  providers: [
    {
      id: "email",
      name: "Email",
      type: "email",
      maxAge: 10 * 60,
      sendVerificationRequest: async ({ identifier: email, url }) => {
        await sendMagicLinkEmail(email, url);
      },
    },
  ],
  callbacks: {
    /**
     * The access gate. Auth.js runs this twice for a magic link — once before
     * sending the mail, once when the link is clicked — so an address removed
     * from the allow list mid-flight cannot redeem a link it was already sent,
     * and a stranger never receives one in the first place.
     *
     * Returning false raises AccessDenied. Reached through the server action in
     * the login page that is thrown rather than redirected (Auth.js runs raw
     * there), which is why that page catches it.
     */
    async signIn({ user, email }) {
      // Which half of the flow we are in. Worth logging: "refused" against a
      // link request and "refused" against a link click mean different things
      // — the second says someone's access was revoked while a live link sat
      // in their inbox, which is the case you actually want to see.
      const phase = email?.verificationRequest ? "link-request" : "link-click";
      const address = JSON.stringify(user?.email ?? null);

      if (isEmailAllowed(user?.email)) {
        console.log(`[auth] ${phase}: allowed ${address}`);
        return true;
      }

      console.warn(`[auth] ${phase}: REFUSED ${address} — not on the allow list`);
      return false;
    },
    async session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
});
