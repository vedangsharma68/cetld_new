import Link from "next/link";
export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="mb-8 font-semibold tracking-tight">cetld</p>
      <h1 className="text-5xl font-semibold leading-tight">
        Keep your business
        <br />
        moving forward.
      </h1>
      <p className="my-6 max-w-lg text-lg text-slate-600">
        Customers, invoices and the work between them. A simpler place to stay
        on top of it.
      </p>
      <Link
        className="inline-block rounded-lg bg-slate-900 px-5 py-3 text-white"
        href="/login"
      >
        Sign in
      </Link>
      <p className="mt-8 text-sm text-slate-500">
        Migration preview. WhatsApp delivery remains paused.
      </p>
    </main>
  );
}
