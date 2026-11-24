export function EmptyState({
  title = "Nothing here yet",
  description = "Add your first record to get started.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <section className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
        {description}
      </p>
    </section>
  );
}
