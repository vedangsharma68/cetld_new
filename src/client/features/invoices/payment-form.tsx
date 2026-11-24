"use client";
import { useState } from "react";
import { useRecordPayment } from "@/client/queries/payments.queries";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
import { recordPaymentSchema } from "@/shared/schemas/payments.schema";
import { toUserMessage } from "@/client/lib/errors";
export function PaymentForm({
  id,
  invoiceNumber,
}: {
  id: string;
  invoiceNumber: string;
}) {
  const [open, setOpen] = useState(false),
    [amount, setAmount] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [error, setError] = useState("");
  const mutation = useRecordPayment();
  return (
    <div className="mt-3">
      <button className="underline" onClick={() => setOpen((v) => !v)}>
        Record payment
      </button>
      {open && (
        <form
          className="mt-3 grid gap-3 rounded border bg-white p-3"
          aria-label={`Payment for ${invoiceNumber}`}
          onSubmit={async (e) => {
            e.preventDefault();
            const parsed = recordPaymentSchema.safeParse({
              amount,
              settleRemaining: false,
              reference: null,
              idempotencyKey: key,
            });
            if (!parsed.success) {
              setError("Enter a positive amount with at most two decimals");
              return;
            }
            try {
              await mutation.mutateAsync({ id, input: parsed.data });
              setAmount("");
              setKey(crypto.randomUUID());
              setOpen(false);
              setError("");
            } catch (err) {
              setError(toUserMessage(err));
            }
          }}
        >
          <FormField
            label={`Payment amount for ${invoiceNumber}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={error}
          />
          <SubmitButton pending={mutation.isPending}>Save payment</SubmitButton>
        </form>
      )}
    </div>
  );
}
