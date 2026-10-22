import {normalizeWhatsAppPhone} from './consent.mjs';

export const PHONE_FORMAT_GUIDANCE='Send it with the country code, like +919818685252.';

/** Owner supplied contact input; never use this for sender identity/binding. */
export function normalizeOwnerPhone(input){
  const text=String(input??'').trim();
  if(!/^\+?[\d\s-]+$/.test(text))throw new TypeError(PHONE_FORMAT_GUIDANCE);
  let phone=text.replace(/[\s-]/g,'');
  if(/^[6-9]\d{9}$/.test(phone))phone='+91'+phone;
  try{return normalizeWhatsAppPhone(phone);}catch{throw new TypeError(PHONE_FORMAT_GUIDANCE);}
}

export function normalizeOwnerPhoneValues(values,table){
  const copy={...values};
  for(const key of table==='customers'?['phone']:table==='invoices'?['customer_phone']:[])
    if(copy[key]!==undefined&&copy[key]!==null)copy[key]=normalizeOwnerPhone(copy[key]);
  return copy;
}

/** The database commits phone, invoice contact and assumed-consent audit together. */
export async function saveOwnerPhone({supabase,scope,customerId,invoiceId=null,phone,messageId,message,authorize}){
  phone=normalizeOwnerPhone(phone);
  if(!await authorize())throw new Error('Owner authorization required');
  const result=await supabase.rpc('whatsapp_owner_save_phone',{
    p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
    p_customer_id:customerId,p_invoice_id:invoiceId,p_contact_phone:phone,
    p_message_id:messageId,p_user_message:message,
  });
  if(result.error)throw result.error;
  if(!await authorize())throw new Error('Owner authorization required');
  return result.data;
}

// Only the most recent owner topic can supply a correction target. A new topic
// ends recovery; never scan past it to resurrect an old failed reminder.
export function recentPhoneSubject(history){
  const recent=history.filter(t=>t?.role==='user'||t?.role==='assistant').slice(-8);
  const lastOwner=[...recent].reverse().find(t=>t.role==='user'&&!/^(?:(?:it is|it's|the (?:phone|number) is)\s+)?\+?[\d\s-]+[.!]?$/i.test(String(t.content||'').trim()));
  if(!lastOwner)return null;
  return {message:lastOwner.content,reply:recent.slice(recent.indexOf(lastOwner)+1).filter(t=>t.role==='assistant').map(t=>t.content).join('\n')};
}
