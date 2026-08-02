import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Wordmark } from "@/components/Wordmark";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1>
        <Wordmark size={32} />
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        Capture links from anywhere. Read them clean, later, offline.
      </p>

      <form
        className="mt-8"
        action={async (formData: FormData) => {
          "use server";
          await signIn("email", {
            email: String(formData.get("email") ?? ""),
            redirectTo: "/",
          });
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
