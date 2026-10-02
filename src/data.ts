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

const deletedAtCapableClients = new WeakSet<object>();
function missingDeletedAtColumn(error: any) {
  const code=String(error?.code||'');
  return ['42703','PGRST204'].includes(code)
    && /\bdeleted_at\b/i.test([error?.message,error?.details,error?.hint].filter(Boolean).join(' '));
}
async function activeInvoiceRows(client: SupabaseClient, workspaceId: string, invoiceId?: string) {
  const run=async(includeDeletedAt: boolean) => {
    let query=client.from('invoices').select('*').eq('workspace_id',workspaceId);
    if(invoiceId)query=query.eq('id',invoiceId);
    if(includeDeletedAt)query=query.is('deleted_at',null);
    const result=await query.order('created_at',{ascending:false});
    if(result.error)throw result.error;
    return result.data??[];
  };
  const wasAvailable=deletedAtCapableClients.has(client);
  try {
    const rows=await run(true);
    deletedAtCapableClients.add(client);
    return rows.filter((row:any)=>!row.deleted_at);
  } catch(error) {
    if(!missingDeletedAtColumn(error)||wasAvailable)throw error;
    const rows=await run(false);
    return rows.filter((row:any)=>!row.deleted_at);
  }
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
  return activeInvoiceRows(client,workspaceId);
}

export async function updateInvoice(client: SupabaseClient, workspaceId: string, id: string, patch: Partial<Omit<InvoiceInput, "workspace_id">>) {
  return unwrap(await client.from("invoices").update(patch).eq("workspace_id", workspaceId).eq("id", id).select("*").single());
}

export type InvoiceLifecycleClient = {
  request(action: 'prepareDelete'|'confirmDelete'|'cancelDelete', payload: Record<string,string>): Promise<Record<string,any>>;
};
export async function deleteInvoice(_client: SupabaseClient, workspaceId: string, id: string, {
  lifecycle, requestMessage, confirmationMessage, confirmationMessageId,
}: {lifecycle?: InvoiceLifecycleClient; requestMessage?: string; confirmationMessage?: string; confirmationMessageId?: string} = {}) {
  if(!lifecycle||typeof requestMessage!=='string'||!requestMessage.trim()
    ||typeof confirmationMessage!=='string'||!confirmationMessage.trim()
    ||typeof confirmationMessageId!=='string'||!confirmationMessageId.trim()) {
    throw new Error('Invoice deletion must use the owner-only lifecycle confirmation flow.');
  }
  const proposal=await lifecycle.request('prepareDelete',{workspaceId,invoiceId:id,idempotencyKey:crypto.randomUUID(),userMessage:requestMessage});
  if(proposal?.action!=='proposal_created'||typeof proposal.proposalId!=='string')throw new Error('The invoice deletion proposal could not be prepared.');
  const required=proposal.requiresExactConfirmation===true?`DELETE ${proposal.invoiceNumber}`:'yes';
  if(confirmationMessage.trim()!==required){
    try{await lifecycle.request('cancelDelete',{workspaceId,proposalId:proposal.proposalId})}catch{}
    throw new Error(proposal.requiresExactConfirmation?'Type the exact DELETE invoice number confirmation.':'Confirm the deletion with yes.');
  }
  return lifecycle.request('confirmDelete',{workspaceId,proposalId:proposal.proposalId,userMessage:confirmationMessage.trim(),confirmationMessageId});
}

export async function createPayment(client: SupabaseClient, input: PaymentInput) {
  return unwrap(await client.from("payments").insert(input).select("*").single());
}

export async function listPayments(client: SupabaseClient, workspaceId: string, invoiceId?: string) {
  const activeInvoices=await activeInvoiceRows(client,workspaceId,invoiceId);
  const activeIds=new Set(activeInvoices.map((invoice:any)=>invoice.id));
  if(invoiceId&&!activeIds.has(invoiceId))return [];
  if(!activeIds.size)return [];
  let query = client.from("payments").select("*").eq("workspace_id", workspaceId);
  if (invoiceId) query = query.eq("invoice_id", invoiceId);
  const result = await query.order("paid_at", { ascending: false });
  if (result.error) throw result.error;
  return (result.data ?? []).filter((payment:any)=>activeIds.has(payment.invoice_id));
}

