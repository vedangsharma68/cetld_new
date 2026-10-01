function rows(result) { if (result?.error) throw result.error; return result?.data || []; }
const EDITABLE_FIELDS = new Set(['total','dueDate','invoiceDate','currency','notes','clientName','status']);

function mappedInvoice(row) {
  if (!row) return null;
  const metadata = row.metadata || {};
  return {id: row.id, invoiceNumber: row.invoice_number, clientName: metadata.client_name || null,
    printedInvoiceNumber: metadata.printed_invoice_number || null, invoiceDate: row.issue_date,
    dueDate: row.due_date, currency: row.currency, total: Number(row.total_amount), notes: row.notes,
    status: row.status, amountPaid: Number(row.amount_paid || 0), metadata, createdAt: row.created_at,
    updatedAt: row.updated_at};
}

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
          client_name: invoice.clientName, printed_invoice_number: invoice.invoiceNumber === 'AUTO' ? null : invoice.invoiceNumber,
          client_phone: invoice.clientPhone || null, client_email: invoice.clientEmail || null,
          line_items: invoice.lineItems || []}}, {onConflict: 'workspace_id,invoice_number', ignoreDuplicates: true}).select('*');
      return rows(result)[0] || null;
    },
    async findInvoices({invoiceNumber, limit} = {}) {
      let query = scoped('invoices').select('*').eq('workspace_id', workspaceId);
      if (invoiceNumber) query = query.or(`invoice_number.eq.${invoiceNumber},metadata->>printed_invoice_number.eq.${invoiceNumber}`);
      const result = await query.order('created_at', {ascending: false}).limit(invoiceNumber ? 10 : Math.min(Number(limit) || 2, 50));
      return rows(result).map(mappedInvoice);
    },
    async applyCorrection({invoiceId, changes, idempotencyKey, changedAt}) {
      if (!changes || Object.keys(changes).some(field => !EDITABLE_FIELDS.has(field))) throw new TypeError('unsupported invoice correction field');
      const found = await scoped('invoices').select('*').eq('workspace_id', workspaceId).eq('id', invoiceId).limit(1);
      const row = rows(found)[0];
      if (!row) return {reason: 'not_found'};
      const metadata = row.metadata || {};
      const prior = (metadata.whatsapp_corrections || []).find(item => item.idempotency_key === idempotencyKey);
      if (prior) return {invoice: mappedInvoice(row), changes: prior.changes, duplicate: true};
      const paid = Number(row.amount_paid || 0);
      if (['paid','void','cancelled'].includes(row.status) || paid >= Number(row.total_amount)) return {reason: 'settled'};
      if (changes.status === 'paid') return {reason: 'use_dashboard_for_payment'};
      if (changes.total != null && paid > Number(changes.total)) return {reason: 'payments_exceed_total'};
      const nextMetadata = {...metadata};
      const patch = {};
      const audit = {};
      const set = (field, oldValue, newValue) => { if (oldValue !== newValue) audit[field] = {old: oldValue, new: newValue}; };
      if (changes.total != null) {
        const total = Number(changes.total); set('total', Number(row.total_amount), total); patch.total_amount = total;
        nextMetadata.outstanding_amount = Math.max(0, total - paid);
        const oldSubtotal = Number(nextMetadata.subtotal); const oldTax = Number(nextMetadata.tax);
        if (Number.isFinite(oldSubtotal) && Number.isFinite(oldTax) && Math.abs(oldSubtotal + oldTax - Number(row.total_amount)) < .011) nextMetadata.subtotal = Math.max(0, total - oldTax);
        else { nextMetadata.subtotal = total; nextMetadata.tax = 0; }
      }
      if (changes.dueDate !== undefined) { set('dueDate', row.due_date, changes.dueDate); patch.due_date = changes.dueDate; }
      if (changes.invoiceDate !== undefined) { set('invoiceDate', row.issue_date, changes.invoiceDate); patch.issue_date = changes.invoiceDate; }
      if (changes.currency !== undefined) { set('currency', row.currency, changes.currency); patch.currency = changes.currency; }
      if (changes.notes !== undefined) { set('notes', row.notes, changes.notes); patch.notes = changes.notes || null; }
      if (changes.clientName !== undefined) { set('clientName', metadata.client_name || null, changes.clientName); nextMetadata.client_name = changes.clientName; }
      if (changes.status !== undefined) { set('status', row.status, changes.status); patch.status = changes.status; if (changes.status === 'paid') nextMetadata.outstanding_amount = 0; }
      if (!Object.keys(audit).length) return {invoice: mappedInvoice(row), changes: {}, duplicate: true};
      const entry = {idempotency_key: idempotencyKey, changed_at: changedAt, changes: audit, source: 'whatsapp'};
      nextMetadata.whatsapp_corrections = [...(Array.isArray(metadata.whatsapp_corrections) ? metadata.whatsapp_corrections : []), entry].slice(-50);
      patch.metadata = nextMetadata;
      const result = await scoped('invoices').update(patch).eq('workspace_id', workspaceId).eq('id', invoiceId)
        .eq('updated_at', row.updated_at).select('*').single();
      if (result.error) throw result.error;
      return {invoice: mappedInvoice(result.data), changes: audit, duplicate: false};
    },
    async keepInvoiceFile({invoiceId, bytes, fileName, mimeType, idempotencyKey}) {
      const existing = await scoped('invoice_files').select('*').eq('workspace_id', workspaceId).eq('invoice_id', invoiceId)
        .eq('storage_path', `${workspaceId}/${invoiceId}/${idempotencyKey}`).limit(1);
      if (rows(existing)[0]) return rows(existing)[0];
      const storagePath = `${workspaceId}/${invoiceId}/${idempotencyKey}`;
      const upload = await supabase.storage.from('invoice-files').upload(storagePath, bytes, {contentType: mimeType, upsert: false});
      if (upload.error && upload.error.statusCode !== '409') throw upload.error;
      const inserted = await scoped('invoice_files').insert({workspace_id: workspaceId, invoice_id: invoiceId,
        storage_path: storagePath, file_name: fileName, mime_type: mimeType, size_bytes: bytes.length}).select('*').single();
      if (inserted.error) throw inserted.error;
      return inserted.data;
    },
    async latestInvoiceFile(invoiceId) {
      const result = await scoped('invoice_files').select('*').eq('workspace_id', workspaceId).eq('invoice_id', invoiceId)
        .order('created_at', {ascending: false}).limit(1);
      const file = rows(result)[0];
      if (!file) return null;
      const download = await supabase.storage.from('invoice-files').download(file.storage_path);
      if (download.error) throw download.error;
      return {...file, bytes: Buffer.from(await download.data.arrayBuffer())};
    },
    async updateAssistantInvoiceMetadata(id, metadata, synchronization = {}) {
      const result = await scoped('invoices').update({metadata, ...synchronization}).eq('workspace_id', workspaceId).eq('id', id).select('*').single();
      if (result.error) throw result.error;
      return result.data;
    },
  };
  return Object.freeze(store);
}
