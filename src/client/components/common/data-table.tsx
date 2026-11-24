import { Button } from "../ui/button";
export type Column<T> = {
  key: string;
  title: string;
  cell: (row: T) => React.ReactNode;
  onSort?: () => void;
};
export function DataTable<T>({
  rows,
  columns,
  getKey,
  page,
  total,
  pageSize,
  onPage,
}: {
  rows: T[];
  columns: Column<T>[];
  getKey: (row: T) => string;
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <p className="px-5 pt-3 text-xs text-slate-500 sm:hidden">
        Swipe sideways to see all customer details.
      </p>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Customer details table, scroll horizontally"
      >
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="whitespace-nowrap px-5 py-4 font-medium"
                >
                  {column.onSort ? (
                    <button onClick={column.onSort}>{column.title} ↕</button>
                  ) : (
                    column.title
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={getKey(row)}
                className="border-b border-slate-100 last:border-0"
              >
                {columns.map((column) => (
                  <td key={column.key} className="min-w-36 px-5 py-4 align-top">
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
        <p className="text-xs text-slate-500">
          {total} total · Page {page} of{" "}
          {Math.max(1, Math.ceil(total / pageSize))}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={page * pageSize >= total}
            onClick={() => onPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
