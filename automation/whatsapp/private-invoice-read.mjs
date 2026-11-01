import {receivablesReadAnswer, receivableBalanceLabel} from '../../invoice/receivables.mjs';

export function invoiceReadQuestion(message) {
  const text=String(message||'').trim();
  if(/\b(?:work[- ]life|balance between)\b/i.test(text))return false;
  if(/^(?:(?:my|our|total|current) )?(?:balances?|outstanding|receivables?)[.!?\s]*$/i.test(text))return true;
  return /^(?:please[ ,]+)?(?:what|who|which|how|show|list|tell|view|read|check|is|are|has|have|did|does|can you show|could you show|menu)\b/i.test(text)
    && /\b(?:invoices?|bills?|balance|outstanding|owes?|owed|owing|unpaid|overdue|receivable)\b/i.test(text)
    && !/\b(?:change|edit|update|set|mark|record|save|log|create|delete|cancel|confirm|send|remind|correct|fix)\b/i.test(text);
}

export function customerInvoiceRows(invoices) {
  return invoices.map(row=>({...row,invoice_number:row.invoiceNumber,customer_name:row.clientName,
    currency:row.currency,status:row.status,total_amount:row.total,amount_paid:row.amountPaid,
    metadata:{...row.metadata,invoice_direction:row.metadata?.invoice_direction||row.direction}}));
}

export function invoiceRowsAnswer(message,result,{history=[]}={}) {
  const unavailable='I could not verify the complete invoice records for that question. Use the invoice menu or specify one invoice.';
  if(result?.ok!==true||result.readOnly!==true||result.truncated!==false||!Array.isArray(result.rows))return unavailable;
  let rows=result.rows;
  const number=String(message).match(/\bINV-[A-Z0-9-]+\b/i)?.[0];
  const customer=String(message).match(/\bhow much does (.+?) owe\b/i)?.[1]
    ||String(message).match(/\b(?:balance|invoices?) for (.+?)[.!?]*$/i)?.[1];
  if(number)rows=rows.filter(row=>[row.invoice_number,row.metadata?.printed_invoice_number,row.metadata?.source_invoice_number]
    .some(value=>String(value||'').toLowerCase()===number.toLowerCase()));
  else if(customer)rows=rows.filter(row=>String(row.customer_name||row.customer?.name||'').toLowerCase()===customer.trim().toLowerCase());
  const nameOf=row=>String(row.customer_name||row.customer?.name||'');
  if(!number&&!customer){
    const names=[...new Set(rows.map(nameOf).filter(Boolean))];
    const mentioned=text=>names.filter(name=>String(text).toLowerCase().includes(name.toLowerCase()));
    let matches=mentioned(message);
    if(!matches.length&&/\b(?:his|her|their|them)\b/i.test(message)){
      for(const turn of [...history].reverse()){
        if(turn.role!=='user')continue;
        matches=mentioned(turn.content);if(matches.length)break;
      }
      if(matches.length!==1)return 'Which customer or invoice should I check?';
    }
    if(matches.length)rows=rows.filter(row=>matches.includes(nameOf(row)));
  }
  if(!rows.length)return 'No matching invoices were found. No changes were made.';
  const balances=receivablesReadAnswer({...result,rows,balanceSummary:undefined,invoiceReadAnalysis:undefined});
  if(!balances)return unavailable;
  if(/\b(?:who|which|status|invoices?|bills?)\b/i.test(message)||number||customer){
    if(rows.length>10)return balances+'\nThere are more than 10 matching invoices. Use the invoice menu or specify a customer.';
    return balances+'\n'+rows.map(row=>`${row.invoice_number}${row.customer_name?` (${row.customer_name})`:''}: ${row.status}; ${receivableBalanceLabel(row)} ${row.currency} ${Math.max(0,Number(row.total_amount)-Number(row.amount_paid||0)).toFixed(2)}.`).join('\n');
  }
  return balances;
}
