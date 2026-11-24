import { Button } from "../ui/button";
export function ErrorState({
  onRetry,
  message = "We could not load this. Try again.",
}: {
  onRetry?: () => void;
  message?: string;
}) {
  return (
    <section
      role="alert"
      className="rounded-xl border border-red-100 bg-white p-8"
    >
      <h2 className="font-semibold">Something went wrong</h2>
      <p className="my-3 text-sm text-slate-600">{message}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="outline">
          Try again
        </Button>
      )}
    </section>
  );
}
