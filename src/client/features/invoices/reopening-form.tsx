"use client";
import { useState } from "react";
import { useReopeningMutation } from "@/client/queries/reopening.queries";
import type { ReopeningResult } from "@/client/api/reopening.api";
import { ApiClientError, toUserMessage } from "@/client/lib/errors";
export function ReopeningForm({
  id,
  invoiceNumber,
  canReopen,
}: {
  id: string;
  invoiceNumber: string;
  canReopen: boolean;
}) {
  const mutation = useReopeningMutation(id),
    [proposal, setProposal] = useState<ReopeningResult | null>(null),
    [prepareKey, setPrepareKey] = useState(() => crypto.randomUUID()),
    [decisionKey, setDecisionKey] = useState(() => crypto.randomUUID()),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const handleError = (e: unknown) => {
    setError(toUserMessage(e));
    if (
      e instanceof ApiClientError &&
      ["ACTION_STALE", "ACTION_EXPIRED"].includes(e.code)
    ) {
      setProposal(null);
      setPrepareKey(crypto.randomUUID());
      setDecisionKey(crypto.randomUUID());
      setError(
        "Invoice changed or the preview expired. Prepare a new reopening preview.",
      );
    }
  };
  return (
    <section className="mt-3" aria-label={`Reopen ${invoiceNumber}`}>
      {!proposal && canReopen ? (
        <button
          className="underline"
          disabled={mutation.isPending}
          onClick={async () => {
            try {
              setError("");
              setDone(false);
              setProposal(
                await mutation.mutateAsync({
                  action: "prepare",
                  key: prepareKey,
                }),
              );
            } catch (e) {
              handleError(e);
            }
          }}
        >
          Reopen invoice
        </button>
      ) : proposal ? (
        <div className="mt-3 space-y-3 rounded border bg-amber-50 p-3">
          <p>Reopen {invoiceNumber}?</p>
          <p>
            Reverse {proposal.reversedAmount} in local invoice allocations.
            Original payment history stays. This does not send a cash refund.
            Reminders stay paused.
          </p>
          <div className="flex flex-wrap gap-4">
            <button
              className="rounded bg-slate-900 px-3 py-2 text-white"
              disabled={mutation.isPending}
              onClick={async () => {
                try {
                  setError("");
                  await mutation.mutateAsync({
                    action: "confirm",
                    key: decisionKey,
                    proposalId: proposal.id,
                    confirmation: "yes",
                  });
                  setProposal(null);
                  setPrepareKey(crypto.randomUUID());
                  setDecisionKey(crypto.randomUUID());
                  setDone(true);
                } catch (e) {
                  handleError(e);
                }
              }}
            >
              Confirm reopening
            </button>
            <button
              className="underline"
              disabled={mutation.isPending}
              onClick={async () => {
                try {
                  setError("");
                  await mutation.mutateAsync({
                    action: "cancel",
                    key: decisionKey,
                    proposalId: proposal.id,
                  });
                  setProposal(null);
                  setPrepareKey(crypto.randomUUID());
                  setDecisionKey(crypto.randomUUID());
                } catch (e) {
                  handleError(e);
                }
              }}
            >
              Cancel reopening
            </button>
          </div>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-2">
          Invoice reopened. No cash refund was sent.
        </p>
      )}
    </section>
  );
}
