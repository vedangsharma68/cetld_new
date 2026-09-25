import {APIError, uuid} from './http.mjs';

const RESOURCE = Object.freeze({invoices: 'invoices', customers: 'contacts', payments: 'payments'});
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const SAFE_INVOICE_FIELDS = ['externalId', 'number', 'customerName', 'amountMinor', 'balanceMinor', 'paidMinor', 'currency', 'invoiceDate', 'dueDate', 'status', 'updatedAt', 'source'];
const SAFE_CUSTOMER_FIELDS = ['externalId', 'name', 'companyName', 'email', 'phone', 'contactType', 'status', 'currency', 'updatedAt', 'source'];
const SAFE_PAYMENT_FIELDS = ['externalId', 'amountMinor', 'currency', 'paymentDate', 'reference', 'invoiceIds', 'source'];

function safeRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, value[key]]));
}

function scoped(integration, userId, workspaceId, provider) {
  if (!integration || typeof integration.readZohoData !== 'function') throw new APIError(503, 'ACCOUNTING_NOT_CONFIGURED');
  if (typeof userId !== 'string' || typeof workspaceId !== 'string') throw new APIError(401, 'WORKSPACE_ACCESS_DENIED');
  return Object.freeze({
    async readZohoData({resource, page = 1, perPage = PAGE_SIZE} = {}) {
      if (provider !== 'zoho_books') throw new APIError(400, 'ACCOUNTING_PROVIDER_UNSUPPORTED');
      const normalizedResource = resource === 'contacts' ? 'customers' : resource;
      if (!Object.hasOwn(RESOURCE, normalizedResource)) throw new APIError(400, 'ACCOUNTING_RESOURCE_UNSUPPORTED');
      if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > PAGE_SIZE) throw new APIError(400, 'ACCOUNTING_PAGE_INVALID');
      const result = await integration.readZohoData({userId, workspaceId, provider, resource: RESOURCE[normalizedResource], page: safePage(page), perPage});
      if (!result || result.provider !== provider || !Array.isArray(result.records)) throw new APIError(502, 'ACCOUNTING_INVALID_RESPONSE');
      const fields = normalizedResource === 'invoices' ? SAFE_INVOICE_FIELDS : normalizedResource === 'customers' ? SAFE_CUSTOMER_FIELDS : SAFE_PAYMENT_FIELDS;
      return {provider, resource, records: result.records.map(item => safeRecord(item, fields)).filter(Boolean), nextPage: result.nextPage || null};
    },
    async read(resource, page = 1) {
      if (!Object.hasOwn(RESOURCE, resource)) throw new APIError(400, 'ACCOUNTING_RESOURCE_UNSUPPORTED');
      const result = await integration.readZohoData({userId, workspaceId, provider, resource: RESOURCE[resource], page, perPage: PAGE_SIZE});
      if (!result || result.provider !== provider || !Array.isArray(result.records)) throw new APIError(502, 'ACCOUNTING_INVALID_RESPONSE');
      return {records: result.records, nextPage: result.nextPage || null};
    },
  });
}

function safePage(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGES) throw new APIError(400, 'ACCOUNTING_PAGE_INVALID');
  return value;
}

function exactInvoiceInput(invoice) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) throw new APIError(422, 'INVOICE_REQUIRED');
  const result = {};
  for (const key of ['invoiceNumber', 'clientName', 'invoiceDate', 'dueDate', 'currency', 'notes', 'clientEmail', 'clientPhone', 'subtotal', 'tax', 'total']) {
    if (invoice[key] !== undefined) result[key] = invoice[key];
  }
  if (typeof result.invoiceNumber !== 'string' || !result.invoiceNumber.trim() || result.invoiceNumber.length > 100 || typeof result.clientName !== 'string' || !result.clientName.trim() || result.clientName.length > 255) throw new APIError(422, 'INVOICE_REQUIRED');
  if (typeof result.invoiceDate !== 'string' || typeof result.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.invoiceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(result.dueDate) || result.dueDate < result.invoiceDate) throw new APIError(422, 'INVALID_INVOICE_DATES');
  if (typeof result.currency !== 'string' || !/^[A-Z]{3}$/.test(result.currency)) throw new APIError(422, 'INVALID_CURRENCY');
  if (typeof result.total !== 'number' || !Number.isFinite(result.total) || result.total <= 0 || result.total > 9999999999999999) throw new APIError(422, 'INVALID_INVOICE_AMOUNT');
  return result;
}

function exactUpdateInput(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new APIError(422, 'INVOICE_CHANGES_REQUIRED');
  const allowed = ['dueDate', 'notes', 'invoiceDate'];
  if (!Object.keys(changes).length || Object.keys(changes).some(key => !allowed.includes(key))) throw new APIError(422, 'INVALID_INVOICE_CHANGES');
  const clean = {};
  if (changes.dueDate !== undefined) {
    if (typeof changes.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(changes.dueDate) || Number.isNaN(Date.parse(`${changes.dueDate}T00:00:00Z`))) throw new APIError(422, 'INVALID_INVOICE_DATES');
    clean.dueDate = changes.dueDate;
  }
  if (changes.invoiceDate !== undefined) {
    if (typeof changes.invoiceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(changes.invoiceDate) || Number.isNaN(Date.parse(`${changes.invoiceDate}T00:00:00Z`))) throw new APIError(422, 'INVALID_INVOICE_DATES');
    clean.invoiceDate = changes.invoiceDate;
  }
  if (changes.notes !== undefined) {
    if (changes.notes !== null && typeof changes.notes !== 'string') throw new APIError(422, 'INVALID_INVOICE_CHANGES');
    clean.notes = changes.notes?.slice(0, 2000) ?? null;
  }
  return clean;
}

/**
 * A workspace-bound, provider-neutral surface for Assistant and future agents.
 * Scope is closed over here and is never accepted from model/tool arguments.
 * Mutations are intentionally not exposed as model-callable tools: an app/server
 * confirmation handler must call createInvoice/updateInvoice with confirmed=true.
 */
export function createAccountingTools({integration, userId, workspaceId, provider = 'zoho_books'} = {}) {
  const api = scoped(integration, userId, workspaceId, provider);
  const readAll = async (resource, page = 1) => {
    const records = [];
    let current = safePage(page);
    for (let i = 0; i < MAX_PAGES; i++) {
      const result = await api.read(resource, current);
      records.push(...result.records);
      if (!result.nextPage) return records;
      current = safePage(result.nextPage);
    }
    throw new APIError(413, 'ACCOUNTING_RESULT_TOO_LARGE');
  };
  const integrationCall = (name, input) => {
    if (typeof integration[name] !== 'function') throw new APIError(503, 'ACCOUNTING_OPERATION_UNAVAILABLE');
    return integration[name]({...input, userId, workspaceId, provider});
  };

  return Object.freeze({
    readZohoData: api.readZohoData,
    async getInvoices({page = 1} = {}) { return (await readAll('invoices', page)).map(item => safeRecord(item, SAFE_INVOICE_FIELDS)).filter(Boolean); },
    async getCustomers({page = 1} = {}) { return (await readAll('customers', page)).map(item => safeRecord(item, SAFE_CUSTOMER_FIELDS)).filter(Boolean); },
    async getPayments({page = 1} = {}) { return (await readAll('payments', page)).map(item => safeRecord(item, SAFE_PAYMENT_FIELDS)).filter(Boolean); },
    async getInvoice(externalId) {
      if (typeof externalId !== 'string' || !externalId.trim() || externalId.length > 100) throw new APIError(400, 'INVALID_EXTERNAL_ID');
      const invoices = await readAll('invoices');
      const matching = invoices.filter(item => item.externalId === externalId || item.number === externalId);
      if (matching.length > 1) throw new APIError(409, 'ACCOUNTING_INVOICE_AMBIGUOUS');
      const record = matching[0];
      return record ? safeRecord(record, SAFE_INVOICE_FIELDS) : null;
    },
    async createInvoice({invoice, invoiceId, confirmed, idempotencyKey} = {}) {
      if (confirmed !== true) throw new APIError(409, 'CONFIRMATION_REQUIRED');
      invoiceId = uuid(invoiceId);
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw new APIError(400, 'INVALID_IDEMPOTENCY_KEY');
      const normalized = exactInvoiceInput(invoice);
      const result = await integrationCall('syncInvoice', {invoice: {...normalized, idempotencyKey}, invoiceId});
      if (!result?.externalId) throw new APIError(502, 'ACCOUNTING_SYNC_FAILED');
      return {provider: result.provider || provider, externalId: String(result.externalId), duplicate: Boolean(result.duplicate)};
    },
    async updateInvoice({invoiceId, changes, confirmed} = {}) {
      if (confirmed !== true) throw new APIError(409, 'CONFIRMATION_REQUIRED');
      if (typeof invoiceId !== 'string' || !invoiceId.trim() || invoiceId.length > 100) throw new APIError(400, 'INVALID_EXTERNAL_ID');
      const invoice = exactUpdateInput(changes);
      const result = await integrationCall('updateInvoice', {invoiceId, invoice});
      if (!result?.externalId) throw new APIError(502, 'ACCOUNTING_UPDATE_FAILED');
      return {provider: result.provider || provider, externalId: String(result.externalId), duplicate: false};
    },
    async syncWorkspace() {
      if (typeof integration.sync !== 'function') throw new APIError(503, 'ACCOUNTING_OPERATION_UNAVAILABLE');
      return integrationCall('sync', {});
    },
    async retrySync(input) { return integrationCall('retrySync', input || {}); },
    async disconnect() { return integrationCall('disconnect', {}); },
  });
}
