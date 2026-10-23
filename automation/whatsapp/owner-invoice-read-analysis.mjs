import {receivableKind,summarizeReceivables,receivablesAnswer,isOutstandingBalanceQuestion} from '../../invoice/receivables.mjs';
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
  if(isOutstandingBalanceQuestion(text))return {kind:'outstandingSummary'};
  if(/^how\s+many\s+(?:(?:unpaid|outstanding)\s+invoices|invoices\s+are\s+(?:unpaid|outstanding))[.!?]?$/i.test(text))
    return {kind:'unpaidInvoices',includeDrafts:true,countOnly:true};
  if(/^(?:now\s+)?(?:please\s+)?(?:show|list)(?:\s+me)?(?:\s+(?:my|our|the))?\s+(?:unpaid|outstanding)\s+invoices[.!?]?$/i.test(text))
    return {kind:'unpaidInvoices',includeDrafts:true};
  const globalUnpaid=/^(?:now\s+)?(?:please\s+)?(?:show|list)(?:\s+me)?\s+all\s+(?:unpaid|outstanding)\s+invoices\b(.*)$/i.exec(text);
  if(globalUnpaid){
    const tail=globalUnpaid[1];
    const hasGlobalScope=/\b(?:across|for)\s+all\s+customers\b/i.test(tail);
    const rest=tail.replace(/\b(?:across|for)\s+all\s+customers\b/gi,'')
      .replace(/\bincluding\s+drafts?\b/gi,'')
      .replace(/\bdo\s+not\s+change\s+anything\b/gi,'')
      .replace(/[.!?;,\s]/g,'');
    if(hasGlobalScope&&!rest)return {kind:'unpaidInvoices',includeDrafts:true};
  }
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
export function ownerHypotheticalOverpayment(message){
  const text=clean(message);
  if(!text||text.length>1200)return null;
  const match=/^if\s+(?:a\s+customer|someone)\s+(?:pays|paid|were\s+to\s+pay)\s+([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)\s+on\s+an?\s+invoice\s+for\s+([A-Z]{3})\s+(\d{1,12}(?:\.\d{1,2})?)\s*,?\s*how\s+much\s+(?:(?:is|would\s+be)\s+)?overpaid\s*\?\s*(.*)$/i.exec(text);
  if(!match||!explanationTail(match[5])||match[1].toUpperCase()!==match[3].toUpperCase())return null;
  const payment=money(match[2]),invoiceTotal=money(match[4]);
  if(payment===null||invoiceTotal===null||payment<=0||invoiceTotal<=0)return null;
  return {currency:match[1].toUpperCase(),paymentCents:payment,invoiceTotalCents:invoiceTotal,
    overpaymentCents:Math.max(payment-invoiceTotal,0)};
}
export function invoiceReadAnalysisArgs(analysis){
  if(!analysis)return null;
  const filters=analysis.kind==='outstandingSummary'?[]:analysis.kind==='conditionalPayment'
    ?[{column:'invoice_number',operator:'eq',value:analysis.invoiceNumber},{column:'customer_name',operator:'eq',value:analysis.customerName}]
    :analysis.kind==='unpaidInvoices'
    ?[{column:'status',operator:'in',value:['draft','sent','overdue']}]
    :[{column:'customer_name',operator:'in',value:analysis.customerNames}];
  return {operation:'read',table:'invoices',columns:['invoice_number','customer_name','currency','total_amount','amount_paid','outstanding_amount','overpayment_amount','status'],filters,limit:50,offset:0};
}
export function deriveInvoiceReadAnalysis(analysis,rows,{truncated=false}={}){
  if(!analysis||!Array.isArray(rows)||truncated)return null;
  const parsed=rows.map(row=>({row,total:money(row.total_amount),paid:money(row.amount_paid)}));
  if(parsed.some(item=>item.total===null||item.paid===null||!/^[A-Z]{3}$/.test(item.row.currency||'')))return null;
  if(analysis.kind==='outstandingSummary')return {kind:analysis.kind,readOnly:true,complete:true,balanceSummary:summarizeReceivables(rows)};
  if(analysis.kind==='unpaidInvoices'){
    if(parsed.some(({row})=>!['draft','sent','overdue'].includes(row.status)||typeof row.invoice_number!=='string'||!row.invoice_number))return null;
    const invoices=parsed.filter(({row,total,paid})=>row.metadata?.invoice_direction!=='payable'&&paid<total)
      .map(({row,total,paid})=>({invoiceNumber:row.invoice_number,customerName:clean(row.customer?.name||row.customer?.[0]?.name||row.customer_name),
        currency:row.currency,total:amount(total),paid:amount(paid),outstanding:amount(total-paid),status:row.status,
        direction:row.metadata?.invoice_direction==='payable'?'payable':'receivable'}));
    return {kind:analysis.kind,readOnly:true,complete:true,invoices,balanceSummary:summarizeReceivables(rows),includesDrafts:invoices.some(row=>row.status==='draft'),...(analysis.countOnly?{countOnly:true}:{})};
  }
  if(analysis.kind==='conditionalPayment'){
    if(parsed.length!==1)return null;
    const {row,total,paid}=parsed[0];
    const aliases=[row.invoice_number,row.metadata?.printed_invoice_number,row.metadata?.source_invoice_number];
    if(row.metadata?.invoice_direction==='payable'||row.currency!==analysis.currency||!aliases.some(value=>String(value||'').toLowerCase()===analysis.invoiceNumber.toLowerCase()))return null;
    const nextPaid=paid+analysis.paymentCents;
    if(!Number.isSafeInteger(nextPaid))return null;
    return {kind:analysis.kind,invoiceNumber:row.invoice_number,requestedInvoiceNumber:analysis.invoiceNumber,currency:row.currency,
      total:amount(total),paid:amount(paid),unissuedDraft:receivableKind(row)==='draft',hypotheticalPayment:amount(analysis.paymentCents),currentOutstanding:amount(Math.max(total-paid,0)),
      resultingOutstanding:amount(Math.max(total-nextPaid,0)),resultingOverpayment:amount(Math.max(nextPaid-total,0)),readOnly:true};
  }
  const expected=new Set(analysis.customerNames.map(name=>name.toLowerCase()));
  for(const {row} of parsed){
    if(row.metadata?.invoice_direction==='payable')continue;
    if(!expected.has(clean(row.customer?.name||row.customer?.[0]?.name||row.customer_name).toLowerCase()))return null;
  }
  const balanceSummary=summarizeReceivables(rows);
  return {kind:analysis.kind,readOnly:true,complete:true,invoiceCount:rows.length,includesDrafts:Object.keys(balanceSummary.draftBalancesByCurrency).length>0,
    balanceSummary,groups:Object.entries(balanceSummary.currencies).map(([currency,row])=>({currency,outstanding:row.outstandingAmount}))};
}
export function invoiceReadAnalysisReply(result){
  if(result?.ok!==true||result.readOnly!==true||result.operation!=='read'||result.table!=='invoices'||result.truncated===true)return null;
  const a=result.invoiceReadAnalysis;
  if(a?.readOnly!==true)return null;
  if(a.kind==='outstandingSummary'&&a.complete===true)return receivablesAnswer(a.balanceSummary);
  if(a.kind==='unpaidInvoices'&&a.complete===true){
    if(!a.invoices.length)return 'No unpaid invoices were found. Would you like to see all invoices? No changes were made.';
    if(a.countOnly)return receivablesAnswer(a.balanceSummary,{countOnly:true});
    let answer=receivablesAnswer(a.balanceSummary)+'\nInvoices (drafts labelled separately):';
    let shown=0;
    for(const row of a.invoices){
      const tags=[...(row.status==='draft'?['unissued draft; not yet receivable']:[]),...(row.direction==='payable'?['payable']:[])];
      const line=`\n${row.invoiceNumber}${row.customerName?` (${row.customerName})`:''}: ${row.currency} ${row.outstanding}${tags.length?` (${tags.join(', ')})`:''}`;
      if(answer.length+line.length>850)break;
      answer+=line;shown++;
    }
    return answer+(shown<a.invoices.length?`\nShowing ${shown} of ${a.invoices.length}. Ask about a specific customer for the rest.`:'')+'\nNo changes were made.';
  }
  if(a.kind==='conditionalPayment')return `For invoice ${a.invoiceNumber}, the current ${a.unissuedDraft?'unissued draft balance (not yet receivable)':'issued outstanding balance'} is ${a.currency} ${a.currentOutstanding}. If an additional ${a.currency} ${a.hypotheticalPayment} were paid, the overpayment would be ${a.currency} ${a.resultingOverpayment} and the remaining balance would be ${a.currency} ${a.resultingOutstanding}. This is an explanation only. No changes were made.`;
  if(a.kind==='currencyBalances'&&a.complete===true)return receivablesAnswer(a.balanceSummary)+'\nCurrencies are kept separate. No changes were made.';
  return null;
}
