import { z } from "zod";
import {
  exactMoneySchema,
  moneyUnits,
} from "../../src/shared/schemas/exact-money";
const instant = z.string().datetime({ offset: true });
const proposal = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    owner_id: z.uuid(),
    phone: z.string(),
    invoice_id: z.uuid(),
    source_message_id: z.string(),
    invoice_number: z.string(),
    currency: z.string(),
    amount: exactMoneySchema,
    expected_updated_at: instant,
    ledger_fingerprint: z.string(),
    payment_ids: z.array(z.uuid()),
    state: z.enum(["pending", "confirmed", "cancelled", "expired", "stale"]),
    created_at: instant,
    expires_at: instant,
    decision_message_id: z.string().nullable(),
    result: z.unknown().nullable(),
  })
  .strict();
const reversal = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    invoice_id: z.uuid(),
    payment_id: z.uuid(),
    proposal_id: z.uuid(),
    amount: exactMoneySchema,
    actor_id: z.uuid(),
    reason: z.literal("owner_invoice_reopening"),
    recorded_at: instant,
  })
  .strict();
export function planLegacyFinancialHistory(
  snapshot: unknown,
  scope: {
    businesses: Map<string, string>;
    invoices: Map<string, { workspaceId: string }>;
    payments: Map<
      string,
      { workspaceId: string; invoiceId: string; amount: string }
    >;
  },
) {
  const source = z
    .object({
      invoice_reopening_proposals: z.array(proposal),
      payment_reversals: z.array(reversal),
      invoice_number_sequences: z.array(
        z
          .object({
            workspace_id: z.uuid(),
            invoice_year: z.number().int().min(2000).max(9999),
            last_value: z
              .string()
              .regex(/^[1-9][0-9]*$/)
              .refine((v) => BigInt(v) <= 9223372036854775807n),
          })
          .strict(),
      ),
    })
    .parse(snapshot);
  const unique = (rows: string[], label: string) => {
    if (new Set(rows).size !== rows.length) throw Error("Duplicate " + label);
  };
  unique(
    source.invoice_reopening_proposals.map((r) => r.id),
    "proposal",
  );
  unique(
    source.invoice_reopening_proposals.map((r) => r.source_message_id),
    "proposal source",
  );
  unique(
    source.invoice_reopening_proposals.flatMap((r) =>
      r.decision_message_id === null ? [] : [r.decision_message_id],
    ),
    "proposal decision",
  );
  const proposals = source.invoice_reopening_proposals.map((r) => {
    if (
      scope.businesses.get(r.workspace_id) !== r.owner_id ||
      scope.invoices.get(r.invoice_id)?.workspaceId !== r.workspace_id
    )
      throw Error("Orphan proposal scope");
    unique(r.payment_ids, "proposal payment");
    for (const id of r.payment_ids) {
      const p = scope.payments.get(id);
      if (
        !p ||
        p.workspaceId !== r.workspace_id ||
        p.invoiceId !== r.invoice_id
      )
        throw Error("Orphan proposal payment");
    }
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      phone: r.phone,
      invoiceId: r.invoice_id,
      sourceMessageId: r.source_message_id,
      invoiceNumber: r.invoice_number,
      currency: r.currency,
      amount: r.amount,
      expectedUpdatedAt: new Date(r.expected_updated_at),
      ledgerFingerprint: r.ledger_fingerprint,
      paymentIds: r.payment_ids,
      state: r.state,
      createdAt: new Date(r.created_at),
      expiresAt: new Date(r.expires_at),
      decisionMessageId: r.decision_message_id,
      result: r.result,
    };
  });
  const byProposal = new Map(proposals.map((r) => [r.id, r]));
  unique(
    source.payment_reversals.map((r) => r.id),
    "reversal",
  );
  unique(
    source.payment_reversals.map((r) => r.workspace_id + ":" + r.payment_id),
    "reversed payment",
  );
  const reversals = source.payment_reversals.map((r) => {
    const p = scope.payments.get(r.payment_id),
      q = byProposal.get(r.proposal_id);
    if (
      !p ||
      !q ||
      p.workspaceId !== r.workspace_id ||
      p.invoiceId !== r.invoice_id ||
      q.workspaceId !== r.workspace_id ||
      q.invoiceId !== r.invoice_id ||
      !q.paymentIds.includes(r.payment_id) ||
      q.state !== "confirmed" ||
      scope.businesses.get(r.workspace_id) !== r.actor_id ||
      moneyUnits(r.amount) <= 0n ||
      moneyUnits(r.amount) !== moneyUnits(p.amount)
    )
      throw Error("Invalid reversal scope or original allocation");
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      invoiceId: r.invoice_id,
      paymentId: r.payment_id,
      proposalId: r.proposal_id,
      amount: r.amount,
      actorId: r.actor_id,
      reason: r.reason,
      recordedAt: new Date(r.recorded_at),
    };
  });
  unique(
    source.invoice_number_sequences.map(
      (r) => r.workspace_id + ":" + r.invoice_year,
    ),
    "number sequence",
  );
  const sequences = source.invoice_number_sequences.map((r) => {
    if (!scope.businesses.has(r.workspace_id))
      throw Error("Orphan number sequence");
    return {
      workspaceId: r.workspace_id,
      invoiceYear: r.invoice_year,
      lastValue: BigInt(r.last_value),
    };
  });
  return {
    invoiceReopeningProposals: proposals,
    paymentReversals: reversals,
    invoiceNumberSequences: sequences,
  };
}
