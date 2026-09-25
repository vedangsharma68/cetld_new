import {APIError, object, uuid} from './http.mjs';
import {AMOUNT_PRECISION_MESSAGE,CURRENCY_SUPPORT_MESSAGE,isSupportedCurrency} from '../currency-contract.mjs';

const INPUT_FIELDS = ['invoiceNumber', 'clientName', 'clientEmail', 'clientPhone', 'invoiceDate', 'dueDate', 'subtotal', 'tax', 'total', 'outstanding', 'currency', 'notes', 'alreadyPaid'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function amount(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new APIError(422, 'INVOICE_TOTAL_REQUIRED');
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') throw new APIError(422, 'INVALID_INVOICE_AMOUNT');
  const text=String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new APIError(422, 'INVALID_INVOICE_AMOUNT');
  if (/\.\d{3,}$/.test(text)) throw new APIError(422, 'AMOUNT_PRECISION_UNSUPPORTED', AMOUNT_PRECISION_MESSAGE);
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 9999999999999999) throw new APIError(422, 'INVALID_INVOICE_AMOUNT');
  return n;
}

export function validateAssistantInvoice(value) {
  object(value, INPUT_FIELDS);
  const invoiceNumber = String(value.invoiceNumber || '').trim();
  const clientName = String(value.clientName || '').trim();
  if (!invoiceNumber || invoiceNumber.length > 100) throw new APIError(422, 'INVOICE_NUMBER_REQUIRED');
  if (!clientName || clientName.length > 255) throw new APIError(422, 'CLIENT_REQUIRED');
  if (!dateValue(value.invoiceDate)) throw new APIError(422, 'INVOICE_DATE_REQUIRED');
  if (!dateValue(value.dueDate)) return {missingDueDate: true};
  if (value.dueDate < value.invoiceDate) throw new APIError(422, 'INVALID_DUE_DATE');
  const currency = String(value.currency || '').trim().toUpperCase();
  if (!currency) throw new APIError(422, 'CURRENCY_REQUIRED');
  if (!isSupportedCurrency(currency)) throw new APIError(422, 'UNSUPPORTED_CURRENCY', CURRENCY_SUPPORT_MESSAGE);
  const total = amount(value.total, true);
  const subtotal = amount(value.subtotal);
  const tax = amount(value.tax);
  const outstanding = value.outstanding === null || value.outstanding === undefined ? null : amount(value.outstanding, true);
  if (outstanding !== null && outstanding > total) throw new APIError(422, 'INVALID_OUTSTANDING_AMOUNT');
  if (subtotal !== null && subtotal > total) throw new APIError(422, 'INVALID_SUBTOTAL');
  if (tax !== null && tax > total) throw new APIError(422, 'INVALID_TAX');
  const email = value.clientEmail == null ? null : String(value.clientEmail).trim();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)) throw new APIError(422, 'INVALID_CLIENT_EMAIL');
  const phone = value.clientPhone == null ? null : String(value.clientPhone).trim();
  if (phone && phone.length > 40) throw new APIError(422, 'INVALID_CLIENT_PHONE');
  const notes = value.notes == null ? null : String(value.notes).trim().slice(0, 2000) || null;
  if (value.alreadyPaid !== undefined && typeof value.alreadyPaid !== 'boolean') throw new APIError(422, 'INVALID_PAID_STATE');
  const alreadyPaid = value.alreadyPaid === true;
  return {invoiceNumber, clientName, clientEmail: email || null, clientPhone: phone || null, invoiceDate: value.invoiceDate, dueDate: value.dueDate, subtotal, tax, total, outstanding: alreadyPaid ? 0 : (outstanding ?? total), currency, notes, alreadyPaid};
}

function responseInvoice(row) {
  return {id: row.id, invoiceNumber: row.invoice_number, clientName: row.customer_name || null, invoiceDate: row.issue_date, dueDate: row.due_date, currency: row.currency, total: Number(row.total_amount), amountPaid: Number(row.amount_paid || 0), status: row.status, metadata: row.metadata || {}};
}

async function syncSavedInvoice({store, invoice, row, accounting}) {
  const metadata = {...(row.metadata || {}), bookkeeping_sync_status: 'pending', bookkeeping_sync_error: null};
  try {
    if (!accounting?.syncInvoice) {
      const saved = await store.updateAssistantInvoiceMetadata(row.id, {...metadata, bookkeeping_sync_status: 'not_configured'});
      return {row: saved, sync: {status: 'not_configured', provider: null, retryable: false}};
    }
    const result = await accounting.syncInvoice({userId: store.userId, workspaceId: store.workspaceId, provider: 'zoho_books', invoice, invoiceId: row.id});
    const syncedAt = new Date().toISOString();
    const updated = await store.updateAssistantInvoiceMetadata(row.id, {...metadata, bookkeeping_provider: result.provider, bookkeeping_record_id: result.externalId, bookkeeping_sync_status: 'synced', bookkeeping_synced_at: syncedAt}, {external_provider: result.provider, external_invoice_id: result.externalId, last_synced_at: syncedAt, sync_status: 'synced', last_sync_error: null});
    return {row: updated, sync: {status: 'synced', provider: result.provider, externalId: result.externalId, retryable: false}};
  } catch (error) {
    const status = error?.code === 'ACCOUNTING_NOT_CONNECTED' || error?.code === 'ACCOUNTING_NOT_CONFIGURED' ? 'not_configured' : 'failed';
    const errorCode = String(error?.code || 'SYNC_FAILED').slice(0, 80);
    const updated = await store.updateAssistantInvoiceMetadata(row.id, {...metadata, bookkeeping_sync_status: status, bookkeeping_sync_error: errorCode, bookkeeping_sync_attempted_at: new Date().toISOString()}, {sync_status: status === 'failed' ? 'failed' : 'local', last_sync_error: errorCode});
    return {row: updated, sync: {status, provider: null, retryable: status === 'failed'}};
  }
}

export async function saveAssistantInvoice({store, invoice: input, confirmed, idempotencyKey, accounting} = {}) {
  const invoice = validateAssistantInvoice(input);
  if (invoice.missingDueDate) return {needsInput: true, question: 'What is the due date for this invoice?'};
  if (confirmed !== true) throw new APIError(409, 'CONFIRMATION_REQUIRED');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw new APIError(400, 'INVALID_IDEMPOTENCY_KEY');
  invoice.idempotencyKey = idempotencyKey;
  let row = await store.findAssistantInvoice({invoiceNumber: invoice.invoiceNumber, idempotencyKey});
  let idempotent = Boolean(row);
  if (invoice.alreadyPaid) {
    let customerId = row?.customer_id;
    if (!customerId) {
      let customer = await store.findCustomer({email: invoice.clientEmail, name: invoice.clientName});
      if (!customer) customer = await store.createCustomer({name: invoice.clientName, email: invoice.clientEmail, phone: invoice.clientPhone});
      customerId = customer.id;
    }
    // Always call the atomic RPC, including on retries of a previously saved row.
    // The RPC repairs a legacy fully-paid row only when payment history is absent.
    row = await store.createPaidAssistantInvoice({customerId, invoice});
    if (!row) {
      row = await store.findAssistantInvoice({invoiceNumber: invoice.invoiceNumber, idempotencyKey});
      if (!row) throw new APIError(409, 'INVOICE_ALREADY_EXISTS');
      idempotent = true;
    }
  } else if (!row) {
    let customer = await store.findCustomer({email: invoice.clientEmail, name: invoice.clientName});
    if (!customer) customer = await store.createCustomer({name: invoice.clientName, email: invoice.clientEmail, phone: invoice.clientPhone});
    row = await store.createAssistantInvoice({customerId: customer.id, invoice});
    if (!row) {
      row = await store.findAssistantInvoice({invoiceNumber: invoice.invoiceNumber, idempotencyKey});
      if (!row) throw new APIError(409, 'INVOICE_ALREADY_EXISTS');
      idempotent = true;
    }
  }
  if (row.metadata?.bookkeeping_sync_status === 'synced' && row.metadata?.bookkeeping_record_id) return {saved: true, invoice: responseInvoice(row), sync: {status: 'synced', provider: row.metadata.bookkeeping_provider || null, externalId: row.metadata.bookkeeping_record_id, retryable: false}, idempotent};
  const synced = await syncSavedInvoice({store, invoice, row, accounting});
  return {saved: true, invoice: responseInvoice(synced.row), sync: synced.sync, idempotent};
}

export async function retryAssistantInvoiceSync({store, invoiceId, accounting} = {}) {
  const id = uuid(invoiceId);
  const row = await store.getAssistantInvoice(id);
  if (!row) throw new APIError(404, 'INVOICE_NOT_FOUND');
  const metadata = row.metadata || {};
  if (metadata.bookkeeping_record_id && metadata.bookkeeping_sync_status === 'synced') return {saved: true, invoice: responseInvoice(row), sync: {status: 'synced', provider: metadata.bookkeeping_provider || null, externalId: metadata.bookkeeping_record_id, retryable: false}, idempotent: true};
  const customer = (await store.query('customers', {select: 'id,workspace_id,name,email,phone', filters: {id: `eq.${row.customer_id}`}, limit: 1}))[0];
  const invoice = {invoiceNumber: row.invoice_number, clientName: customer?.name || '', clientEmail: customer?.email || null, clientPhone: customer?.phone || null, invoiceDate: row.issue_date, dueDate: row.due_date, currency: row.currency, total: Number(row.total_amount), subtotal: metadata.subtotal ?? null, tax: metadata.tax ?? null, outstanding: Number(row.total_amount) - Number(row.amount_paid || 0), notes: row.notes || null, alreadyPaid: row.status === 'paid'};
  const synced = await syncSavedInvoice({store, invoice, row, accounting});
  return {saved: true, invoice: responseInvoice(synced.row), sync: synced.sync, idempotent: true};
}
