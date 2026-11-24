export function LoadingSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      <span className="sr-only">Loading</span>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-200" />
      ))}
    </div>
  );
}
