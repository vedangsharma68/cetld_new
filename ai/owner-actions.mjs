import {redactInternalIds} from './assistant.mjs';
import {randomUUID} from 'node:crypto';
import {APIError,object} from './http.mjs';
import {createAssistantTools,cents} from './tools.mjs';
import {ownerReminderRequest,ownerReminderFailure,prepareOwnerReminderContent} from '../automation/whatsapp/owner-reminders.mjs';
import {requestedOwnerPayment,ownerPaymentAmountMentioned} from '../automation/whatsapp/owner-payment-intent.mjs';
import {parseInvoiceCorrection} from '../automation/whatsapp/assistant-handler.mjs';
import {validateInvoiceCorrection,requestedOwnerInvoiceTotalChange,invoiceTotalCorrectionValues} from '../automation/whatsapp/invoice-corrections.mjs';
import {invoiceBusinessFields} from '../invoice/business-fields.mjs';

const labels={tone:'Tone',maxReminders:'Maximum reminders',cadenceDays:'Days between reminders',firstReminderDays:'Days after due date for first reminder',contactStart:'Contact start',contactEnd:'Contact end',allowedWeekdays:'Contact weekdays (Sunday = 0)',pauseOnReply:'Pause on customer reply',dailySummary:'Daily summary'};
const patchFields=['tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd','allowedWeekdays','pauseOnReply','dailySummary'];
export function validateOwnerSchedulePatch(value,current={}) {
  object(value,patchFields);
  if(!Object.keys(value).length)throw new APIError(400,'INVALID_SCHEDULE');
  for(const [key,v] of Object.entries(value)) {
    if(key==='tone'&&!['gentle','professional','firm'].includes(v)
      ||['maxReminders','cadenceDays','firstReminderDays'].includes(key)&&(!Number.isInteger(v)||v<(key==='firstReminderDays'?0:1)||v>(key==='maxReminders'?20:90))
      ||['contactStart','contactEnd'].includes(key)&&(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
      ||['pauseOnReply','dailySummary'].includes(key)&&typeof v!=='boolean'
      ||key==='allowedWeekdays'&&(!Array.isArray(v)||!v.length||v.length>7||v.some(d=>!Number.isInteger(d)||d<0||d>6)))throw new APIError(400,'INVALID_SCHEDULE');
  }
  const merged={...current,...value};
  if((merged.contactStart||'00:00')>=(merged.contactEnd||'23:59'))throw new APIError(400,'INVALID_SCHEDULE');
  return value;
}
const definition={type:'function',function:{name:'ownerAction',description:'Prepare an owner action, always requiring a later confirmation. Read or update follow-up schedules, preview/approve reminders or queue send-now, record an explicitly instructed payment, or correct invoice fields. Never send or write during preparation.',parameters:{type:'object',properties:{operation:{type:'string',enum:['previewReminder','sendReminderNow','recordPayment','readSchedule','updateSchedule','correctInvoice']},target:{type:'string',maxLength:160},patch:{type:'object'},values:{type:'object'}},required:['operation'],additionalProperties:false}}};
const decision=/^\s*(yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$/i;
export function ownerActionDecision(message){const match=decision.exec(message);return match? !/^(no|cancel|never mind|nevermind|discard)$/i.test(match[1]):null;}
export function ownerActionFailure(result) {
  if(result?.answer)return result.answer;
  if(['missing_contact','missing_consent','revoked','suppressed','globally_suppressed','ineligible_invoice','contact_hours','reminder_limit','template_unavailable','delivery_in_progress','payment_audit_mismatch','payment_balance_mismatch','external_accounting_required','unresolved_exception','business_name_required'].includes(result?.code))return ownerReminderFailure(result.code).message;
  return ({STALE:'The invoice or settings changed. Request a fresh proposal before confirming.',EXPIRED:'That proposal expired. Request a fresh proposal.',NO_PENDING_ACTION:'There is no pending action to confirm. Nothing was changed.',PENDING:'Finish or cancel the pending action first.',INVALID_PAYMENT:'I could not verify that payment instruction. No payment was recorded.',EXTERNAL_ACCOUNTING:'Change financial details in your connected accounting ledger, then sync.',INVALID_TOTAL:'Provide the corrected subtotal, tax and line items so they agree with the total.'})[result?.code]||'I could not safely complete that action. No change was confirmed. Check the current details and try again.';
}

export function createOwnerAssistantActions({store,conversation=store.ownerConversation,clock=()=>new Date(),proof={}}) {
  const tools=createAssistantTools({store,clock});
  const result=answer=>({answer:redactInternalIds(answer),pendingAction:null,readOnly:true});
  async function resolve(target){
    if(typeof target!=='string'||!target.trim()||target.length>160)throw new APIError(400,'INVOICE_TARGET_REQUIRED');
    const found=await tools.lookupInvoice(target.trim());
    if(found.truncated||found.invoices.length!==1)return {answer:found.invoices.length?'More than one invoice matches. Which invoice number should I use?':'I could not find that invoice in your business.'};
    const row=(await store.query('invoices',{select:'*',filters:{id:`eq.${found.invoices[0].id}`},limit:1}))[0];
    if(!row||row.deleted_at)return {answer:'I could not find that invoice in your business.'};
    return {row};
  }
  async function propose(type,payload,answer,message){
    answer=redactInternalIds(answer);
    const pending=await conversation.pending();
    const legacy=(await conversation.read()).some(t=>['create_invoice','update_invoice'].includes(t.pending_action?.type)&&(!t.pending_action.status||t.pending_action.status==='pending')&&Date.parse(t.pending_action.expiresAt)>clock().getTime());
    if(pending||legacy)return result(ownerActionFailure({code:'PENDING'}));
    const id=randomUUID();
    const stored=await conversation.propose({id,type,payload,instruction:message,summary:answer});
    if(!stored?.id)return result(ownerActionFailure(stored));
    return {answer:answer+'\n\nConfirm to apply, or cancel. Nothing has changed yet.',pendingAction:{type,proposalId:id,payload:{proposalId:id},status:'pending'},readOnly:true};
  }
  async function execute(args,message){
    object(args,['operation','target','patch','values']);
    if(args.operation==='readSchedule'){
      const s=await store.getOwnerAssistantSettings();
      const p=s?.follow_up_preferences||{};
      return result(`Follow-up schedule (${s?.default_timezone||'Asia/Kolkata'}):\n${Object.entries(p).filter(([k])=>patchFields.includes(k)).map(([k,v])=>`${labels[k]}: ${Array.isArray(v)?v.join(', '):v}`).join('\n')||'Default schedule.'}`);
    }
    if(args.operation==='updateSchedule'){
      const s=await store.getOwnerAssistantSettings();
      const patch=validateOwnerSchedulePatch(args.patch,s?.follow_up_preferences);
      return propose('owner_schedule',{patch,updatedAt:s.updated_at},'Change follow-up schedule:\n'+Object.entries(patch).map(([k,v])=>`${labels[k]}: ${s.follow_up_preferences?.[k]??'default'} → ${v}`).join('\n'),message);
    }
    if(args.operation==='recordPayment'){
      const payment=requestedOwnerPayment(message);
      if(!payment)return result('Give the exact currency, amount and invoice, for example “record USD 25 payment for invoice INV-001”. No payment was recorded.');
      const found=await resolve(payment.invoiceNumber);if(found.answer)return result(found.answer);
      const i=found.row;
      if(i.currency!==payment.currency||i.metadata?.invoice_direction!=='receivable'||i.external_provider||i.external_invoice_id||['paid','void','cancelled'].includes(i.status)||cents(i.total_amount)-cents(i.amount_paid)<cents(payment.amount))return result('That payment does not match an eligible unpaid receivable invoice. Check its currency, balance and accounting connection. No payment was recorded.');
      return propose('owner_payment',{invoiceId:i.id,updatedAt:i.updated_at,amount:payment.amount},`Record ${payment.currency} ${payment.amount.toFixed(2)} received against ${i.invoice_number}?`,message);
    }
    if(!['previewReminder','sendReminderNow','correctInvoice'].includes(args.operation))throw new APIError(400,'INVALID_OWNER_ACTION');
    const found=await resolve(args.target);if(found.answer)return result(found.answer);const i=found.row;
    if(args.operation==='correctInvoice'){
      let values=validateInvoiceCorrection(args.values);
      const totalIntent=requestedOwnerInvoiceTotalChange(message);
      if(totalIntent||Object.keys(values).every(k=>['total_amount','currency'].includes(k))&&values.total_amount!==undefined){const correction=invoiceTotalCorrectionValues(totalIntent||{currency:values.currency||i.currency,totalAmount:values.total_amount,retainedPayment:null,zeroTax:false},{...i,...invoiceBusinessFields(i)});if(!correction.ok)return result(correction.message);values=correction.values;}
      const shown={...values};
      if(values.customer_id){const customer=(await store.query('customers',{select:'id,name',filters:{id:`eq.${values.customer_id}`},limit:1}))[0];if(!customer)return result('I could not find that customer in your business.');shown.customer_id=customer.name;}
      const fieldLabels={customer_id:'Customer',total_amount:'Total',issue_date:'Invoice date',due_date:'Due date',line_items:'Line items',custom_fields:'Business fields'};
      return propose('owner_correction',{invoiceId:i.id,updatedAt:i.updated_at,values},`Correct ${i.invoice_number}:\n`+Object.entries(shown).map(([k,v])=>`${fieldLabels[k]||k.replaceAll('_',' ')}: ${Array.isArray(v)?v.map(item=>`${item.description}: ${item.quantity??''} × ${item.unitPrice??''}, amount ${item.amount}`).join('; '):v===null?'clear':typeof v==='object'?Object.entries(v).map(([name,value])=>`${name}: ${value}`).join('; '):v}`).join('\n'),message);
    }
    const s=await store.getOwnerAssistantSettings();
    const customer=(await store.query('customers',{select:'id,name,phone,reminder_tone',filters:{id:`eq.${i.customer_id}`},limit:1}))[0];
    if(!customer?.phone)return result(ownerReminderFailure('missing_contact').message);
    // The SQL gate compares this exact customer projection against its locked row.
    const {id,name,phone,reminder_tone=null}=customer;
    let payload;try{payload={...prepareOwnerReminderContent({invoice:i,settings:s,customer:{id,name,phone,reminder_tone}}),sendNow:args.operation==='sendReminderNow'};}catch{return result(ownerReminderFailure('template_unavailable').message);}
    const checked=await store.ownerAssistantRPC('owner_assistant_preview_reminder',{p_payload:payload});
    if(checked?.ok!==true)return result(ownerActionFailure(checked));
    return propose('owner_reminder',payload,`Reminder preview for ${i.invoice_number}:\nDelivery form: approved WhatsApp template.\n\n${payload.preview}\n\n${payload.sendNow?'Approval will queue this reminder for the scheduler. It has not been sent.':'Approval will save this reminder draft. It has not been sent.'}`,message);
  }
  return {definition,execute,
    async invoiceUpdate(args,message){
      if(Object.hasOwn(args.changes||{},'status'))return null;
      const names={total:'total_amount',dueDate:'due_date',invoiceDate:'issue_date',currency:'currency',notes:'notes',clientName:'customer_name'};
      if(Object.keys(args.changes||{}).some(k=>!names[k]))throw new APIError(400,'INVALID_INVOICE_CHANGES');
      const values=Object.fromEntries(Object.entries(args.changes||{}).map(([k,v])=>[names[k],v]));
      if(values.customer_name){const customers=await store.query('customers',{select:'id,name',filters:{name:`eq.${values.customer_name}`},limit:2});if(customers.length!==1)return result(customers.length?'More than one customer matches. Provide their exact invoice or contact details.':'I could not find that customer in your business.');values.customer_id=customers[0].id;delete values.customer_name;}
      return execute({operation:'correctInvoice',target:args.target,values},message);
    },
    async handle(message){
      const confirmed=ownerActionDecision(message);
      if(confirmed!==null){const pending=await conversation.pending();if(pending){const decided=await conversation.decide(pending.id,confirmed,proof);return result(ownerActionFailure(decided));}return result(ownerActionFailure({code:'NO_PENDING_ACTION'}));}
      const reminder=ownerReminderRequest(message);if(reminder)return execute({operation:reminder.operation,target:reminder.filters[0].value},message);
      if(requestedOwnerPayment(message)||ownerPaymentAmountMentioned(message)&&/\b(record|log|register)\b/i.test(message))return execute({operation:'recordPayment'},message);
      if(/\b(?:show|read|what|current)\b/i.test(message)&&/\b(?:follow.?up|reminder)\b/i.test(message)&&/\b(?:schedule|settings|preferences|cadence|hours)\b/i.test(message))return execute({operation:'readSchedule'},message);
      const cadence=message.match(/^\s*(?:set|change|update)\s+(?:the\s+)?(?:follow.?up|reminder)\s+(?:cadence|schedule)\s+to\s+(?:every\s+)?(\d+)\s+days?\s*[.!]?\s*$/i);
      if(cadence)return execute({operation:'updateSchedule',patch:{cadenceDays:Number(cadence[1])}},message);
      const correction=parseInvoiceCorrection(message,clock);
      const target=message.match(/\binvoice\s+([A-Za-z0-9][A-Za-z0-9_/-]{0,99})/i)?.[1];
      if(correction&&target&&!correction.changes.status&&!Object.values(correction.changes).includes(null)){const fields={total:'total_amount',dueDate:'due_date',invoiceDate:'issue_date',currency:'currency',notes:'notes'};if(Object.keys(correction.changes).every(k=>fields[k]))return execute({operation:'correctInvoice',target,values:Object.fromEntries(Object.entries(correction.changes).map(([k,v])=>[fields[k],v]))},message);}
      return null;
    },
  };
}
