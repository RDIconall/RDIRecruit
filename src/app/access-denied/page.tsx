import Link from "next/link";

export default function AccessDeniedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="max-w-md rounded-lg border border-navy/10 bg-white p-8 shadow-lg">
        <h1 className="text-xl font-semibold text-navy">Access not granted</h1>
        <p className="mt-3 text-sm leading-relaxed text-navy/70">
          Your account is signed in, but it is not on the RDIRecruit allowlist yet. Ask an admin to
          add your email, then sign out and back in.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/sign-in"
            className="rounded-md bg-orange px-4 py-2 text-sm font-medium text-white hover:bg-orange-muted"
          >
            Switch account
          </Link>
        </div>
      </div>
    </div>
  );
}
