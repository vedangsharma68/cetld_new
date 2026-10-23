import {ownerCalendar} from './workspace-records.mjs';
import {ownerInvoiceCreationFailureReply} from './owner-failure-replies.mjs';

export const TEXT_INVOICE_FORMAT = "Couldn't read that. Try: new invoice for Ravi, Rs 2,500, due 25 Oct.";

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;
const MONEY = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/;
export const TEXT_INVOICE_CLARIFICATION = 'What customer, total with currency, invoice number (or workspace numbering), and due date should I use?';

// A complete, anchored owner instruction only. Do not turn an invalid amount,
// conflicting number, or extra clause into a partial create via the planner.
function naturalTextInvoice(message,{clock=()=>new Date(),timezone='Asia/Kolkata'}={}) {
  if(typeof message!=='string'||message.length>1200)return null;
  const text=message.trim();
  if(!/^(?:can you\s+)?invoice\s+.+?\s+for\s+.*\brupees\b/iu.test(text))return null;
  const match=/^(?:can you\s+)?invoice\s+(?:for\s+)?([^,;?!\n]+?)\s+for\s+([\d,.]+)\s+rupees(?:\s*,\s*invoice number\s+([A-Za-z0-9][A-Za-z0-9./-]{0,99}))?(?:\s*,?\s+due\s+(.+?))?\s*[.!?]?$/iu.exec(text);
  if(!match)return {clarification:TEXT_INVOICE_CLARIFICATION};
  const [,customer,amount,code,date]=match,name=customer.trim(),total=Number(amount.replaceAll(',',''));
  if(!MONEY.test(amount)||!Number.isFinite(total)||total<=0||total>999999999999.99
    ||!name||name.length>200||/[\x00-\x1f\x7f]/.test(name)
    ||/\b(?:invoice number|\d[\d,.]*\s*(?:rupees|INR|Rs))\b/iu.test(name))return {clarification:TEXT_INVOICE_CLARIFICATION};
  if(!date)return {clarification:`What due date should I use for the INR ${total.toFixed(2)} invoice for ${name}${code?` (invoice number ${code})`:''}?`};
  const calendar=ownerCalendar(clock,timezone),due=dueDate(date,calendar);
  if(!due||due<calendar.currentDate)return {clarification:TEXT_INVOICE_CLARIFICATION};
  return {request:{operation:'create',table:'invoices',values:{...(code?{invoice_number:code}:{}),
    customer_name:name,total_amount:total,currency:'INR',issue_date:calendar.currentDate,due_date:due}}};
}

export function textInvoiceClarification(message,options) {
  return naturalTextInvoice(message,options)?.clarification||null;
}

export function isTextInvoiceValidationFailure(result) {
  return result?.ok===false&&result.code==='INVALID'&&result.validationCode==='INVALID_FIELDS'
    &&result.writeAttempted===false&&result.validationShape?.operation==='create'&&result.validationShape?.table==='invoices';
}

function dueDate(text, calendar) {
  const value=text.trim().toLowerCase();
  if(['today','aaj','आज'].includes(value))return calendar.currentDate;
  if(['tomorrow','kal','कल'].includes(value))return calendar.tomorrow;
  const weekday=/^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(value);
  if(weekday){
    const date=new Date(`${calendar.currentDate}T00:00:00Z`);
    const day=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(weekday[1]);
    date.setUTCDate(date.getUTCDate()+((day-date.getUTCDay()+7)%7||7));
    return date.toISOString().slice(0,10);
  }
  let iso=value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    const match=/^(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(value);
    const month=match?MONTHS.findIndex(name=>name===match[2]||name.slice(0,3)===match[2]||name==='september'&&match[2]==='sept'):-1;
    if(!match||month<0)return null;
    let year=Number(match[3]||calendar.currentDate.slice(0,4));
    const suffix=`-${String(month+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
    if(!match[3]&&`${year}${suffix}`<calendar.currentDate)year++;
    iso=`${year}${suffix}`;
  }
  const date=new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:null;
}

// Only complete, single creation instructions qualify. Other natural language
// still uses the existing planner. Parse the persisted owner text, never a
// model-generated request, so the model cannot introduce an amount or code.
export function parseTextInvoice(message,{clock=()=>new Date(),timezone='Asia/Kolkata'}={}) {
  if(typeof message!=='string'||message.length>1200)return null;
  const natural=naturalTextInvoice(message,{clock,timezone});
  if(natural)return natural.request||null;
  const text=message.trim().replace(/^QA TEXT TEST \d+:\s*/i,'')
    // A comma separates an explicit invoice number from the customer just as
    // "for" does. Keep the remaining amount/date grammar and validation shared.
    .replace(/^((?:new|नया)\s+invoice)\s+([A-Za-z0-9][A-Za-z0-9./-]{0,99})\s*,\s*/iu,'$1 $2 for ');
  const match=/^(?:([A-Za-z0-9][A-Za-z0-9./-]{0,99})\s+)?(?:new|नया)\s+invoice(?:\s+([A-Za-z0-9][A-Za-z0-9./-]{0,99}))?\s+(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]*\s)?for\s+(.+?)(?:,\s*(?:amount\s+)?|\s+(?:amount\s+)?(?=(?:Rs\.?|INR|₹)\s*\d))(?:Rs\.?|INR|₹)\s*(\d(?:[\d,]*\d)?(?:\.\d{1,2})?)\s*,?\s+due\s+(.+?)(?:,\s*please check)?\s*[.!]?\s*$/iu.exec(text);
  if(!match||match[1]&&match[2])return null;
  if(match[1]&&(!/\d/.test(match[1])||!/[./-]/.test(match[1])))return null;
  const [,prefix,code,customer,amount,date]=match;
  // Reject malformed grouping rather than silently changing the amount.
  if(!MONEY.test(amount))return null;
  const total=Number(amount.replaceAll(',',''));
  const calendar=ownerCalendar(clock,timezone),due=dueDate(date.replace(EMOJI,'').trim(),calendar);
  const name=customer.trim();
  if(!due||due<calendar.currentDate||!name||name.length>200||/[\x00-\x1f\x7f]/.test(name)
    ||!Number.isFinite(total)||total<=0||total>999999999999.99)return null;
  return {operation:'create',table:'invoices',values:{
    ...(prefix||code?{invoice_number:prefix||code}:{}),customer_name:name,
    total_amount:total,currency:'INR',issue_date:calendar.currentDate,due_date:due,
  }};
}

export function textInvoiceFailure(result) {
  if(result?.ok!==false)return null;
  if(result.invoiceCreationClarification===true&&result.writeAttempted===false)return result.message;
  if(isTextInvoiceValidationFailure(result))return TEXT_INVOICE_CLARIFICATION;
  if(result.invoiceCreationInternalFailure===true)return ownerInvoiceCreationFailureReply({writeAttempted:result.writeAttempted===true});
  if(['INVALID','INVALID_AUTHORIZATION','INVALID_FIELDS'].includes(result.code))return TEXT_INVOICE_FORMAT;
  if(result.code==='INVOICE_EXISTS')return 'That invoice number or code already exists for this customer, possibly in deleted invoices. Check before retrying.';
  if(['DATABASE_UNAVAILABLE','UNAVAILABLE','WRITE_UNCONFIRMED'].includes(result.code))return 'I couldn’t check if the invoice was created. Check cetld before retrying; this doesn’t mean it’s a duplicate.';
  return null;
}
