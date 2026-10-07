// Output safety: an assistant sentence is not a database receipt.
const COMPLETION = /\b(?:deleted|removed|created|saved|updated|changed|restored|reopened|reversed|recorded|sent|cancelled|canceled|reset|completed|marked[^.!?]{0,24}paid)\b/i;
const NEGATIVE = /\b(?:not|never|cannot|can't|couldn't|could not|haven't|hasn't|wasn't|weren't|didn't|did not|unable|failed|pending|propos(?:al|ed)|would|will|can|could|should|if|once|before|after|to be|to delete|to update|to change|to send)\b/i;
const NO_RESULT = /\b(?:nothing|no (?:invoice|payment|record|file|change|action))\s+(?:was|were|has been|have been|is|has)\s+(?:saved|logged|created|recorded|changed|updated|sent|applied|completed)\b/gi;
const COMMITTED = new Set(['deleted','restored','invoice_created','settings_updated','customer_created','customer_updated','customer_deleted','updated','created','paid','cancelled','canceled','review_updated']);
const COMMITTED_TYPES=new Set(['owner_invoice_update','owner_invoice_payment','owner_invoice_create','owner_settings_update','owner_workspace_data_confirmed','owner_workspace_data_cancelled']);
const normalize=value=>String(value||'').replace(/[\u201c\u201d]/g,'"').replace(/\u2019/g,"'");
function actionMatches(clause, result) {
  const action=String(result.action||result.actionType||result.operation||'');
  const entity=String(result.entityType||result.table||action);
  const identifiers=[...clause.matchAll(/\bINV[-/][A-Z0-9][A-Z0-9/-]*/gi)].map(match=>match[0].toLowerCase());
  if(identifiers.some(id=>!JSON.stringify(result).toLowerCase().includes(id)))return false;
  if(result.action==='batch.completed'&&Array.isArray(result.results))return result.results.length>=2
    &&result.results.every(child=>completedOwnerResult(child)&&actionMatches(clause.replace(/\bINV[-/][A-Z0-9][A-Z0-9/-]*/gi,''),child));
  if(/\bcustomer\b/i.test(clause)&&!/\b(?:invoice|payment)\b/i.test(clause)&&!/customer/.test(entity))return false;
  if(/\bcustomer (?:record|details|update|change)\b/i.test(clause)&&!/customer/.test(entity))return false;
  if(/\binvoice (?:record|details|update|change|deletion|payment)\b/i.test(clause)&&!/invoice|review/.test(entity))return false;
  if(/\b(?:settings|preferences|primary model|fallback model)\b/i.test(clause)&&!/settings/.test(entity))return false;
  if(/\b(?:cancelled|canceled)\b/i.test(clause))return /cancel/.test(action);
  if(/\b(?:deleted|removed|deletion)\b/i.test(clause))return /delet/.test(action)||Boolean(result.record?.deleted_at);
  if(/\b(?:created|creation)\b/i.test(clause))return /creat/.test(action)||result.outcome==='saved';
  if(/\b(?:reopened|reversed|marked[^.!?]{0,24}unpaid)\b/i.test(clause))return action==='invoice.reopened';
  if(/\b(?:restored|restoration)\b/i.test(clause))return /restor/.test(action);
  const paymentBusinessText=/\bpayment (?:instructions?|information|info)\b/i.test(clause);
  if(paymentBusinessText&&(!/updat|change|confirmed/.test(action)
    ||!(Object.hasOwn(result.record||{},'payment_information')||Object.hasOwn(result.record?.custom_fields||{},'payment_information'))))return false;
  const financialClause=clause.replace(/\bpayment (?:instructions?|information|info)\b/gi,'');
  if(/\b(?:marked[^.!?]{0,24}paid|recorded[^.!?]{0,24}payment|payment)\b/i.test(financialClause))return /paid|payment|reopened/.test(action);
  if(paymentBusinessText)return true;
  if(/\b(?:updated|changed|update|change)\b/i.test(clause))return /updat|change|confirmed|reopened/.test(action);
  return true;
}
function numericEvidence(results) {
  const values=new Set();
  const add=value=>{if((typeof value==='number'||typeof value==='string'&&/^-?\d[\d,]*(?:\.\d+)?$/.test(value))&&Number.isFinite(Number(String(value).replaceAll(',',''))))values.add(Number(String(value).replaceAll(',','')).toFixed(2));};
  const visit=value=>{
    if(Array.isArray(value)){
      const sums={};
      for(const row of value){visit(row);if(row&&typeof row==='object')for(const [key,amount] of Object.entries(row))if(/amount|total|balance|paid|remaining/i.test(key)&&Number.isFinite(Number(amount)))sums[key]=(sums[key]||0)+Number(amount);}
      for(const sum of Object.values(sums))add(sum);
      if(sums.total_amount!==undefined)add(sums.total_amount-(sums.amount_paid||0));
    }else if(value&&typeof value==='object'){
      for(const item of Object.values(value))visit(item);
      if(value.total_amount!==undefined&&Number.isFinite(Number(value.total_amount)))add(Number(value.total_amount)-Number(value.amount_paid||0));
    }else add(value);
  };
  for(const result of results)visit(result);
  return values;
}
export function completedOwnerResult(result){
  return result?.ok===true && result?.proposal!==true && result?.requiresConfirmation!==true
    && (result.completed===true||COMMITTED.has(result.action)||COMMITTED_TYPES.has(result.actionType));
}
export function ownerEvidence(transcript=[],requirement=null){
  const evidence=transcript.filter(item=>item.role==='tool').flatMap(item=>{
    try{const value=JSON.parse(item.content);return value&&typeof value==='object'?[value]:[];}catch{return [];}
  });
  if(requirement?.requiredFacts&&Object.keys(requirement.requiredFacts).length)evidence.push({ok:true,readOnly:true,details:requirement.requiredFacts});
  return evidence;
}
// This capability comes from the outgoing payload, never a model tool result.
export function ownerButtonClaimIssue(reply,{buttonsAvailable=false}={}){
  if(buttonsAvailable)return null;
  const clauses=normalize(reply).split(/[.!?\n]+/);
  return clauses.some(clause=>/\bbuttons?\b/i.test(clause)
    && !/\b(?:no|not|cannot|can't|couldn't|unavailable|missing|without)\b/i.test(clause)
    && /\b(?:tap|press|click|select|choose|use|attached|below|provided|created|added)\b/i.test(clause))
    ?'unverified_buttons':null;
}
export function ownerGroundingIssue(reply,results=[],message='',capabilities={}){
  results=results.flatMap(result=>result?.ok===true&&result.completed===true&&result.action==='batch.completed'&&Array.isArray(result.results)
    &&result.results.every(child=>child?.ok===true&&child.completed===true)?[result,...result.results]:[result]);
  const text=normalize(reply);
  if(/\b(?:i(?:'m| am) still (?:working|processing)|i(?:'ll| will) (?:message|notify|let you know)|working on (?:it|that|this) now)\b/i.test(text)
    &&!results.some(result=>result?.ok===true&&result.durableJob===true&&result.queued===true))return 'unverified_background_job';
  if(results.some(result=>result.cashRefund===false)&&text.split(/[.!?\n]+/).some(clause=>/\b(?:refunded|sent[^.!?]{0,25}refund|refund[^.!?]{0,25}(?:sent|processed|issued))\b/i.test(clause)&&!NEGATIVE.test(clause)&&!/\bno\b/i.test(clause)))return 'unverified_refund';
  const buttonIssue=ownerButtonClaimIssue(text,capabilities);
  if(buttonIssue)return buttonIssue;
  const proposalClaims=text.split(/[.!?\n]+/).filter(clause=>
    /\b(?:submitted|created|prepared|proposed)\b[^.!?]{0,65}\b(?:request|proposal|deletion|change)\b/i.test(clause)
    || /\b(?:awaiting|waiting for|needs?|requires?)\b[^.!?]{0,35}\b(?:confirmation|approval)\b/i.test(clause)
    || /^\s*(?:please )?(?:confirm|approve)\b[^.!?]{0,35}\b(?:change|update|payment|invoice|this|it)\b/i.test(clause)
    || /\b(?:confirm|approve|cancel|review)\b[^.!?]{0,40}\bpending (?:action|proposal|change|request)\b/i.test(clause));
  const verifiedProposal=results.some(result=>result.ok!==false&&(result.pending===true||result.proposal===true||result.requiresConfirmation===true));
  const verifiedPendingBlock=results.some(result=>result.ok===false&&result.code==='PENDING');
  if(proposalClaims.some(clause=>!/\b(?:not|cannot|can't|couldn't|failed|unable|no)\b/i.test(clause)
    &&!verifiedProposal&&!(verifiedPendingBlock&&/\bpending (?:action|proposal|change|request)\b/i.test(clause)
      &&!/\b(?:submitted|created|prepared|proposed)\b/i.test(clause))))return 'unverified_proposal';
  const completed=results.filter(completedOwnerResult);
  if(!completed.length&&(/^(?:done|all done|completed|all set)[.!\s]*$/i.test(text)
    ||/\b(?:the|your|requested) (?:change|deletion|update|payment|action) (?:is|was|has been) (?:now )?(?:complete|completed|confirmed|successful)\b/i.test(text)
    ||/\bI (?:have )?confirmed (?:the |that )?(?:deletion|payment|change)\b/i.test(text)))return 'unverified_action_result';
  // Check each sentence independently: a negative sentence cannot excuse a
  // different unsupported success claim in the same reply.
  const claims=text.split(/[.!?\n]+/).map(part=>part.replace(NO_RESULT,''))
    .filter(part=>COMPLETION.test(part)&&!NEGATIVE.test(part)
    &&(!/\bcompleted\b/i.test(part)||/\b(?:update|change|deletion|payment|creation|restoration|action)\b/i.test(part))
    &&(/^\s*(?:deleted|removed|created|saved|updated|changed|restored|reopened|reversed|recorded|sent|cancelled|canceled|reset)\b/i.test(part)
      ||/\b(?:I|we|I've|we've)\s+(?:(?:have|already|now|successfully|just|also)\s+)*(?:deleted|removed|created|saved|updated|changed|restored|reopened|reversed|recorded|sent|cancelled|canceled|reset|marked|completed)\b/i.test(part)
      ||/\b(?:has|have|was|were|now|successfully)\b[^.!?]{0,35}\b(?:deleted|removed|created|saved|updated|changed|restored|recorded|sent|cancelled|canceled|completed|marked)\b/i.test(part)
      ||/\bis (?:now )?marked(?: as)? paid\b/i.test(part)));
  for(const clause of claims){
    const match=clause.match(COMPLETION)?.[0]?.toLowerCase();
    if(!completed.length)return 'unverified_action_result';
    if(!completed.some(result=>actionMatches(clause,result)))return 'unverified_action_result';
    if(/deleted|removed/.test(match)&&!completed.some(r=>['deleted','invoice.deleted','customer.deleted'].includes(r.action)||r.operation==='delete'||r.record?.deleted_at))return 'unverified_action_result';
    if(/created/.test(match)&&!completed.some(r=>r.outcome==='saved'||/creat/.test(r.action||'')||r.operation==='create'))return 'unverified_action_result';
    if(/restored/.test(match)&&!completed.some(r=>['restored','invoice.restored'].includes(r.action)||r.operation==='restore'))return 'unverified_action_result';
    if(/sent/.test(match)&&!completed.some(r=>r.deliveryStatus==='accepted'||r.action==='sent'))return 'unverified_delivery';
    if(/reset/.test(match)&&!completed.some(r=>r.action==='memory_reset'))return 'unverified_action_result';
  }
  const success=results.filter(r=>r.ok!==false);
  // amount_paid is the current net allocation. A full reversal can make it
  // zero while the immutable original receipt still exists.
  const zeroInvoiceBalance=success.some(result=>result.table==='invoices'&&result.readOnly===true
    &&Array.isArray(result.rows)&&result.rows.some(row=>row.amount_paid!==null&&row.amount_paid!==undefined&&Number(row.amount_paid)===0));
  const absentPaymentHistory=/\b(?:no payments?\b[^.!?\n]{0,35}\b(?:made|received|recorded|history)|no (?:payment history|payment records?)\b|payment (?:history|records?)\b[^.!?\n]{0,20}\b(?:empty|absent)|never (?:been )?paid)\b/i.test(text);
  if(zeroInvoiceBalance&&absentPaymentHistory)return 'fresh_database_read_required';
  const numbers=numericEvidence(success);
  const amounts=[...text.matchAll(/(?:[$€£₹]|\b(?:USD|INR|EUR|GBP|CHF|AED|SGD|AUD|CAD))\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:USD|INR|EUR|GBP|CHF|AED|SGD|AUD|CAD)\b/gi)];
  if(amounts.some(match=>!numbers.has(Number((match[1]||match[2]).replaceAll(',','')).toFixed(2))))return 'fresh_database_read_required';
  const source=JSON.stringify(results)+String(message||'');
  const ids=[...text.matchAll(/\bINV[-/][A-Z0-9][A-Z0-9/-]*/gi)].map(m=>m[0]);
  const attachmentNotSaved=results.some(result=>result?.ok===false&&result?.review&&result?.outcome==='not_saved');
  const contextualInvoiceAbsence=attachmentNotSaved
    &&/\b(?:could not|couldn't|cannot|can't|unable to)\s+(?:find|locate)\s+it\b/i.test(text);
  const invoiceAbsence=contextualInvoiceAbsence||/\b(?:(?:could not|couldn't|cannot|can't|unable to)\s+(?:find|locate)\s+(?:(?:the|that|this|an?|any|matching)\s+)?(?:invoice\b|INV[-/])|no matching invoices?\b|invoices?[^.!?\n]{0,65}(?:not found|does not exist|doesn't exist))/i.test(text);
  if(invoiceAbsence){
    const reads=results.filter(result=>result?.table==='invoices'&&result?.operation==='read'
      &&(!ids.length||ids.every(id=>id.toLowerCase()===String(result.lookupInvoiceNumber||'').toLowerCase())));
    const present=success.some(result=>Array.isArray(result.rows)&&result.rows.some(row=>row?.invoice_number
      &&(!ids.length||ids.some(id=>id.toLowerCase()===String(row.invoice_number).toLowerCase()))));
    const checkedAbsence=reads.some(result=>result.ok===false&&result.code==='NOT_FOUND'
      ||result.ok===true&&result.readOnly===true&&Array.isArray(result.rows)&&!result.rows.length&&result.truncated!==true);
    if(present||!checkedAbsence)return 'fresh_database_read_required';
  }
  // Conversation history can resolve a reference, but cannot prove current data.
  if(ids.some(id=>!source.toLowerCase().includes(id.toLowerCase()))
    &&!(/\b(?:which|clarify|mean|could not|couldn't|cannot|can't|unable|not found|no matching)\b/i.test(text)))return 'fresh_database_read_required';
  if(/(?:[$€£₹]\s*\d|\b(?:USD|INR|EUR|GBP|CHF)\s*[\d,]|[\d,]+(?:\.\d+)?\s*(?:USD|INR|EUR|GBP|CHF)\b)/i.test(text)
    &&!success.some(r=>r.readOnly===true||r.rows||r.invoices||completedOwnerResult(r)||r.proposal||r.requiresConfirmation||r.analysisOnly||r.fields||r.invoice||r.invoiceNumber||r.review||r.details))return 'fresh_database_read_required';
  return null;
}
