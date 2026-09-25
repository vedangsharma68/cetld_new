const MAX_ROWS = 5000;
const STORE_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = MAX_ROWS - MAX_PAGE_SIZE;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_SELECT = "id,invoice_number,customer_id,issue_date,due_date,currency,total_amount,amount_paid,status,notes,metadata,created_at,updated_at";
const CUSTOMER_SELECT = "id,name,company_name,email,phone,created_at,updated_at";
const PAYMENT_SELECT = "id,invoice_id,amount,paid_at,method,reference,created_at,updated_at";
const FILE_SELECT = "id,invoice_id,file_name,mime_type,size_bytes,created_at,updated_at";

const definitions = [
  tool("getInvoices", "List invoices in the authenticated workspace. Amounts are the invoice snapshot; use getPayments for recorded payment transactions.", {
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE }, offset: { type: "integer", minimum: 0, maximum: MAX_OFFSET },
    status: { type: "string", enum: ["draft", "sent", "overdue", "paid", "void", "cancelled"] },
    customerId: { type: "string", format: "uuid" }, issueDateFrom: { type: "string", format: "date" }, issueDateTo: { type: "string", format: "date" },
  }),
  tool("getCustomer", "Get a customer's safe profile fields by id from the authenticated workspace.", { customerId: { type: "string", format: "uuid" } }, ["customerId"]),
  tool("getPayments", "List recorded payment transactions, optionally for one invoice. Payment rows are distinct from invoices.amount_paid.", {
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE }, offset: { type: "integer", minimum: 0, maximum: MAX_OFFSET },
    invoiceId: { type: "string", format: "uuid" }, paidAtFrom: { type: "string", format: "date" }, paidAtTo: { type: "string", format: "date" },
  }),
  tool("getOutstandingSummary", "Summarize remaining invoice balances grouped by currency. Uses invoices.amount_paid, not a sum of payment records.", {}),
  tool("getOverdueInvoices", "List unpaid, non-draft invoices whose due date is before today's UTC date, optionally in an inclusive due-date range, grouped by currency in the summary.", {dueDateFrom:{type:'string',format:'date'},dueDateTo:{type:'string',format:'date'}}),
  tool("getActivity", "Show invoice creation/update timestamps and recorded payment transactions. No verified follow-up event log is available; safe follow-up metadata is only a current invoice snapshot.", {
    invoiceId: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
  }),
  tool("getInvoiceDetails", "Get one invoice's compact joined customer, payment, file, follow-up, reminder, conversation snapshot, and bookkeeping-sync context.", {
    target: {type: "string", minLength: 1, maxLength: 160},
  }, ["target"]),
];

const zohoBooksDataTool = tool("getZohoBooksData", "Read paginated live Zoho Books receivables data for the connected organization. Use only when the user asks about Zoho Books; this tool is read-only.", {
  resource: { type: "string", enum: ["invoices", "contacts", "payments"] },
  page: { type: "integer", minimum: 1, maximum: 10000 },
  perPage: { type: "integer", minimum: 1, maximum: 200 },
}, ["resource"]);

function tool(name, description, properties, required = []) {
  return { type: "function", function: {
    name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  } };
}

function inputObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object");
  return args;
}

function strictArgs(args, allowed) {
  const input = inputObject(args);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new TypeError(`Unexpected argument: ${key}`);
  return input;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value;
}

function dateOnly(value, label) {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new TypeError(`${label} must be a YYYY-MM-DD date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${label} is not a valid calendar date`);
  return value;
}

function dateBounds(from, to, fromName, toName) {
  const lower = from === undefined ? null : dateOnly(from, fromName);
  const upper = to === undefined ? null : dateOnly(to, toName);
  if (lower && upper && upper < lower) throw new RangeError(`${toName} must not be before ${fromName}`);
  return { lower, upper };
}

function timestampUtcDay(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Store returned an invalid timestamp");
  return parsed.toISOString().slice(0, 10);
}

function withinDateBounds(value, { lower, upper }, timestamp = false) {
  if (value == null) return false;
  const day = timestamp ? timestampUtcDay(value) : String(value).slice(0, 10);
  return (!lower || day >= lower) && (!upper || day <= upper);
}

// Parse database decimal strings to integer cents. BigInt keeps aggregation exact.
function cents(value, label) {
  const text = String(value);
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new TypeError(`${label} is not a valid non-negative two-decimal amount`);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(match[1]) * 100n + BigInt(fraction || "0");
}

function money(value) {
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function currencyCode(value) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new TypeError("Invoice has an invalid currency");
  return value;
}

function isoDay(clock) {
  const now = clock();
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("Clock returned an invalid date");
  return date.toISOString().slice(0, 10);
}

function rowsOf(result, table) {
  if (!Array.isArray(result)) throw new TypeError(`Store query for ${table} must return an array`);
  return result;
}

async function query(store, table, select, { filters = {}, limit = MAX_ROWS + 1, offset = 0, order = "id.asc" } = {}) {
  // The store is already authenticated and workspace-bound. No scope arguments are accepted here.
  const collected = [];
  let position = offset;
  while (collected.length < limit) {
    const pageLimit = Math.min(STORE_PAGE_SIZE, limit - collected.length);
    const page = rowsOf(await store.query(table, { select, filters, order, limit: pageLimit, offset: position }), table);
    collected.push(...page);
    position += page.length;
    if (collected.length > MAX_ROWS) throw new RangeError(`Result exceeds the ${MAX_ROWS}-row safety limit; refusing a partial answer`);
    if (page.length < pageLimit) break;
  }
  return collected;
}

function groupInvoiceAmounts(invoices) {
  const grouped = new Map();
  for (const invoice of invoices) {
    const currency = currencyCode(invoice.currency);
    const total = cents(invoice.total_amount, "total_amount");
    const paid = cents(invoice.amount_paid, "amount_paid");
    if (paid > total) throw new TypeError("Invoice amount_paid exceeds total_amount");
    const item = grouped.get(currency) ?? { invoiceCount: 0, totalAmount: 0n, amountPaid: 0n, outstandingAmount: 0n };
    item.invoiceCount += 1;
    item.totalAmount += total;
    item.amountPaid += paid;
    item.outstandingAmount += total - paid;
    grouped.set(currency, item);
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, item]) => [currency, {
    invoiceCount: item.invoiceCount,
    totalAmount: money(item.totalAmount),
    amountPaid: money(item.amountPaid),
    outstandingAmount: money(item.outstandingAmount),
  }]));
}

function safeInvoice(invoice) {
  const total = cents(invoice.total_amount, "total_amount");
  const paid = cents(invoice.amount_paid, "amount_paid");
  if (paid > total) throw new TypeError("Invoice amount_paid exceeds total_amount");
  const isFullyPaid = total > 0n && paid >= total;
  return {
    id: invoice.id, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id,
    issueDate: invoice.issue_date, dueDate: invoice.due_date, currency: invoice.currency,
    subtotal: decimalMetadata(invoice.metadata?.subtotal), tax: decimalMetadata(invoice.metadata?.tax),
    totalAmount: String(invoice.total_amount), amountPaid: String(invoice.amount_paid), outstandingAmount: money(total - paid),
    paymentStatus: isFullyPaid ? "paid" : paid > 0n ? "partially_paid" : "unpaid", isFullyPaid,
    status: invoice.status, invoiceStatus: invoice.status, notes: safeText(invoice.notes, 4000),
    createdAt: invoice.created_at, updatedAt: invoice.updated_at,
  };
}

function safeText(value, maximum = 500) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function decimalMetadata(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return money(cents(value, "metadata amount")); } catch { return null; }
}

function stringMetadata(metadata, keys, maximum = 500) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  for (const key of keys) {
    const value = safeText(metadata[key], maximum);
    if (value) return value;
  }
  return null;
}

function integerMetadata(metadata, keys) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  for (const key of keys) if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) return metadata[key];
  return null;
}

function compactFollowUp(metadata) {
  return cleanObject({
    state: stringMetadata(metadata, ["followup_state", "follow_up_state", "followup_status"]),
    nextScheduledReminder: stringMetadata(metadata, ["next_follow_up_at", "next_reminder_at"]),
    lastReminderSent: stringMetadata(metadata, ["last_follow_up_at", "last_reminder_sent_at"]),
    remindersSent: integerMetadata(metadata, ["reminder_count", "reminders_sent"]),
    cadence: stringMetadata(metadata, ["reminder_cadence", "follow_up_cadence"]),
    pauseReason: stringMetadata(metadata, ["pause_reason"]),
    paymentClaimed: typeof metadata?.payment_claimed === "boolean" ? metadata.payment_claimed : null,
    needsAttentionReason: stringMetadata(metadata, ["needs_attention_reason"]),
    escalationState: stringMetadata(metadata, ["escalation_state"]),
  });
}

function compactBookkeeping(metadata) {
  return cleanObject({
    provider: stringMetadata(metadata, ["bookkeeping_provider", "accounting_provider"]),
    externalInvoiceId: stringMetadata(metadata, ["bookkeeping_record_id", "accounting_external_invoice_id"]),
    syncStatus: stringMetadata(metadata, ["bookkeeping_sync_status"]),
    syncError: stringMetadata(metadata, ["bookkeeping_sync_error"], 300),
    syncedAt: stringMetadata(metadata, ["bookkeeping_synced_at"]),
    lastSyncAttemptAt: stringMetadata(metadata, ["bookkeeping_sync_attempted_at"]),
  });
}

function compactConversation(metadata) {
  return cleanObject({
    status: stringMetadata(metadata, ["conversation_status"]),
    reminderDraft: stringMetadata(metadata, ["reminder_text"], 2000),
    latestCustomerResponse: stringMetadata(metadata, ["latest_customer_response", "last_customer_reply"], 2000),
    latestCustomerResponseAt: stringMetadata(metadata, ["latest_customer_response_at", "last_customer_reply_at"]),
    historyRecorded: false,
  });
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "").map(([key, item]) => [key, cleanObject(item)]));
}

function accountingAmount(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  const code = String(currency || '').toUpperCase();
  const scale = ['BHD','IQD','JOD','KWD','LYD','OMR','TND'].includes(code) ? 1000 : ['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'].includes(code) ? 1 : 100;
  return (minor / scale).toFixed(scale === 1 ? 0 : scale === 1000 ? 3 : 2);
}

function safeZohoResult(resource, result) {
  const records = Array.isArray(result?.records) ? result.records : [];
  const nextPage=result.nextPage||null;
  const completeness={complete:!nextPage,truncated:Boolean(nextPage)};
  if (resource === 'invoices') return {
    provider: 'zoho_books', resource, nextPage, ...completeness,
    invoices: records.map(row => ({invoiceId: row.externalId, invoiceNumber: row.number, customerName: row.customerName, currency: row.currency, totalAmount: accountingAmount(row.amountMinor, row.currency), amountPaid: accountingAmount(row.paidMinor, row.currency), outstandingAmount: accountingAmount(row.balanceMinor, row.currency), dueDate: row.dueDate, invoiceDate: row.invoiceDate, status: row.status, updatedAt: row.updatedAt})),
  };
  if (resource === 'contacts') return {
    provider: 'zoho_books', resource, nextPage, ...completeness,
    customers: records.map(row => ({customerId: row.externalId, name: row.name, companyName: row.companyName, email: row.email, phone: row.phone, status: row.status, currency: row.currency, updatedAt: row.updatedAt})),
  };
  return {
    provider: 'zoho_books', resource, nextPage, ...completeness,
    payments: records.map(row => ({paymentId: row.externalId, amount: accountingAmount(row.amountMinor, row.currency), currency: row.currency, paymentDate: row.paymentDate, invoiceIds: row.invoiceIds, reference: row.reference})),
  };
}

function exactPattern(value) { return `ilike.${String(value).replace(/[\\%*_]/g, "\\$&")}`; }
function partialPattern(value) { return `ilike.*${String(value).replace(/[\\%*_]/g, "\\$&")}*`; }

function optionalFollowUpSnapshot(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const safe = {};
  if (typeof metadata.followup_state === "string") safe.followup_state = metadata.followup_state;
  if (typeof metadata.last_follow_up_at === "string") safe.last_follow_up_at = metadata.last_follow_up_at;
  if (Number.isSafeInteger(metadata.reminder_count) && metadata.reminder_count >= 0) safe.reminder_count = metadata.reminder_count;
  return Object.keys(safe).length ? safe : null;
}

export function createAssistantTools({ store, clock = () => new Date(), accounting = null } = {}) {
  if (!store || typeof store.query !== "function") throw new TypeError("An authenticated workspace store with query() is required");

  let lookupInvoice;
  const activeDefinitions = (accounting?.readZohoData || accounting?.integration?.readZohoData) ? [...definitions, zohoBooksDataTool] : definitions;

  const customersForInvoices = async invoices => {
    const ids = [...new Set(invoices.map(invoice => invoice.customer_id).filter(id => typeof id === "string" && UUID_RE.test(id)))].slice(0, MAX_PAGE_SIZE);
    if (!ids.length) return new Map();
    const rows = await query(store, "customers", CUSTOMER_SELECT, {filters: {id: `in.(${ids.join(",")})`}, limit: ids.length});
    return new Map(rows.map(customer => [customer.id, customer]));
  };

  const buildInvoiceContext = async (invoice, knownCustomer = null) => {
    const [customerRows, paymentRows, fileRows] = await Promise.all([
      knownCustomer ? Promise.resolve([knownCustomer]) : query(store, "customers", CUSTOMER_SELECT, {filters: {id: `eq.${invoice.customer_id}`}, limit: 1}),
      query(store, "payments", PAYMENT_SELECT, {filters: {invoice_id: `eq.${invoice.id}`}, order: "paid_at.desc,id.asc", limit: 101}),
      query(store, "invoice_files", FILE_SELECT, {filters: {invoice_id: `eq.${invoice.id}`}, order: "created_at.desc,id.asc", limit: 25}).catch(() => []),
    ]);
    const customer = customerRows[0] || null;
    const normalized = safeInvoice(invoice);
    const paymentHistoryTruncated = paymentRows.length > 100;
    const visiblePayments = paymentRows.slice(0,100);
    const paymentTotal = visiblePayments.reduce((total, payment) => total + cents(payment.amount, "payment amount"), 0n);
    const context = cleanObject({
      ...normalized,
      customerName: customer?.company_name || customer?.name || null,
      customer: customer ? {
        name: customer.name, companyName: customer.company_name, email: customer.email, phone: customer.phone,
        createdAt: customer.created_at, updatedAt: customer.updated_at,
      } : null,
      payments: visiblePayments.map(payment => cleanObject({
        id: payment.id, amount: String(payment.amount), currency: invoice.currency, paidAt: payment.paid_at,
        method: safeText(payment.method), reference: safeText(payment.reference), createdAt: payment.created_at, updatedAt: payment.updated_at,
      })),
      recordedPaymentTotal: money(paymentTotal),
      recordedPaymentTotalComplete: !paymentHistoryTruncated,
      paymentHistoryTruncated,
      originalFiles: fileRows.map(file => cleanObject({
        id: file.id, fileName: file.file_name, mimeType: file.mime_type, sizeBytes: file.size_bytes,
        createdAt: file.created_at, updatedAt: file.updated_at,
      })),
      followUp: compactFollowUp(invoice.metadata),
      conversation: compactConversation(invoice.metadata),
      bookkeeping: compactBookkeeping(invoice.metadata),
      dataAvailability: {
        reminderHistory: "not recorded",
        outboundMessageHistory: "not recorded",
        inboundReplyHistory: "not recorded",
      },
    });
    delete context.customerId;
    if (!customer) context.customerName = null;
    return context;
  };

  const execute = async (name, rawArgs = {}) => {
    switch (name) {
      case "getInvoices": {
        const args = strictArgs(rawArgs, ["limit", "offset", "status", "customerId", "issueDateFrom", "issueDateTo"]);
        const limit = boundedInteger(args.limit, 25, 1, MAX_PAGE_SIZE, "limit");
        const offset = boundedInteger(args.offset, 0, 0, MAX_OFFSET, "offset");
        if (offset + limit > MAX_ROWS) throw new RangeError("Requested page exceeds the row safety limit");
        const filters = {};
        if (args.status !== undefined) {
          if (!["draft", "sent", "overdue", "paid", "void", "cancelled"].includes(args.status)) throw new TypeError("Invalid status");
          filters.status = `eq.${args.status}`;
        }
        if (args.customerId !== undefined) filters.customer_id = `eq.${uuid(args.customerId, "customerId")}`;
        const bounds = dateBounds(args.issueDateFrom, args.issueDateTo, "issueDateFrom", "issueDateTo");
        const rows = await query(store, "invoices", INVOICE_SELECT, { filters, limit: bounds.lower || bounds.upper ? MAX_ROWS + 1 : limit + 1, offset: bounds.lower || bounds.upper ? 0 : offset });
        const filtered = bounds.lower || bounds.upper ? rows.filter((row) => withinDateBounds(row.issue_date, bounds)) : rows;
        const selected = (bounds.lower || bounds.upper ? filtered.slice(offset, offset + limit) : filtered.slice(0,limit));
        const customers = await customersForInvoices(selected);
        const result = selected.map(row => ({...safeInvoice(row), customerName: customers.get(row.customer_id)?.company_name || customers.get(row.customer_id)?.name || null}));
        Object.defineProperty(result,'truncated',{value:bounds.lower||bounds.upper?filtered.length>offset+limit:rows.length>limit,enumerable:false});
        return result;
      }
      case "getCustomer": {
        const args = strictArgs(rawArgs, ["customerId"]);
        const id = uuid(args.customerId, "customerId");
        const rows = await query(store, "customers", CUSTOMER_SELECT, { filters: { id: `eq.${id}` }, limit: 2 });
        return rows.length ? cleanObject({ id: rows[0].id, name: rows[0].name, companyName: rows[0].company_name, email: rows[0].email, phone: rows[0].phone, createdAt: rows[0].created_at, updatedAt: rows[0].updated_at }) : null;
      }
      case "getPayments": {
        const args = strictArgs(rawArgs, ["limit", "offset", "invoiceId", "paidAtFrom", "paidAtTo"]);
        const limit = boundedInteger(args.limit, 25, 1, MAX_PAGE_SIZE, "limit");
        const offset = boundedInteger(args.offset, 0, 0, MAX_OFFSET, "offset");
        if (offset + limit > MAX_ROWS) throw new RangeError("Requested page exceeds the row safety limit");
        const filters = {};
        if (args.invoiceId !== undefined) filters.invoice_id = `eq.${uuid(args.invoiceId, "invoiceId")}`;
        const bounds = dateBounds(args.paidAtFrom, args.paidAtTo, "paidAtFrom", "paidAtTo");
        const rows = await query(store, "payments", PAYMENT_SELECT, { filters, order: "paid_at.desc,id.asc" });
        const filtered = bounds.lower || bounds.upper ? rows.filter((row) => withinDateBounds(row.paid_at, bounds, true)) : rows;
        const invoiceIds = args.invoiceId ? [uuid(args.invoiceId, "invoiceId")] : [...new Set(filtered.map(row => row.invoice_id))];
        const invoiceRows = await Promise.all(invoiceIds.map(id => query(store, 'invoices', 'id,invoice_number,customer_id,currency', {filters: {id: `eq.${id}`}, limit: 1})));
        const paymentInvoices = invoiceRows.flat();
        const paymentCustomers = await customersForInvoices(paymentInvoices);
        const invoicesById = new Map(paymentInvoices.map(i => [i.id, i]));
        const currencies = new Map(paymentInvoices.map(i => [i.id, currencyCode(i.currency)]));
        const totals = new Map();
        for (const row of filtered) {
          const currency = currencies.get(row.invoice_id);
          if (!currency) throw new TypeError('Payment invoice unavailable; cannot determine currency');
          totals.set(currency, (totals.get(currency) ?? 0n) + cents(row.amount, 'amount'));
        }
        const truncated=offset+limit<filtered.length;
        return {basis: 'recorded payment transactions', count: filtered.length, totalsByCurrency: Object.fromEntries([...totals].map(([c, n]) => [c, money(n)])),
          payments: filtered.slice(offset, offset + limit).map((row) => { const invoice = invoicesById.get(row.invoice_id); const customer = paymentCustomers.get(invoice?.customer_id); return cleanObject({ id: row.id, invoiceId: row.invoice_id, invoiceNumber: invoice?.invoice_number, customerName: customer?.company_name || customer?.name, currency: currencies.get(row.invoice_id), amount: String(row.amount), paidAt: row.paid_at, method: row.method, reference: row.reference }); }), offset, limit, complete:!truncated, truncated};
      }
      case "getOutstandingSummary": {
        strictArgs(rawArgs, []);
        const invoices = await query(store, "invoices", INVOICE_SELECT, { order: "id.asc" });
        const applicable = invoices.filter((invoice) => !["draft", "void", "cancelled"].includes(invoice.status));
        const customers = await query(store, 'customers', 'id,name,company_name');
        const names = new Map(customers.map(c => [c.id, c.company_name || c.name]));
        const grouped = new Map();
        for (const invoice of applicable) {
          const balance = cents(invoice.total_amount, 'total_amount') - cents(invoice.amount_paid, 'amount_paid');
          if (balance <= 0n) continue;
          const key = invoice.customer_id + ':' + currencyCode(invoice.currency);
          const row = grouped.get(key) ?? {customerId: invoice.customer_id, customerName: names.get(invoice.customer_id) ?? null, currency: invoice.currency, balance: 0n};
          row.balance += balance; grouped.set(key, row);
        }
        const debtors = [...grouped.values()].sort((a,b) => a.currency.localeCompare(b.currency) || (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : a.customerId.localeCompare(b.customerId)));
        const leaders = debtors.filter((row,index) => index === 0 || row.currency !== debtors[index - 1].currency);
        return { basis: "invoices.amount_paid", currencies: groupInvoiceAmounts(applicable), debtors: leaders.map(({balance,...row}) => ({...row,outstandingAmount: money(balance)})), debtorCount: debtors.length, complete:true, truncated:false };
      }
      case "getOverdueInvoices": {
        const args = strictArgs(rawArgs, ['dueDateFrom','dueDateTo']);
        const bounds = dateBounds(args.dueDateFrom,args.dueDateTo,'dueDateFrom','dueDateTo');
        const todayUtc = isoDay(clock);
        const invoices = await query(store, "invoices", INVOICE_SELECT, { order: "id.asc" });
        const overdue = invoices.filter((invoice) => invoice.due_date && invoice.due_date < todayUtc && withinDateBounds(invoice.due_date,bounds) && !["draft", "paid", "void", "cancelled"].includes(invoice.status) && cents(invoice.amount_paid, "amount_paid") < cents(invoice.total_amount, "total_amount"));
        const overdueCustomers = await customersForInvoices(overdue);
        const balances = overdue.map((invoice) => ({ ...safeInvoice(invoice), customerName: overdueCustomers.get(invoice.customer_id)?.company_name || overdueCustomers.get(invoice.customer_id)?.name || null, outstandingAmount: money(cents(invoice.total_amount, "total_amount") - cents(invoice.amount_paid, "amount_paid")) }));
        balances.sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
        const truncated=balances.length>100;
        return { asOfUtcDate: todayUtc, count: balances.length, balancesByCurrency: groupInvoiceAmounts(overdue), invoices: balances.slice(0,100), complete:!truncated, truncated };
      }
      case "getActivity": {
        const args = strictArgs(rawArgs, ["invoiceId", "limit"]);
        const limit = boundedInteger(args.limit, 50, 1, MAX_PAGE_SIZE, "limit");
        const invoiceId = args.invoiceId === undefined ? null : uuid(args.invoiceId, "invoiceId");
        const invoiceFilters = invoiceId ? { id: `eq.${invoiceId}` } : {};
        const paymentFilters = invoiceId ? { invoice_id: `eq.${invoiceId}` } : {};
        const [invoices, payments] = await Promise.all([
          query(store, "invoices", INVOICE_SELECT, { filters: invoiceFilters, order: "updated_at.desc,id.asc" }),
          query(store, "payments", PAYMENT_SELECT, { filters: paymentFilters, order: "paid_at.desc,id.asc" }),
        ]);
        if (invoices.length + payments.length > MAX_ROWS) throw new RangeError(`Activity exceeds the ${MAX_ROWS}-row safety limit; refusing a partial answer`);
        const events = [];
        for (const invoice of invoices) {
          const followUpSnapshot = optionalFollowUpSnapshot(invoice.metadata);
          events.push({ type: "invoice_created", occurredAt: invoice.created_at, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number });
          if (invoice.updated_at && invoice.updated_at !== invoice.created_at) events.push({ type: "invoice_updated", occurredAt: invoice.updated_at, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, ...(followUpSnapshot ? { followUpMetadataSnapshot: followUpSnapshot } : {}) });
        }
        for (const payment of payments) events.push({ type: "payment_recorded", occurredAt: payment.paid_at, invoiceId: payment.invoice_id, paymentId: payment.id, amount: String(payment.amount) });
        events.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)) || a.type.localeCompare(b.type) || String(a.invoiceId).localeCompare(String(b.invoiceId)));
        const truncated=events.length>limit;
        return { verifiedFollowUpLogAvailable: false, note: "Invoice and payment events are shown; follow-up metadata, if present, is only a current invoice snapshot, not a verified follow-up event log.", count:events.length, complete:!truncated, truncated, events: events.slice(0, limit) };
      }
      case "getZohoBooksData": {
        if (!accounting?.readZohoData && !accounting?.integration?.readZohoData) throw new TypeError("Zoho Books is not connected to this workspace");
        const args = strictArgs(rawArgs, ["resource", "page", "perPage"]);
        if (!["invoices", "contacts", "payments"].includes(args.resource)) throw new TypeError("Zoho Books resource is invalid");
        const input = {resource: args.resource, page: boundedInteger(args.page, 1, 1, 50, "page"), perPage: boundedInteger(args.perPage, 50, 1, 200, "perPage")};
        const result = accounting.readZohoData
          ? await accounting.readZohoData(input)
          : await accounting.integration.readZohoData({...input, userId: accounting.userId, workspaceId: accounting.workspaceId, provider: "zoho_books"});
        return safeZohoResult(args.resource, result);
      }
      case "getInvoiceDetails": {
        const args = strictArgs(rawArgs, ["target"]);
        const match = await lookupInvoice(args.target);
        return match;
      }
      default:
        throw new TypeError(`Unknown assistant tool: ${String(name)}`);
    }
  };

  // Exact, deterministic lookup used before any model planning. The model only
  // receives the matched invoice rows, never a workspace-wide invoice list.
  lookupInvoice = async (rawTarget) => {
    if (typeof rawTarget !== 'string' || !rawTarget.trim() || rawTarget.length > 160 || /[%*_]/.test(rawTarget)) throw new TypeError('Invoice lookup target is invalid');
    const target = rawTarget.trim().replace(/^the\s+/i, '').replace(/\s+invoice$/i, '').trim();
    const uuidTarget = UUID_RE.test(target);
    const numberRows = uuidTarget ? [] : await query(store, 'invoices', INVOICE_SELECT, {filters: {invoice_number: exactPattern(target)}, limit: 10});
    let invoiceRows = numberRows;
    if (uuidTarget) invoiceRows = await query(store, 'invoices', INVOICE_SELECT, {filters: {id: `eq.${target}`}, limit: 3});
    let customerRows = [];
    if (!invoiceRows.length && !uuidTarget) {
      const [byName, byCompany] = await Promise.all([
        query(store, 'customers', CUSTOMER_SELECT, {filters: {name: exactPattern(target)}, limit: 10}),
        query(store, 'customers', CUSTOMER_SELECT, {filters: {company_name: exactPattern(target)}, limit: 10}),
      ]);
      customerRows = [...new Map([...byName, ...byCompany].map(row => [row.id, row])).values()];
      if (!customerRows.length && target.length >= 3) {
        const [byNamePartial, byCompanyPartial] = await Promise.all([
          query(store, 'customers', CUSTOMER_SELECT, {filters: {name: partialPattern(target)}, limit: 10}),
          query(store, 'customers', CUSTOMER_SELECT, {filters: {company_name: partialPattern(target)}, limit: 10}),
        ]);
        customerRows = [...new Map([...byNamePartial, ...byCompanyPartial].map(row => [row.id, row])).values()];
      }
      if (customerRows.length === 1) invoiceRows = await query(store, 'invoices', INVOICE_SELECT, {filters: {customer_id: `eq.${customerRows[0].id}`}, limit: 26});
    }
    if (!invoiceRows.length && !uuidTarget) {
      const amount = target.replace(/[,\s]/g, '').match(/^(?:₹|INR|USD|EUR|GBP|AED|AUD|SGD|CAD|JPY|CHF)?([0-9]+(?:\.[0-9]{1,2})?)$/i)?.[1];
      if (amount) invoiceRows = await query(store, 'invoices', INVOICE_SELECT, {filters: {total_amount: `eq.${amount}`}, limit: 26});
    }
    const customerMap = new Map(customerRows.map(row => [row.id, row]));
    if (invoiceRows.length) {
      const ids = [...new Set(invoiceRows.map(row => row.customer_id))];
      const customers = await Promise.all(ids.slice(0, 10).map(id => query(store, 'customers', CUSTOMER_SELECT, {filters: {id: `eq.${id}`}, limit: 1})));
      for (const customer of customers.flat()) customerMap.set(customer.id, customer);
    }
    const result = {
      ambiguousCustomer: customerRows.length > 1,
      invoices: invoiceRows.slice(0, 25).map(row => ({...safeInvoice(row), customerName: customerMap.get(row.customer_id)?.company_name || customerMap.get(row.customer_id)?.name || null})),
      truncated: invoiceRows.length > 25,
    };
    if (!result.ambiguousCustomer && result.invoices.length === 1 && !result.truncated) {
      result.invoices[0] = await buildInvoiceContext(invoiceRows[0], customerMap.get(invoiceRows[0].customer_id));
    }
    return result;
  };

  return { definitions: activeDefinitions.map((item) => structuredClone(item)), tools: activeDefinitions.map((item) => structuredClone(item)), execute, lookupInvoice };
}
