import Link from "next/link";
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-6">
          <Link href="/" className="mr-auto text-xl font-semibold">
            cetld
          </Link>
          <Link href="/customers">Customers</Link>
          <Link href="/invoices">Invoices</Link>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-900">
            Migration preview
          </span>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-6 md:p-10">{children}</main>
    </div>
  );
}
