"use client";
import { ErrorState } from "@/client/components/common/error-state";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="p-8">
      <ErrorState onRetry={reset} />
    </main>
  );
}
