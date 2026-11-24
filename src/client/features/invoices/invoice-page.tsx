"use client";
import { useState } from "react";
import { PaymentForm } from "./payment-form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createInvoiceSchema,
  type CreateInvoiceInput,
} from "@/shared/schemas/invoices.schema";
import {
  useInvoices,
  useCreateInvoice,
  useUploadInvoice,
  useDownloadInvoice,
  useRemoveInvoice,
} from "@/client/queries/invoices.queries";
import { useWorkspaces } from "@/client/queries/workspaces.queries";
import { QueryBoundary } from "@/client/components/common/query-boundary";
import { PageHeader } from "@/client/components/common/page-header";
import { FormField } from "@/client/components/common/form-field";
import { toUserMessage } from "@/client/lib/errors";
import { applyServerErrors } from "@/client/lib/form-errors";
export function InvoicePage() {
  const businesses = useWorkspaces();
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Private PDF invoice files. Local migration preview, existing Cetld is unchanged."
      />
      <QueryBoundary query={businesses}>
        {(rows) => <InvoiceBusiness businesses={rows} />}
      </QueryBoundary>
    </>
  );
}
function InvoiceBusiness({
  businesses,
}: {
  businesses: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState("");
  const workspaceId = selected || businesses[0]?.id || "";
  const filters = { workspaceId, page: 1, pageSize: 20 };
  const list = useInvoices(filters);
  const create = useCreateInvoice(),
    upload = useUploadInvoice(),
    download = useDownloadInvoice(),
    remove = useRemoveInvoice();
  const form = useForm<CreateInvoiceInput>({
    resolver: zodResolver(createInvoiceSchema),
    defaultValues: {
      workspaceId,
      invoiceNumber: "",
      amount: "0.00",
      currency: "INR",
    },
  });
  const error = create.error ?? upload.error ?? download.error ?? remove.error;
  return (
    <div className="min-w-0 max-w-full space-y-6">
      <label className="block">
        Business
        <select
          className="ml-3 rounded border p-2"
          value={workspaceId}
          onChange={(e) => {
            setSelected(e.target.value);
            form.setValue("workspaceId", e.target.value);
          }}
        >
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="grid gap-4 rounded-xl border bg-white p-5 md:grid-cols-3"
        onSubmit={form.handleSubmit(async (input) => {
          try {
            await create.mutateAsync(input);
            form.reset({ ...input, invoiceNumber: "", amount: "0.00" });
          } catch (error) {
            applyServerErrors(form, error);
          }
        })}
      >
        <input type="hidden" {...form.register("workspaceId")} />
        <FormField
          label="Invoice number"
          {...form.register("invoiceNumber")}
          error={form.formState.errors.invoiceNumber?.message}
        />
        <FormField
          label="Amount"
          inputMode="decimal"
          {...form.register("amount")}
          error={form.formState.errors.amount?.message}
        />
        <label>
          Currency
          <select
            className="mt-2 w-full rounded border p-3"
            {...form.register("currency")}
          >
            {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button
          disabled={create.isPending || !workspaceId}
          className="rounded bg-slate-900 px-4 py-3 text-white"
        >
          Add invoice
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-700">
          {toUserMessage(error)}
        </p>
      )}
      <QueryBoundary query={list} isEmpty={(data) => data.data.length === 0}>
        {(result) => (
          <div
            className="block w-full min-w-0 max-w-full overflow-x-auto rounded-xl border"
            tabIndex={0}
            role="region"
            aria-label="Invoice table, scroll horizontally"
          >
            <table className="w-full min-w-[650px] text-left">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-4">Invoice</th>
                  <th>Amount</th>
                  <th>PDF</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((row) => (
                  <tr className="border-t" key={row.id}>
                    <td className="p-4">{row.invoiceNumber}</td>
                    <td>
                      {row.currency} {row.amount}
                      <div className="text-sm text-slate-500">
                        Paid {row.amountPaid ?? "0.00"} ·{" "}
                        {row.financialStatus ?? "draft"}
                      </div>
                    </td>
                    <td>
                      {row.status === "uploaded"
                        ? "Uploaded"
                        : "Pending upload"}
                    </td>
                    <td className="space-x-3 p-3">
                      {row.status === "uploaded" ? (
                        <button
                          className="underline"
                          onClick={async () => {
                            try {
                              const signed = await download.mutateAsync(row.id);
                              window.open(
                                signed.url,
                                "_blank",
                                "noopener,noreferrer",
                              );
                            } catch {
                              /* Mutation error rendered above */
                            }
                          }}
                        >
                          Download PDF
                        </button>
                      ) : (
                        <label className="relative cursor-pointer underline">
                          Upload PDF
                          <input
                            aria-label={`PDF for ${row.invoiceNumber}`}
                            className="sr-only"
                            type="file"
                            accept="application/pdf"
                            disabled={upload.isPending}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) upload.mutate({ id: row.id, file });
                            }}
                          />
                        </label>
                      )}
                      <PaymentForm
                        id={row.id}
                        invoiceNumber={row.invoiceNumber}
                      />
                      <button
                        className="text-red-700 underline"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete invoice ${row.invoiceNumber}? This removes its file too.`,
                            )
                          )
                            remove.mutate(row.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
      <p className="text-sm text-slate-500">
        Showing the first 20 invoices. On smaller screens, scroll the table
        sideways.
      </p>
    </div>
  );
}
