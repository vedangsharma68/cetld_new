import {createDeletedAtCompatibility} from '../../invoice/deleted-at-compat.mjs';

function rows(result) { if (result?.error) throw result.error; return result?.data || []; }
const EDITABLE_FIELDS = new Set(['total','dueDate','invoiceDate','currency','notes','clientName','status']);

function mappedInvoice(row) {
  if (!row) return null;
  const metadata = row.metadata || {};
  return {id: row.id, invoiceNumber: row.invoice_number, clientName: metadata.client_name || null,
    printedInvoiceNumber: metadata.printed_invoice_number || metadata.source_invoice_number || null, invoiceDate: row.issue_date,
    dueDate: row.due_date, currency: row.currency, total: Number(row.total_amount), notes: row.notes,
    status: row.status, amountPaid: Number(row.amount_paid || 0), metadata, createdAt: row.created_at,
    updatedAt: row.updated_at};
}

/** Service-role write adapter used only after a verified WhatsApp confirmation. */
export function createWhatsAppInvoiceStore({supabase, workspaceId, customerId, audience='customer', authorize} = {}) {
  if (!supabase?.from || !workspaceId || !customerId) throw new TypeError('verified invoice store scope required');
  if(audience!=='customer'&&audience!=='owner')throw new TypeError('invalid invoice audience');
  const owner=audience==='owner';
  if(owner&&typeof authorize!=='function')throw new TypeError('verified owner authorization required');
  const scoped = table => supabase.from(table);
  const invoices = query => owner?query:query.eq('customer_id',customerId);
  const deletedAtCompatibility=createDeletedAtCompatibility();
  async function activeInvoiceRows(build){return deletedAtCompatibility.read({withDeletedAt:async()=>rows(await build(true)),legacy:async()=>rows(await build(false))})}
  async function ownedInvoice(id){
    const [row]=await activeInvoiceRows(includeDeletedAt=>{let query=invoices(scoped('invoices').select('*').eq('workspace_id',workspaceId).eq('id',id));if(includeDeletedAt)query=query.is('deleted_at',null);return query.limit(1)});
    if(!row)throw new TypeError('invoice scope violation');
    return row;
  }
  const store = {workspaceId, userId: null,
    async findAssistantInvoice({idempotencyKey}) {
      const [row]=await activeInvoiceRows(includeDeletedAt=>{let query=invoices(scoped('invoices').select('*').eq('workspace_id',workspaceId));if(includeDeletedAt)query=query.is('deleted_at',null);return query.eq('metadata->>assistant_idempotency_key',idempotencyKey).limit(1)});
      return row||null;
    },
    async findCustomer({email,name}={}) {
      if(owner){
        let q=scoped('customers').select('*').eq('workspace_id',workspaceId).eq('name',name);
        if(email)q=q.eq('email',email);
        const found=rows(await q.limit(2));
        if(found.length>1)throw new TypeError('ambiguous customer');
        return found[0]||null;
      }
      const result = await scoped('customers').select('*').eq('workspace_id', workspaceId).eq('id', customerId).limit(1);
      return rows(result)[0] || null;
    },
    async createCustomer({name,email,phone}={}) {
      if(owner){
        const result=await scoped('customers').insert({workspace_id:workspaceId,name,email:email||null,phone:phone||null}).select('*').single();
        if(result.error)throw result.error;
        return result.data;
      }
      throw new TypeError('verified WhatsApp scope cannot create another customer');
    },
    async createAssistantInvoice({customerId: invoiceCustomerId, invoice}) {
      if(owner){
        if(!rows(await scoped('customers').select('id').eq('workspace_id',workspaceId).eq('id',invoiceCustomerId).limit(1))[0])throw new TypeError('customer scope violation');
      }else if (invoiceCustomerId !== customerId) throw new TypeError('customer scope violation');
      const result = await scoped('invoices').upsert({workspace_id: workspaceId, customer_id: invoiceCustomerId,
        invoice_number: invoice.invoiceNumber, issue_date: invoice.invoiceDate, due_date: invoice.dueDate,
        currency: invoice.currency, total_amount: invoice.total, notes: invoice.notes || null,
        metadata: {assistant_idempotency_key: invoice.idempotencyKey, invoice_direction: invoice.direction,
          bookkeeping_sync_status: 'pending', followup_state: 'draft', next_follow_up_at: null,
          subtotal: invoice.subtotal, tax: invoice.tax, outstanding_amount: invoice.total,
          client_name: invoice.clientName, printed_invoice_number: invoice.invoiceNumber === 'AUTO' ? null : invoice.invoiceNumber,
          debtor_phone: invoice.clientPhone || null, client_phone: invoice.clientPhone || null,
          client_phone_raw: invoice.clientPhoneRaw || null, client_email: invoice.clientEmail || null,
          line_items: invoice.lineItems || []}}, {onConflict: 'workspace_id,invoice_number', ignoreDuplicates: true}).select('*');
      return rows(result)[0] || null;
    },
    async saveDebtorPhone({invoiceId, phone, assumedConsentAt}) {
      const row = await ownedInvoice(invoiceId);
      // Invoice metadata only: customers.phone is the owner's WhatsApp binding key and must never be overwritten.
      const metadata = {...(row.metadata || {}), debtor_phone: phone, client_phone: phone};
      delete metadata.debtor_consent;
      const updated = await invoices(scoped('invoices').update({metadata}).eq('workspace_id', workspaceId).eq('id', invoiceId))
        .eq('updated_at',row.updated_at).select('*').single();
      if (updated.error) throw updated.error;
      return mappedInvoice(updated.data);
    },
    async findInvoices({invoiceNumber, limit} = {}) {
      if(invoiceNumber&&!/^[a-z0-9_-]{1,100}$/i.test(invoiceNumber))throw new TypeError('invalid invoice number');
      const found=await activeInvoiceRows(includeDeletedAt=>{let query=invoices(scoped('invoices').select('*').eq('workspace_id',workspaceId));if(includeDeletedAt)query=query.is('deleted_at',null);if(invoiceNumber)query=query.or(`invoice_number.eq.${invoiceNumber},metadata->>printed_invoice_number.eq.${invoiceNumber},metadata->>source_invoice_number.eq.${invoiceNumber}`);return query.order('created_at',{ascending:false}).limit(invoiceNumber?10:Math.min(Number(limit)||2,1000))});
      const ids=[...new Set(found.map(row=>row.customer_id))];
      const customers=ids.length?rows(await scoped('customers').select('id,name,email,phone').eq('workspace_id',workspaceId).in('id',ids).limit(1000)):[];
      return found.map(row=>{
        const client=customers.find(c=>c.id===row.customer_id);
        return {...mappedInvoice(row),clientName:client?.name||mappedInvoice(row).clientName,
          metadata:{...(row.metadata||{}),...(client?.phone?{customer_phone:client.phone}:{}),...(client?.email?{customer_email:client.email}:{})}};
      });
    },
    async applyCorrection({invoiceId, changes, idempotencyKey, changedAt}) {
      if (!changes || Object.keys(changes).some(field => !EDITABLE_FIELDS.has(field))) throw new TypeError('unsupported invoice correction field');
      const row = await ownedInvoice(invoiceId);
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
      const result = await invoices(scoped('invoices').update(patch).eq('workspace_id', workspaceId).eq('id', invoiceId))
        .eq('updated_at', row.updated_at).select('*').single();
      if (result.error) throw result.error;
      return {invoice: mappedInvoice(result.data), changes: audit, duplicate: false};
    },
    async keepInvoiceFile({invoiceId, bytes, fileName, mimeType, idempotencyKey}) {
      await ownedInvoice(invoiceId);
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
      await ownedInvoice(invoiceId);
      const result = await scoped('invoice_files').select('*').eq('workspace_id', workspaceId).eq('invoice_id', invoiceId)
        .order('created_at', {ascending: false}).limit(1);
      const file = rows(result)[0];
      if (!file) return null;
      if(!file.storage_path?.startsWith(`${workspaceId}/${invoiceId}/`)||file.storage_path.split('/').some(p=>p==='..'||p==='.')||Number(file.size_bytes)>10*1024*1024)
        throw new TypeError('invalid invoice file scope or size');
      const download = await supabase.storage.from('invoice-files').download(file.storage_path);
      if (download.error) throw download.error;
      const bytes=Buffer.from(await download.data.arrayBuffer());
      if(bytes.length>10*1024*1024)throw new TypeError('invoice file too large');
      return {...file, bytes};
    },
    async updateAssistantInvoiceMetadata(id, metadata, synchronization = {}) {
      await ownedInvoice(id);
      const result = await invoices(scoped('invoices').update({metadata, ...synchronization}).eq('workspace_id', workspaceId).eq('id', id)).select('*').single();
      if (result.error) throw result.error;
      return result.data;
    },
  };
  if(owner)return Object.freeze(Object.fromEntries(Object.entries(store).map(([key,value])=>[key,typeof value==='function'?async(...args)=>{
    if(!await authorize())throw new TypeError('owner binding changed');
    const result=await value(...args);
    if(!await authorize())throw new TypeError('owner binding changed');
    return result;
  }:value])));
  return Object.freeze(store);
}
