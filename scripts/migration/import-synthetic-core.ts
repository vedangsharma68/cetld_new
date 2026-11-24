import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { planLegacyCoreSnapshot } from "./plan-legacy-core-snapshot";
import {
  users,
  profiles,
  workspaceSettings,
  workspaceAiSettings,
  providerAccounts,
  workspaces,
  workspaceMembers,
  customers,
  invoices,
  payments,
  invoiceReopeningProposals,
  paymentReversals,
  invoiceNumberSequences,
} from "../../src/server/db/schema";
// Loopback proof operator only. Hosted source import still requires separately
// reviewed all-table preservation, privacy/effect freeze and original file copy.
export async function importSyntheticCore(
  databaseUrl: string,
  snapshot: unknown,
) {
  if (
    new URL(databaseUrl).hostname !== "127.0.0.1" ||
    process.env.APP_ENV !== "test"
  )
    throw Error("Synthetic loopback only");
  const plan = planLegacyCoreSnapshot(snapshot);
  if (plan.files.length)
    throw Error("Synthetic core operator does not copy original file bytes");
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(client);
  try {
    await db.transaction(async (tx) => {
      if (plan.users.length)
        await tx.insert(users).values(
          plan.users.map((u) => ({
            ...u,
            emailVerifiedAt: u.emailVerifiedAt
              ? new Date(u.emailVerifiedAt)
              : null,
            bannedUntil: u.bannedUntil ? new Date(u.bannedUntil) : null,
            deletedAt: u.deletedAt ? new Date(u.deletedAt) : null,
          })),
        );
      if (plan.accounts.length)
        await tx.insert(providerAccounts).values(plan.accounts);
      if (plan.workspaces.length)
        await tx.insert(workspaces).values(plan.workspaces);
      if (plan.members.length)
        await tx.insert(workspaceMembers).values(plan.members);
      if (plan.profiles.length) await tx.insert(profiles).values(plan.profiles);
      if (plan.workspaceSettings.length)
        await tx.insert(workspaceSettings).values(plan.workspaceSettings);
      if (plan.workspaceAiSettings.length)
        await tx.insert(workspaceAiSettings).values(plan.workspaceAiSettings);
      if (plan.customers.length)
        await tx.insert(customers).values(plan.customers);
      if (plan.invoices.length) await tx.insert(invoices).values(plan.invoices);
      if (plan.payments.length) await tx.insert(payments).values(plan.payments);
      if (plan.invoiceReopeningProposals.length)
        await tx
          .insert(invoiceReopeningProposals)
          .values(plan.invoiceReopeningProposals);
      if (plan.paymentReversals.length)
        await tx.insert(paymentReversals).values(plan.paymentReversals);
      if (plan.invoiceNumberSequences.length)
        await tx
          .insert(invoiceNumberSequences)
          .values(plan.invoiceNumberSequences);
    });
    return {
      invoices: plan.invoices.length,
      payments: plan.payments.length,
      reversals: plan.paymentReversals.length,
      sequences: plan.invoiceNumberSequences.length,
    };
  } finally {
    await client.end();
  }
}
