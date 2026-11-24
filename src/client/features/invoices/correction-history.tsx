"use client";
import { useState } from "react";
import { useInvoiceCorrectionHistory } from "@/client/queries/invoice-correction-history.queries";
import { QueryBoundary } from "@/client/components/common/query-boundary";
export function CorrectionHistory({
  workspaceId,
  invoiceId,
}: {
  workspaceId: string;
  invoiceId: string;
}) {
  const [open, setOpen] = useState(false),
    query = useInvoiceCorrectionHistory(workspaceId, invoiceId, open);
  return (
    <div className="max-w-xl">
      <button className="underline" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide correction history" : "Correction history"}
      </button>
      {open && (
        <section
          className="mt-3 space-y-3 rounded border p-3"
          aria-label="Invoice correction history"
        >
          <h3 className="font-medium">Correction history</h3>
          <p className="text-sm text-slate-600">
            Owner-only original records. Viewing history does not replay a
            correction.
          </p>
          <QueryBoundary query={query}>
            {(view) =>
              view.pages.some((p) => p.records.length) ? (
                <>
                  <ol className="space-y-4">
                    {view.pages
                      .flatMap((p) => p.records)
                      .map((record) => (
                        <li key={record.id} className="space-y-2">
                          <p className="break-words text-sm">
                            {record.sourceKind} · {record.createdAt}
                          </p>
                          {[
                            ["Changed values", record.values],
                            ["Before", record.beforeSnapshot],
                            ["After", record.afterSnapshot],
                          ].map(([label, value]) => (
                            <details key={String(label)}>
                              <summary>{String(label)}</summary>
                              <pre className="overflow-x-auto whitespace-pre rounded bg-slate-50 p-2 text-xs">
                                {JSON.stringify(value, null, 2)}
                              </pre>
                            </details>
                          ))}
                        </li>
                      ))}
                  </ol>
                  {query.hasNextPage && (
                    <button
                      className="rounded border p-2"
                      disabled={query.isFetchingNextPage}
                      onClick={() => void query.fetchNextPage()}
                    >
                      Load more history
                    </button>
                  )}
                  {query.isFetchNextPageError && (
                    <p role="alert">Could not load more history. Try again.</p>
                  )}
                </>
              ) : (
                <p>No saved correction history.</p>
              )
            }
          </QueryBoundary>
        </section>
      )}
    </div>
  );
}
