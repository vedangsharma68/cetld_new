"use client";
import { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { http } from "@/client/api/http";
import { qk } from "@/client/queries/query-keys";
import { toUserMessage } from "@/client/lib/errors";
import type {
  LifecycleInput,
  LifecycleResult,
} from "@/shared/schemas/invoice-lifecycle.schema";
export function LifecycleForm({
  id,
  invoiceNumber,
  onDeleted,
  initialProposal,
}: {
  id: string;
  invoiceNumber: string;
  onDeleted: (id: string, number: string) => void;
  initialProposal?: LifecycleResult | null;
}) {
  const [proposal, setProposal] = useState<LifecycleResult | null>(
      initialProposal ?? null,
    ),
    [confirmation, setConfirmation] = useState("");
  const [prepareKey, setPrepareKey] = useState(() => crypto.randomUUID());
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: LifecycleInput) =>
      http<LifecycleResult>(`/invoices/${id}/lifecycle`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
  const run = async (input: LifecycleInput) => {
    try {
      const result = await mutation.mutateAsync(input);
      if (result.state === "pending") setProposal(result);
      else {
        setPrepareKey(crypto.randomUUID());
        setProposal(null);
        setConfirmation("");
        if (result.state === "deleted") onDeleted(id, invoiceNumber);
        void qc.invalidateQueries({ queryKey: qk.invoices.all });
        void qc.invalidateQueries({ queryKey: ["invoice-lifecycle"] });
      }
    } catch {
      /* shown below */
    }
  };
  return (
    <div className="mt-3">
      {!proposal ? (
        <button
          className="text-red-700 underline"
          disabled={mutation.isPending}
          onClick={() => void run({ action: "prepare", key: prepareKey })}
        >
          Delete
        </button>
      ) : (
        <form
          className="grid gap-2 rounded border bg-white p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run({
              action: "confirm",
              proposalId: proposal.id,
              key: proposal.id + ":confirm",
              confirmation,
            });
          }}
        >
          <p>
            Delete {invoiceNumber}? The invoice, payment history and PDF are
            kept for restore. Reminders stay off.
          </p>
          <label>
            Type{" "}
            {proposal.hadPayment || proposal.hadSentReminder
              ? `DELETE ${invoiceNumber}`
              : "yes"}
            <input
              className="mt-2 w-full rounded border p-2"
              aria-label={`Confirm deletion of ${invoiceNumber}`}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <button
            disabled={mutation.isPending}
            className="rounded bg-red-700 p-2 text-white"
          >
            Confirm deletion
          </button>
          <button
            type="button"
            className="underline"
            disabled={mutation.isPending}
            onClick={() =>
              void run({
                action: "cancel",
                proposalId: proposal.id,
                key: proposal.id + ":cancel",
              })
            }
          >
            Cancel deletion
          </button>
        </form>
      )}
      {mutation.error && (
        <p role="alert" className="text-red-700">
          {toUserMessage(mutation.error)}
        </p>
      )}
    </div>
  );
}
export function RestoreInvoice({
  id,
  number,
  onRestored,
}: {
  id: string;
  number: string;
  onRestored: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      http<LifecycleResult>(`/invoices/${id}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({ action: "restore", key }),
      }),
    onSuccess: () => {
      onRestored();
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
      void qc.invalidateQueries({ queryKey: ["invoice-lifecycle"] });
    },
  });
  return (
    <div className="rounded border p-3">
      <p>
        {number} deleted. You can restore it for 30 days. Reminders will stay
        paused.
      </p>
      <button
        className="underline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Restore {number}
      </button>
      {mutation.error && <p role="alert">{toUserMessage(mutation.error)}</p>}
    </div>
  );
}

export function useLifecycleState(workspaceId: string) {
  return useQuery({
    queryKey: ["invoice-lifecycle", workspaceId],
    queryFn: () =>
      http<{
        deleted: { id: string; invoiceNumber: string; deletedAt: string }[];
        pending: LifecycleResult | null;
      }>(`/invoice-lifecycle?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
}
