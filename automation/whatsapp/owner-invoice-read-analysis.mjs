// Bounded explanations derive money from current scoped reads. They never
// authorize a payment, proposal, refund or change to the ledger.
const clean=value=>String(value||'').normalize('NFKC').replace(/[’‘]/g,"'").trim();
const money=value=>{
  const match=/^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value??''));
  if(!match)return null;
  const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
  return Number.isSafeInteger(cents)?cents:null;
};
const amount=cents=>`${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`;
function explanationTail(tail){
  return !clean(tail).replace(/\b(?:just\s+)?(?:explain|explanation\s+only)\b/gi,'')
    .replace(/\b(?:do not|don't|never)\s+(?:record\s+(?:a|any)\s+payment\s+or\s+)?(?:change\s+anything|record\s+(?:a|any)\s+payment)\b/gi,'')
    .replace(/[.!?;,\s]/g,'');
}
export function ownerInvoiceReadAnalysis(message){
  const text=clean(message);
  if(!text||text.length>1200)return null;
  const scenario=/^(?:what\s+)?if\s+([^,;!?]{1,100}?)\s+(?:pays|paid|were\s+to\s+pay)\s+([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)\s+(?:against|on|for)\s+(?:invoice\s+)?([A-Z0-9][A-Z0-9/-]{1,99})\s*,?\s*(?:how\s+much\s+(?:would\s+be\s+)?(?:overpaid|overpayment)|what\s+would\s+(?:the\s+)?(?:remaining\s+balance|overpayment)\s+be)\s*\?\s*(.*)$/i.exec(text);
  if(scenario&&explanationTail(scenario[5])&&!/\b(?:record|save|change|update|send|refund|reverse|reopen|delete)\b/i.test(scenario[1])){
    const cents=money(scenario[3]);
    if(cents!==null&&cents>0)return {kind:'conditionalPayment',customerName:scenario[1].trim(),currency:scenario[2].toUpperCase(),paymentCents:cents,invoiceNumber:scenario[4]};
  }
  const balances=/^(?:please\s+)?(?:show|list)\s+(?:the\s+)?(?:unpaid|outstanding)\s+balances\s+for\s+(.+?)\s*,?\s*(?:grouped|broken\s+down)\s+by\s+currency[.!?]?\s*(.*)$/i.exec(text);
  if(!balances)return null;
  const tail=balances[2],includeDrafts=/\binclud(?:e|ing)\s+draft\s+invoices\b/i.test(tail);
  const rest=tail.replace(/\binclud(?:e|ing)\s+draft\s+invoices\b/gi,'')
    .replace(/\b(?:and\s+)?keep\s+[A-Z]{3}\s+and\s+[A-Z]{3}\s+separate\b/gi,'')
    .replace(/\b(?:do not|don't|never)\s+change\s+anything(?:\s+or\s+send\s+reminders)?\b/gi,'')
    .replace(/[.!?;,\s]/g,'');
  if(rest)return null;
  const customerNames=balances[1].replace(/,?\s+and\s+/gi,',').split(',').map(clean);
  if(customerNames.length<1||customerNames.length>10||customerNames.some(name=>!name||name.length>100||/[\x00-\x1f]/.test(name))
    ||new Set(customerNames.map(name=>name.toLowerCase())).size!==customerNames.length)return null;
  return {kind:'currencyBalances',customerNames,includeDrafts};
}
export function invoiceReadAnalysisArgs(analysis){
  if(!analysis)return null;
  const filters=analysis.kind==='conditionalPayment'
    ?[{column:'invoice_number',operator:'eq',value:analysis.invoiceNumber},{column:'customer_name',operator:'eq',value:analysis.customerName}]
    :[{column:'customer_name',operator:'in',value:analysis.customerNames},...(analysis.includeDrafts?[]:[{column:'status',operator:'neq',value:'draft'}])];
  return {operation:'read',table:'invoices',columns:['invoice_number','customer_name','currency','total_amount','amount_paid','outstanding_amount','overpayment_amount','status'],filters,limit:50,offset:0};
}
export function deriveInvoiceReadAnalysis(analysis,rows,{truncated=false}={}){
  if(!analysis||!Array.isArray(rows)||truncated)return null;
  const parsed=rows.map(row=>({row,total:money(row.total_amount),paid:money(row.amount_paid)}));
  if(parsed.some(item=>item.total===null||item.paid===null||!/^[A-Z]{3}$/.test(item.row.currency||'')))return null;
  if(analysis.kind==='conditionalPayment'){
    if(parsed.length!==1)return null;
    const {row,total,paid}=parsed[0];
    const aliases=[row.invoice_number,row.metadata?.printed_invoice_number,row.metadata?.source_invoice_number];
    if(row.metadata?.invoice_direction==='payable'||row.currency!==analysis.currency||!aliases.some(value=>String(value||'').toLowerCase()===analysis.invoiceNumber.toLowerCase()))return null;
    const nextPaid=paid+analysis.paymentCents;
    if(!Number.isSafeInteger(nextPaid))return null;
    return {kind:analysis.kind,invoiceNumber:row.invoice_number,requestedInvoiceNumber:analysis.invoiceNumber,currency:row.currency,
      total:amount(total),paid:amount(paid),hypotheticalPayment:amount(analysis.paymentCents),currentOutstanding:amount(Math.max(total-paid,0)),
      resultingOutstanding:amount(Math.max(total-nextPaid,0)),resultingOverpayment:amount(Math.max(nextPaid-total,0)),readOnly:true};
  }
  const expected=new Set(analysis.customerNames.map(name=>name.toLowerCase())),groups=new Map();
  for(const {row,total,paid} of parsed){
    if(row.metadata?.invoice_direction==='payable')continue;
    if(!expected.has(clean(row.customer?.name||row.customer?.[0]?.name||row.customer_name).toLowerCase()))return null;
    const sum=(groups.get(row.currency)||0)+Math.max(total-paid,0);
    if(!Number.isSafeInteger(sum))return null;
    groups.set(row.currency,sum);
  }
  return {kind:analysis.kind,readOnly:true,complete:true,invoiceCount:rows.length,includesDrafts:analysis.includeDrafts,
    groups:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([currency,cents])=>({currency,outstanding:amount(cents)}))};
}
export function invoiceReadAnalysisReply(result){
  if(result?.ok!==true||result.readOnly!==true||result.operation!=='read'||result.table!=='invoices'||result.truncated===true)return null;
  const a=result.invoiceReadAnalysis;
  if(a?.readOnly!==true)return null;
  if(a.kind==='conditionalPayment')return `For invoice ${a.invoiceNumber}, the current outstanding balance is ${a.currency} ${a.currentOutstanding}. If an additional ${a.currency} ${a.hypotheticalPayment} were paid, the overpayment would be ${a.currency} ${a.resultingOverpayment} and the remaining balance would be ${a.currency} ${a.resultingOutstanding}. This is an explanation only. No changes were made.`;
  if(a.kind==='currencyBalances'&&a.complete===true)return a.groups.length
    ?`Outstanding balances for the requested customers${a.includesDrafts?', including draft invoices':''}:\n${a.groups.map(group=>`${group.currency} ${group.outstanding}`).join('\n')}\nCurrencies are kept separate. No changes were made.`
    :'No outstanding receivable balances were found for the requested customers. No changes were made.';
  return null;
}
