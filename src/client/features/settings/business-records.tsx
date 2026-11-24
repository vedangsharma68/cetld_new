"use client";
import { useState } from "react";
import { useBusinessRecords } from "@/client/queries/business-records.queries";
import { QueryBoundary } from "@/client/components/common/query-boundary";
export function BusinessRecords({ workspaceId }: { workspaceId: string }) {
  const [includeDeleted, setIncludeDeleted] = useState(false),
    query = useBusinessRecords(workspaceId, includeDeleted);
  return (
    <section
      className="space-y-4 rounded border bg-white p-5"
      aria-label="Business records"
    >
      <h2 className="text-lg font-semibold">Business records</h2>
      <p className="text-sm text-slate-600">
        Owner-only view. Existing records and deleted history are read-only.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includeDeleted}
          onChange={(e) => setIncludeDeleted(e.target.checked)}
        />
        Include deleted history
      </label>
      <QueryBoundary query={query}>
        {(view) =>
          view.pages.some((p) => p.records.length) ? (
            <>
              <ul className="space-y-4">
                {view.pages
                  .flatMap((p) => p.records)
                  .map((record) => (
                    <li
                      key={record.id}
                      className="space-y-2 rounded border p-3"
                    >
                      <div className="break-words font-medium">
                        {record.name}
                      </div>
                      <p className="break-words text-sm text-slate-600">
                        {record.recordType}
                        {record.deletedAt ? " · Deleted" : ""}
                      </p>
                      {Object.keys(record.customFields).length > 0 && (
                        <dl className="space-y-2">
                          {Object.entries(record.customFields).map(
                            ([key, value]) => (
                              <div key={key}>
                                <dt className="break-words text-sm text-slate-600">
                                  {key}
                                </dt>
                                <dd className="whitespace-pre-wrap break-words">
                                  {value === null
                                    ? "Not set"
                                    : typeof value === "object"
                                      ? JSON.stringify(value)
                                      : String(value)}
                                </dd>
                              </div>
                            ),
                          )}
                        </dl>
                      )}
                    </li>
                  ))}
              </ul>
              {query.hasNextPage && (
                <button
                  className="rounded border px-4 py-2"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage
                    ? "Loading records..."
                    : "Load more records"}
                </button>
              )}
              {query.isFetchNextPageError && (
                <p role="alert">Could not load more records. Try again.</p>
              )}
              <p className="text-sm text-slate-600">
                Showing{query.hasNextPage ? " part of" : " all matching"}{" "}
                records. Ordered by record ID.
              </p>
            </>
          ) : (
            <p>No {includeDeleted ? "saved" : "active"} business records.</p>
          )
        }
      </QueryBoundary>
    </section>
  );
}
