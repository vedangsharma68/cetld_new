import {isSupportedCurrency, CURRENCY_SUPPORT_MESSAGE} from '../currency-contract.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 2000;
const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = value => typeof value === 'string' ? value.trim() : '';

export function parseCSV(source) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') { quoted = false; closed = true; } else if (c === undefined) throw Error('Unclosed CSV quote.'); else cell += c; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === undefined) {
      row.push(cell.replace(/\r$/, '')); cell = ''; closed = false;
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (rows.length > MAX_ROWS + 1) throw Error(`Maximum ${MAX_ROWS} rows per file.`); }
    } else { if (closed && c !== '\r') throw Error('Unexpected text after CSV quote.'); if (c === '"') throw Error('Invalid CSV quote.'); cell += c; }
  }
  if (!rows.length) throw Error('The file is empty.');
  const headers = rows.shift().map(key);
  if (new Set(headers).size !== headers.length) throw Error('Duplicate CSV column headings.');
  return rows.map((values, i) => { if (values.length !== headers.length) throw Error(`CSV row ${i + 2} has the wrong number of columns.`); return Object.fromEntries(headers.map((h, n) => [h, values[n].trim()])); });
}

// Bounded XML reader for Tally exports; DTDs and external entities are never resolved.
function xmlTree(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('XML DTDs and entities are unsupported.');
  const validCharacter = n => n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && (n & 0xffff) < 0xfffe);
  const decode = value => {
    if (/&(?!#x[\da-fA-F]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/.test(value)) throw Error('Unknown XML entity.');
    return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
      if (entity[0] !== '#') return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity];
      const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!validCharacter(n)) throw Error('Invalid XML character.');
      return String.fromCodePoint(n);
    });
  };
  for (const character of source) if (!validCharacter(character.codePointAt(0))) throw Error('Invalid XML character.');
  const root = {name:'', children:[], value:'', attrs:{}}, stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>|[^<]+/g) || [];
  if (tokens.join('') !== source) throw Error('Malformed XML.');
  for (const token of tokens) {
    if (token.startsWith('<!--')) { if (token.slice(4,-3).includes('--')) throw Error('Malformed XML comment.'); continue; }
    if (token.startsWith('<?')) { if (!/^<\?[A-Za-z_][\w.:-]*(?:\s[\s\S]*)?\?>$/.test(token)) throw Error('Malformed XML instruction.'); continue; }
    if (token.startsWith('<![CDATA[')) { if (stack.length === 1) throw Error('CDATA must be inside an XML element.'); stack.at(-1).value += token.slice(9,-3); continue; }
    if (token.startsWith('</')) {
      const name = token.match(/^<\/([A-Za-z_][\w.:-]*)\s*>$/)?.[1];
      if (!name || stack.length < 2 || stack.pop().name !== name) throw Error('Mismatched XML tags.');
    } else if (token.startsWith('<')) {
      const m = token.match(/^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/); if (!m) throw Error('Malformed XML tag.');
      const attrs = Object.create(null); let remaining = m[2];
      remaining = remaining.replace(/\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/g, (_, name, value) => {
        if (Object.hasOwn(attrs,name)) throw Error('Duplicate XML attribute.'); attrs[name] = decode(value.slice(1,-1)); return '';
      });
      if (remaining.trim()) throw Error('Malformed XML attributes.');
      const node = {name:m[1], attrs, value:'', children:[]}; stack.at(-1).children.push(node); if (!m[3]) stack.push(node);
      if (stack.length > 64) throw Error('XML is nested too deeply.');
    } else {
      if (token.includes(']]>')) throw Error('Malformed XML text.');
      stack.at(-1).value += decode(token);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.value.trim()) throw Error('Malformed XML document.');
  return root;
}
function date(value) {
  let v = text(value); if (/^\d{8}$/.test(v)) v = `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6)}`;
  const m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m) { const month = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(m[2].toLowerCase()) + 1; v = `${m[3].length === 2 ? '20' : ''}${m[3]}-${String(month).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  if (Number(v.slice(0,4)) < 2000 || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10) !== v) return null;
  return v;
}
export function parseTally(filename, source, {workspaceCurrency = 'INR'} = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) throw Error('Maximum file size is 2 MB.');
  if (source.includes('\0')) throw Error('Invalid NUL character in Tally export.');
  source = source.replace(/^\uFEFF/, '');
  if (!/\.(csv|xml)$/i.test(filename)) throw Error('Unsupported format. Export CSV or XML from TallyPrime (not XLSX).');
  workspaceCurrency = text(workspaceCurrency).toUpperCase();
  if (!isSupportedCurrency(workspaceCurrency)) throw Error(CURRENCY_SUPPORT_MESSAGE);
  const customers = [], invoices = [], errors = []; let found = 0;
  const customer = r => { customers.push({name:text(r.name), email:text(r.email), phone:text(r.phone), guid:text(r.guid), originalId:text(r.masterid)}); };
  const invoice = r => { invoices.push({customer:text(r.customer), number:text(r.number), guid:text(r.guid), originalId:text(r.masterid), issueDate:date(r.date), dueDate:date(r.duedate || r.date), currency:text(r.currency || workspaceCurrency).toUpperCase(), total:text(r.amount).replace(/,/g,'')}); };
  if (/\.csv$/i.test(filename)) {
    const rows = parseCSV(source);
    for (const r of rows) {
      found++;
      const number = r.invoicenumber || r.vouchernumber;
      const type = r.vouchertype || r.vouchertypename;
      if (type && !/^sales$/i.test(type)) continue;
      if (number || Object.hasOwn(r,'invoicenumber') || Object.hasOwn(r,'vouchernumber')) invoice({...r, number, customer:r.customer || r.customername || r.partyledgername || r.particulars, date:r.invoicedate || r.date, duedate:r.duedate, amount:r.totalamount || r.amount || r.debitamount});
      else if (Object.hasOwn(r,'name') || Object.hasOwn(r,'ledgername')) { if (!r.parent || /^sundry debtors$/i.test(r.parent)) customer({...r, name:r.name || r.ledgername}); }
      else throw Error('CSV needs Name/Ledger Name for customers, or Invoice Number/Voucher Number, Customer/Party Ledger Name, Date and Amount for sales.');
    }
  } else {
    const root = xmlTree(source), visit = (node, inVoucher = false) => {
      if (node.name === 'VOUCHER' && inVoucher) throw Error('Nested Tally vouchers are unsupported; export each voucher separately.');
      const get = name => {
        const values = node.children.filter(n => n.name === name);
        if (values.length > 1 || values[0]?.children.length) throw Error(`Ambiguous XML field ${name}.`);
        return values[0]?.value.trim() || '';
      };
      if (node.name === 'LEDGER' || node.name === 'VOUCHER') {
        if (++found > MAX_ROWS) throw Error(`Maximum ${MAX_ROWS} rows per file.`);
        if (node.name === 'LEDGER' && (!get('PARENT') || /^sundry debtors$/i.test(get('PARENT')))) customer({name:node.attrs.NAME || get('NAME'), email:get('EMAIL'), phone:get('LEDGERMOBILE') || get('LEDGERPHONE'), guid:get('GUID'), masterid:get('MASTERID')});
        if (node.name === 'VOUCHER' && !get('VOUCHERTYPENAME') && !node.attrs.VCHTYPE) throw Error('Tally voucher is missing its voucher type.');
        if (node.name === 'VOUCHER' && /^sales$/i.test(get('VOUCHERTYPENAME') || node.attrs.VCHTYPE || '') && !/^yes$/i.test(get('ISCANCELLED')) && !/^yes$/i.test(get('ISOPTIONAL'))) {
          const entries = node.children.filter(n => ['ALLLEDGERENTRIES.LIST','LEDGERENTRIES.LIST'].includes(n.name));
          const party = get('PARTYLEDGERNAME'), partyEntries = entries.filter(n => n.children.some(c => c.name === 'LEDGERNAME' && c.value.trim() === party));
          if (partyEntries.length > 1) throw Error('Sales voucher has multiple party amounts; export a single invoice total.');
          const amounts = partyEntries[0]?.children.filter(n => n.name === 'AMOUNT') || [];
          if (amounts.length > 1 || amounts[0]?.children.length) throw Error('Sales voucher has an ambiguous party amount.');
          const amount = (amounts[0]?.value.trim() || get('AMOUNT')).replace(/,/g,'');
          invoice({customer:party, number:get('VOUCHERNUMBER'), date:get('DATE'), duedate:get('DUEDATE'), currency:get('CURRENCYNAME') || get('CURRENCY'), amount:/^[+-]?\d+(?:\.\d+)?$/.test(amount) ? amount.replace(/^[+-]/,'') : amount, guid:get('GUID'), masterid:get('MASTERID')});
        }
      }
      node.children.forEach(child => visit(child,inVoucher || node.name === 'VOUCHER'));
    }; visit(root);
  }
  for (const [i,c] of customers.entries()) if (!c.name || c.name.length > 200 || /[\x00-\x1f]/.test(c.name) || (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))) errors.push(`Customer ${i+1}: valid name (max 200 characters) and email required when supplied.`);
  for (const [i,v] of invoices.entries()) {
    if (!v.customer || v.customer.length > 200 || /[\x00-\x1f]/.test(v.customer) || !v.number || v.number.length > 100 || /[\x00-\x1f]/.test(v.number) || !v.issueDate || !v.dueDate || v.dueDate < v.issueDate || !/^\d{1,12}(\.\d{1,2})?$/.test(v.total) || Number(v.total) <= 0) errors.push(`Invoice ${i+1}: customer, number, valid dates and positive amount with at most 2 decimals required.`);
    if (!isSupportedCurrency(v.currency)) errors.push(`Invoice ${i+1}: ${CURRENCY_SUPPORT_MESSAGE}`);
    if (v.customer && !customers.some(c => c.name.toLowerCase() === v.customer.toLowerCase())) customer({name:v.customer});
  }
  if (!customers.length && !invoices.length) errors.push('No customer ledgers or sales vouchers found.');
  return {customers,invoices,errors,counts:{customers:customers.length,invoices:invoices.length},samples:{customers:customers.slice(0,5),invoices:invoices.slice(0,5)}};
}
