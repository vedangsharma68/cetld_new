import type { SupabaseClient } from "@supabase/supabase-js";

export type CustomerInput = {
  workspace_id: string; name: string; company_name?: string | null;
  email?: string | null; phone?: string | null; metadata?: Record<string, unknown>;
};

export type InvoiceInput = {
  workspace_id: string; customer_id: string; invoice_number: string;
  issue_date?: string; due_date?: string | null; currency?: string;
  total_amount: number; notes?: string | null; metadata?: Record<string, unknown>;
};

export type PaymentInput = {
  workspace_id: string; invoice_id: string; amount: number;
  paid_at?: string; method?: string | null; reference?: string | null;
  metadata?: Record<string, unknown>;
};

function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw result.error;
  if (result.data == null) throw new Error("Supabase returned no data");
  return result.data;
}

export async function createCustomer(client: SupabaseClient, input: CustomerInput) {
  return unwrap(await client.from("customers").insert(input).select("*").single());
}

export async function listCustomers(client: SupabaseClient, workspaceId: string) {
  const result = await client.from("customers").select("*").eq("workspace_id", workspaceId).order("name");
  if (result.error) throw result.error;
  return result.data ?? [];
}

export async function updateCustomer(client: SupabaseClient, workspaceId: string, id: string, patch: Partial<Omit<CustomerInput, "workspace_id">>) {
  return unwrap(await client.from("customers").update(patch).eq("workspace_id", workspaceId).eq("id", id).select("*").single());
}

export async function deleteCustomer(client: SupabaseClient, workspaceId: string, id: string) {
  const result = await client.from("customers").delete().eq("workspace_id", workspaceId).eq("id", id);
  if (result.error) throw result.error;
}

export async function createInvoice(client: SupabaseClient, input: InvoiceInput) {
  return unwrap(await client.from("invoices").insert(input).select("*").single());
}

export async function listInvoices(client: SupabaseClient, workspaceId: string) {
  const result = await client.from("invoices").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (result.error) throw result.error;
  return result.data ?? [];
}

export async function updateInvoice(client: SupabaseClient, workspaceId: string, id: string, patch: Partial<Omit<InvoiceInput, "workspace_id">>) {
  return unwrap(await client.from("invoices").update(patch).eq("workspace_id", workspaceId).eq("id", id).select("*").single());
}

export async function deleteInvoice(client: SupabaseClient, workspaceId: string, id: string) {
  const result = await client.from("invoices").delete().eq("workspace_id", workspaceId).eq("id", id);
  if (result.error) throw result.error;
}

export async function createPayment(client: SupabaseClient, input: PaymentInput) {
  return unwrap(await client.from("payments").insert(input).select("*").single());
}

export async function listPayments(client: SupabaseClient, workspaceId: string, invoiceId?: string) {
  let query = client.from("payments").select("*").eq("workspace_id", workspaceId);
  if (invoiceId) query = query.eq("invoice_id", invoiceId);
  const result = await query.order("paid_at", { ascending: false });
  if (result.error) throw result.error;
  return result.data ?? [];
}

