export default function CheckEmailPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        We sent you a sign-in link. It expires in 10 minutes.
      </p>
      <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
        Running locally without a Resend key? The link is printed in the server
        console.
      </p>
    </main>
  );
}
