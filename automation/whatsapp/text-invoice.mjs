import {ownerCalendar} from './workspace-records.mjs';

export const TEXT_INVOICE_FORMAT = 'Accepted format: New invoice for <customer>, amount Rs <amount>, due <DD Month YYYY>. Example: New invoice QA-VERIFY-001 for QA Text Customer, amount Rs 2,500, due 25 October 2026. Optional code: New invoice <code> for <customer>, amount Rs <amount>, due <DD Month YYYY>. Issue date defaults to today in your workspace timezone. Due dates also accept YYYY-MM-DD, today/aaj, or tomorrow/kal (कल means tomorrow for a new invoice).';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;

function dueDate(text, calendar) {
  const value=text.trim().toLowerCase();
  if(['today','aaj','आज'].includes(value))return calendar.currentDate;
  if(['tomorrow','kal','कल'].includes(value))return calendar.tomorrow;
  let iso=value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    const match=/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(value);
    const month=match&&MONTHS.indexOf(match[2]);
    if(!match||month<0)return null;
    iso=`${match[3]}-${String(month+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  const date=new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:null;
}

// Only complete, single creation instructions qualify. Other natural language
// still uses the existing planner. Parse the persisted owner text, never a
// model-generated request, so the model cannot introduce an amount or code.
export function parseTextInvoice(message,{clock=()=>new Date(),timezone='Asia/Kolkata'}={}) {
  if(typeof message!=='string'||message.length>1200)return null;
  const text=message.trim().replace(/^QA TEXT TEST \d+:\s*/i,'');
  const match=/^(?:([A-Za-z0-9][A-Za-z0-9./-]{0,99})\s+)?(?:new|नया)\s+invoice(?:\s+([A-Za-z0-9][A-Za-z0-9./-]{0,99}))?\s+(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]*\s)?for\s+(.+?)(?:,\s*amount\s+|\s+(?=(?:Rs\.?|INR|₹)\s*\d))(?:Rs\.?|INR|₹)\s*(\d(?:[\d,]*\d)?(?:\.\d{1,2})?)\s*,?\s+due\s+(.+?)(?:,\s*please check)?\s*[.!]?\s*$/iu.exec(text);
  if(!match||match[1]&&match[2])return null;
  if(match[1]&&(!/\d/.test(match[1])||!/[./-]/.test(match[1])))return null;
  const [,prefix,code,customer,amount,date]=match;
  // Reject malformed grouping rather than silently changing the amount.
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(amount))return null;
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
  if(['INVALID','INVALID_AUTHORIZATION','INVALID_FIELDS'].includes(result.code))return `I could not create the invoice from those fields. ${TEXT_INVOICE_FORMAT}`;
  if(result.code==='INVOICE_EXISTS')return 'An invoice with that number or source code already exists for this workspace/customer, possibly in deleted invoices. Review it before trying again.';
  if(['DATABASE_UNAVAILABLE','UNAVAILABLE','WRITE_UNCONFIRMED'].includes(result.code))return 'I could not verify invoice creation because the service was unavailable. Check your workspace before retrying. This failure does not confirm a duplicate.';
  return null;
}
