// Shared read-only contract for the dashboard and both owner assistants.
// Follow-up approval/state is deliberately unrelated to invoice issuance.
const ISSUED = new Set(['issued', 'sent', 'open', 'overdue', 'partially_paid', 'partially-paid']);
const TERMINAL = new Set(['paid', 'void', 'cancelled', 'canceled']);
export function receivableKind(invoice) {
  if (invoice?.deleted_at) return null;
  const status = String(invoice?.status || '').toLowerCase();
  const direction = invoice?.invoice_direction ?? invoice?.metadata?.invoice_direction;
  if (TERMINAL.has(status) || direction === 'payable') return null;
  if (status === 'draft') return 'draft';
  if (direction === 'uncertain') return 'unclassified';
  return ISSUED.has(status) ? 'issued' : 'unclassified';
}

function minor(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? 0));
  if (!match) throw new TypeError('Invalid invoice amount');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
const decimal = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
function amounts(invoice) {
  if (invoice.amount_minor !== undefined) {
    if (!Number.isSafeInteger(invoice.amount_minor) || !Number.isSafeInteger(invoice.paid_minor)
      || invoice.amount_minor < 0 || invoice.paid_minor < 0) throw new TypeError('Invalid invoice amount');
    return [BigInt(invoice.amount_minor), BigInt(invoice.paid_minor)];
  }
  return [minor(invoice.total_amount), minor(invoice.amount_paid)];
}
export function summarizeReceivables(invoices = []) {
  const groups = {issued: new Map(), draft: new Map(), unclassified: new Map()};
  for (const invoice of invoices) {
    const kind = receivableKind(invoice);
    if (!kind) continue;
    const [total, paid] = amounts(invoice);
    const balance = total > paid ? total - paid : 0n;
    if (!balance) continue;
    const currency = String(invoice.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('Invalid invoice currency');
    const row = groups[kind].get(currency) || {invoiceCount: 0, total: 0n, paid: 0n, balance: 0n};
    row.invoiceCount++;
    row.total += total; row.paid += paid; row.balance += balance;
    groups[kind].set(currency, row);
  }
  const format = group => Object.fromEntries([...group].sort(([a], [b]) => a.localeCompare(b)).map(([currency, row]) => [currency, {
    invoiceCount: row.invoiceCount, totalAmount: decimal(row.total), amountPaid: decimal(row.paid), outstandingAmount: decimal(row.balance),
  }]));
  return {currencies: format(groups.issued), draftBalancesByCurrency: format(groups.draft), unclassifiedBalancesByCurrency: format(groups.unclassified)};
}

export function receivablesAnswer(summary, {countOnly = false} = {}) {
  const format = groups => Object.entries(groups || {}).filter(([, row]) => Number(row.outstandingAmount) > 0)
    .map(([currency, row]) => `${currency} ${row.outstandingAmount}`).join(', ') || 'none';
  const count = Object.values(summary.currencies || {}).reduce((sum, row) => sum + row.invoiceCount, 0);
  return `${countOnly ? `${count} issued outstanding invoice${count === 1 ? '' : 's'}. ` : ''}Issued outstanding: ${format(summary.currencies)}.\nUnissued drafts (not yet receivable): ${format(summary.draftBalancesByCurrency)}.`
    + (Object.keys(summary.unclassifiedBalancesByCurrency || {}).length
      ? `\nUnclassified balances (excluded from outstanding; review status and direction): ${format(summary.unclassifiedBalancesByCurrency)}.` : '');
}

export function receivablesReadAnswer(result, options) {
  if (result?.ok !== true || result.readOnly !== true || result.operation !== 'read' || result.table !== 'invoices'
    || result.truncated !== false || result.offset > 0 || !Array.isArray(result.rows)) return null;
  try {
    // A projection lacking issuance or currency cannot establish receivables.
    const summary=result.balanceSummary || (result.invoiceReadAnalysis?.complete===true&&result.invoiceReadAnalysis?.balanceSummary);
    if (summary) return receivablesAnswer(summary, options);
    if (result.rows.some(row => !row.status || !row.currency || row.total_amount == null)) return null;
    return receivablesAnswer(summarizeReceivables(result.rows), options);
  } catch { return null; }
}

// Bounded global balance requests use the complete ledger on both transports.
// Named customers/invoices, scenarios and write instructions stay on their own paths.
export function isOutstandingBalanceQuestion(message) {
  const text=String(message||'').trim().toLowerCase().replace(/[.!?]+$/,'').replace(/\s+/g,' ');
  return /^(?:what is|what's|how much is)(?: (?:my|our|the))?(?: total)? outstanding(?: balance)?(?: (?:right now|today))?(?: (?:in|for) (?:my|our|the|this) business)?$/.test(text);
}

export function receivableBalanceLabel(invoice) {
  const status=invoice.status||invoice.invoiceStatus;
  const row={...invoice,status,invoice_direction:invoice.invoice_direction||invoice.invoiceDirection};
  if((row.invoice_direction??row.metadata?.invoice_direction)==='payable')return 'Payable balance';
  const kind=receivableKind(row);
  if(kind==='draft')return 'Unissued draft balance (not yet receivable)';
  if(kind==='issued'||status==='paid')return 'Issued outstanding';
  return 'Document balance (excluded from outstanding)';
}
