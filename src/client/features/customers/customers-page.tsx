"use client";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/client/components/common/page-header";
import { Button } from "@/client/components/ui/button";
import { FormField } from "@/client/components/common/form-field";
import { QueryBoundary } from "@/client/components/common/query-boundary";
import { DataTable } from "@/client/components/common/data-table";
import { EmptyState } from "@/client/components/common/empty-state";
import { useCustomers } from "@/client/queries/customers.queries";
import { useWorkspaces } from "@/client/queries/workspaces.queries";
import type { CustomerFilters } from "@/shared/schemas/customers.schema";
import { CustomerForm } from "./customer-form";
export function CustomersPage() {
  const workspaces = useWorkspaces();
  const [selected, setSelected] = useState("");
  const workspaceId = selected || workspaces.data?.[0]?.id || "";
  const current = workspaces.data?.find(
    (workspace) => workspace.id === workspaceId,
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [direction, setDirection] =
    useState<CustomerFilters["direction"]>("asc");
  const query = useCustomers({
    workspaceId,
    page,
    pageSize: 20,
    search,
    sort: "name",
    direction,
  });
  return (
    <>
      <PageHeader
        title="Customers"
        description="Keep your business relationships in one place."
        action={
          current ? (
            <Button onClick={() => setAdding((value) => !value)}>
              {adding ? "Cancel" : "Add customer"}
            </Button>
          ) : undefined
        }
      />
      <QueryBoundary query={workspaces} isEmpty={(rows) => rows.length === 0}>
        {(rows) => (
          <>
            <label className="mb-6 block text-sm font-medium">
              Business
              <select
                value={workspaceId}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPage(1);
                  setAdding(false);
                }}
                className="ml-3 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                {rows.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            {adding && current && (
              <CustomerForm
                key={workspaceId}
                workspaceId={workspaceId}
                onDone={() => setAdding(false)}
              />
            )}
            <div className="mb-5 max-w-sm">
              <FormField
                label="Search customers"
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <QueryBoundary query={query}>
              {(result) =>
                result.data.length ? (
                  <DataTable
                    rows={result.data}
                    columns={[
                      {
                        key: "name",
                        title: "Name",
                        onSort: () =>
                          setDirection((value) =>
                            value === "asc" ? "desc" : "asc",
                          ),
                        cell: (row) => (
                          <Link
                            className="font-medium underline underline-offset-4"
                            href={`/customers/${row.id}`}
                          >
                            {row.name}
                          </Link>
                        ),
                      },
                      {
                        key: "company",
                        title: "Company",
                        cell: (row) => row.companyName ?? "Not provided",
                      },
                      {
                        key: "email",
                        title: "Email",
                        cell: (row) => row.email ?? "Not provided",
                      },
                    ]}
                    getKey={(row) => row.id}
                    page={page}
                    total={result.meta.total}
                    pageSize={20}
                    onPage={setPage}
                  />
                ) : (
                  <EmptyState
                    title="No customers yet"
                    description="Add your first customer to get started."
                  />
                )
              }
            </QueryBoundary>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
