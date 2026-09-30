function rows(result) { if (result?.error) throw result.error; return result?.data || []; }

/** Service-role write adapter used only after a verified WhatsApp confirmation. */
export function createWhatsAppInvoiceStore({supabase, workspaceId, customerId} = {}) {
  if (!supabase?.from || !workspaceId || !customerId) throw new TypeError('verified invoice store scope required');
  const scoped = table => supabase.from(table);
  const store = {workspaceId, userId: null,
    async findAssistantInvoice({idempotencyKey}) {
      const result = await scoped('invoices').select('*').eq('workspace_id', workspaceId)
        .eq('metadata->>assistant_idempotency_key', idempotencyKey).limit(1);
      return rows(result)[0] || null;
    },
    async findCustomer() {
      const result = await scoped('customers').select('*').eq('workspace_id', workspaceId).eq('id', customerId).limit(1);
      return rows(result)[0] || null;
    },
    async createCustomer() {
      throw new TypeError('verified WhatsApp scope cannot create another customer');
    },
    async createAssistantInvoice({customerId: invoiceCustomerId, invoice}) {
      if (invoiceCustomerId !== customerId) throw new TypeError('customer scope violation');
      const result = await scoped('invoices').upsert({workspace_id: workspaceId, customer_id: customerId,
        invoice_number: invoice.invoiceNumber, issue_date: invoice.invoiceDate, due_date: invoice.dueDate,
        currency: invoice.currency, total_amount: invoice.total, notes: invoice.notes || null,
        metadata: {assistant_idempotency_key: invoice.idempotencyKey, invoice_direction: invoice.direction,
          bookkeeping_sync_status: 'pending', followup_state: 'draft', next_follow_up_at: null,
          subtotal: invoice.subtotal, tax: invoice.tax, outstanding_amount: invoice.total,
          client_phone: invoice.clientPhone || null, client_email: invoice.clientEmail || null,
          line_items: invoice.lineItems || []}}, {onConflict: 'workspace_id,invoice_number', ignoreDuplicates: true}).select('*');
      return rows(result)[0] || null;
    },
    async updateAssistantInvoiceMetadata(id, metadata, synchronization = {}) {
      const result = await scoped('invoices').update({metadata, ...synchronization}).eq('workspace_id', workspaceId).eq('id', id).select('*').single();
      if (result.error) throw result.error;
      return result.data;
    },
  };
  return Object.freeze(store);
}
