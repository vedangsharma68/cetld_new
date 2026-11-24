import Link from "next/link";
export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg p-12">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="my-4">
        This page is unavailable or you do not have access.
      </p>
      <Link href="/">Back to Cetld</Link>
    </main>
  );
}
