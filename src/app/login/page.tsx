import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";
import { isEmailAllowed } from "@/lib/allowlist";
import { Wordmark } from "@/components/Wordmark";

/**
 * Auth.js error codes we can say something useful about. Anything else gets the
 * generic line — the codes are client-safe, but they are not English.
 */
function messageFor(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case "AccessDenied":
      return "That address isn't on the allow list for this rightread.";
    case "Verification":
      return "That sign-in link has expired or was already used. Request a new one.";
    // Auth.js collapses every non-client-safe failure into this one code, so
    // the copy cannot be specific. In practice the overwhelmingly likely cause
    // is the sending of the mail itself failing — which looks identical to a
    // rejected address from the outside, so the message has to say plainly
    // that the address is not the problem.
    case "Configuration":
      return "We couldn't send the sign-in email — most likely a problem with the mail service, not with your address. The server logs have the detail.";
    default:
      return "Something went wrong signing in. Try again.";
  }
}

export default async function LoginPage(props: PageProps<"/login">) {
  const session = await auth();
  if (session?.user) redirect("/");

  const searchParams = await props.searchParams;
  const raw = searchParams.error;
  const error = messageFor(Array.isArray(raw) ? raw[0] : raw);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1>
        <Wordmark size={32} />
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        Capture links from anywhere. Read them clean, later, offline.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-lg border px-3 py-2.5 text-[13px]"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          {error}
        </p>
      )}

      <form
        className="mt-8"
        action={async (formData: FormData) => {
          "use server";
          const email = String(formData.get("email") ?? "");

          // Asked here as well as in the signIn callback purely for the
          // message: the callback's refusal is an exception, not a rendered
          // page, so checking first is what turns "something went wrong" into
          // "that address isn't on the list".
          if (!isEmailAllowed(email)) redirect("/login?error=AccessDenied");

          try {
            await signIn("email", { email, redirectTo: "/" });
          } catch (e) {
            // signIn() runs Auth.js in raw mode, where AccessDenied is thrown
            // at us instead of becoming a redirect. Only AuthError is handled —
            // redirect() itself works by throwing, so everything else must fly.
            if (e instanceof AuthError) redirect(`/login?error=${e.type}`);
            throw e;
          }
        }}
      >
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          className="mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-medium"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Send sign-in link
        </button>
      </form>

      <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
        We&apos;ll email you a link that signs you in. No password.
      </p>
    </main>
  );
}
