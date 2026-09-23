const MAX_ROWS = 5000;
const STORE_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = MAX_ROWS - MAX_PAGE_SIZE;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_SELECT = "id,invoice_number,customer_id,issue_date,due_date,currency,total_amount,amount_paid,status,created_at,updated_at";
const PAYMENT_SELECT = "id,invoice_id,amount,paid_at";

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
];

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
  return {
    id: invoice.id, invoiceNumber: invoice.invoice_number, customerId: invoice.customer_id,
    issueDate: invoice.issue_date, dueDate: invoice.due_date, currency: invoice.currency,
    totalAmount: String(invoice.total_amount), amountPaid: String(invoice.amount_paid), status: invoice.status,
    createdAt: invoice.created_at, updatedAt: invoice.updated_at,
  };
}

function optionalFollowUpSnapshot(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const safe = {};
  if (typeof metadata.followup_state === "string") safe.followup_state = metadata.followup_state;
  if (typeof metadata.last_follow_up_at === "string") safe.last_follow_up_at = metadata.last_follow_up_at;
  if (Number.isSafeInteger(metadata.reminder_count) && metadata.reminder_count >= 0) safe.reminder_count = metadata.reminder_count;
  return Object.keys(safe).length ? safe : null;
}

export function createAssistantTools({ store, clock = () => new Date() } = {}) {
  if (!store || typeof store.query !== "function") throw new TypeError("An authenticated workspace store with query() is required");

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
        const rows = await query(store, "invoices", INVOICE_SELECT, { filters, limit: bounds.lower || bounds.upper ? MAX_ROWS + 1 : limit, offset: bounds.lower || bounds.upper ? 0 : offset });
        const filtered = bounds.lower || bounds.upper ? rows.filter((row) => withinDateBounds(row.issue_date, bounds)) : rows;
        return (bounds.lower || bounds.upper ? filtered.slice(offset, offset + limit) : filtered).map(safeInvoice);
      }
      case "getCustomer": {
        const args = strictArgs(rawArgs, ["customerId"]);
        const id = uuid(args.customerId, "customerId");
        const rows = await query(store, "customers", "id,name,company_name,created_at,updated_at", { filters: { id: `eq.${id}` }, limit: 2 });
        return rows.length ? { id: rows[0].id, name: rows[0].name, companyName: rows[0].company_name ?? null, createdAt: rows[0].created_at, updatedAt: rows[0].updated_at } : null;
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
        const invoices = await query(store, 'invoices', 'id,currency');
        const currencies = new Map(invoices.map(i => [i.id, currencyCode(i.currency)]));
        const totals = new Map();
        for (const row of filtered) {
          const currency = currencies.get(row.invoice_id);
          if (!currency) throw new TypeError('Payment invoice unavailable; cannot determine currency');
          totals.set(currency, (totals.get(currency) ?? 0n) + cents(row.amount, 'amount'));
        }
        return {basis: 'recorded payment transactions', count: filtered.length, totalsByCurrency: Object.fromEntries([...totals].map(([c, n]) => [c, money(n)])),
          payments: filtered.slice(offset, offset + limit).map((row) => ({ id: row.id, invoiceId: row.invoice_id, currency: currencies.get(row.invoice_id), amount: String(row.amount), paidAt: row.paid_at })), offset, limit};
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
        return { basis: "invoices.amount_paid", currencies: groupInvoiceAmounts(applicable), debtors: debtors.slice(0,100).map(({balance,...row}) => ({...row,outstandingAmount: money(balance)})), debtorCount: debtors.length, debtorsTruncated: debtors.length > 100 };
      }
      case "getOverdueInvoices": {
        const args = strictArgs(rawArgs, ['dueDateFrom','dueDateTo']);
        const bounds = dateBounds(args.dueDateFrom,args.dueDateTo,'dueDateFrom','dueDateTo');
        const todayUtc = isoDay(clock);
        const invoices = await query(store, "invoices", INVOICE_SELECT, { order: "id.asc" });
        const overdue = invoices.filter((invoice) => invoice.due_date && invoice.due_date < todayUtc && withinDateBounds(invoice.due_date,bounds) && !["draft", "paid", "void", "cancelled"].includes(invoice.status) && cents(invoice.amount_paid, "amount_paid") < cents(invoice.total_amount, "total_amount"));
        const balances = overdue.map((invoice) => ({ ...safeInvoice(invoice), outstandingAmount: money(cents(invoice.total_amount, "total_amount") - cents(invoice.amount_paid, "amount_paid")) }));
        balances.sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
        return { asOfUtcDate: todayUtc, count: balances.length, balancesByCurrency: groupInvoiceAmounts(overdue), invoices: balances.slice(0,100), truncated: balances.length > 100 };
      }
      case "getActivity": {
        const args = strictArgs(rawArgs, ["invoiceId", "limit"]);
        const limit = boundedInteger(args.limit, 50, 1, MAX_PAGE_SIZE, "limit");
        const invoiceId = args.invoiceId === undefined ? null : uuid(args.invoiceId, "invoiceId");
        const invoiceFilters = invoiceId ? { id: `eq.${invoiceId}` } : {};
        const paymentFilters = invoiceId ? { invoice_id: `eq.${invoiceId}` } : {};
        const [invoices, payments] = await Promise.all([
          query(store, "invoices", `${INVOICE_SELECT},metadata`, { filters: invoiceFilters, order: "updated_at.desc,id.asc" }),
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
        return { verifiedFollowUpLogAvailable: false, note: "Invoice and payment events are shown; follow-up metadata, if present, is only a current invoice snapshot, not a verified follow-up event log.", events: events.slice(0, limit) };
      }
      default:
        throw new TypeError(`Unknown assistant tool: ${String(name)}`);
    }
  };

  return { definitions: definitions.map((item) => structuredClone(item)), tools: definitions.map((item) => structuredClone(item)), execute };
}
