"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  useCustomer,
  useDeleteCustomer,
} from "@/client/queries/customers.queries";
import { useWorkspaces } from "@/client/queries/workspaces.queries";
import { PageHeader } from "@/client/components/common/page-header";
import { QueryBoundary } from "@/client/components/common/query-boundary";
import { ConfirmDialog } from "@/client/components/common/confirm-dialog";
import { Button } from "@/client/components/ui/button";
import { CustomerEditForm } from "./customer-edit-form";
export function CustomerDetail({ id }: { id: string }) {
  const query = useCustomer(id);
  const workspaces = useWorkspaces();
  const deletion = useDeleteCustomer();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <QueryBoundary query={query}>
      {(customer) => {
        const membership = workspaces.data?.find(
          (workspace) => workspace.id === customer.workspaceId,
        );
        const canManage = Boolean(membership);
        return (
          <>
            <PageHeader
              title={customer.name}
              description={customer.companyName ?? "Customer details"}
              action={
                canManage ? (
                  <div className="flex gap-3">
                    <Button
                      variant="outline"
                      onClick={() => setEditing((value) => !value)}
                    >
                      {editing ? "Cancel" : "Edit"}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setConfirm(true)}
                    >
                      Delete customer
                    </Button>
                  </div>
                ) : undefined
              }
            />
            {editing && canManage && (
              <CustomerEditForm
                key={customer.id}
                customer={customer}
                onDone={() => setEditing(false)}
              />
            )}
            <dl className="grid gap-6 rounded-xl border border-slate-200 bg-white p-6 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-slate-500">Email</dt>
                <dd className="mt-1 break-words">
                  {customer.email ?? "Not provided"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Phone</dt>
                <dd className="mt-1">{customer.phone ?? "Not provided"}</dd>
              </div>
            </dl>
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title="Delete this customer?"
              description="This cannot be undone. Customers with related invoices cannot be deleted."
              pending={deletion.isPending}
              onConfirm={() => {
                deletion.mutate(id, {
                  onSuccess: () => router.push("/customers"),
                });
              }}
            />
          </>
        );
      }}
    </QueryBoundary>
  );
}
