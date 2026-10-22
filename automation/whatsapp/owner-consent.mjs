import {normalizeOwnerPhone} from './owner-phone.mjs';
import {resolveWorkspaceRecord} from './workspace-records.mjs';

const GUIDANCE='Tell me the customer name and current number, and confirm they agreed to WhatsApp invoice reminders.';
const MESSAGES={
  OWNER_PHONE:'That number is your verified owner WhatsApp number. Send a different number for the customer; owner consent cannot be reassigned.',
  CONFLICT:'That number already has consent linked to another customer. Check the customer and send their own number.',
  suppressed:'This customer has stopped WhatsApp reminders. Ask them to opt back in before recording consent.',
  globally_suppressed:'This phone has stopped WhatsApp messages. Ask the recipient to opt back in before recording consent.',
  revoked:'This customer withdrew consent. Ask them to opt back in from their own WhatsApp number before recording consent.',
  STALE:"That number does not match the customer's current saved number. Check their number and record consent again.",
  NOT_FOUND:'I could not find that customer or invoice. Check the name or invoice number and try again.',
  AMBIGUOUS:'More than one customer or invoice matches. Send the customer name and current number, or one invoice number.',
  DENIED:'I could not verify your owner access. Reconnect your owner WhatsApp number in Settings and try again.',
  REPLAY_MISMATCH:'This consent request changed after it was recorded. Check the customer and send a fresh consent instruction.',
  INVALID:GUIDANCE,
  UNAVAILABLE:'I could not reach the consent record. Try recording consent again shortly.',
};
export function ownerConsentFailure(code){
  return {ok:false,completed:false,code:MESSAGES[code]?code:'UNAVAILABLE',message:MESSAGES[code]||MESSAGES.UNAVAILABLE};
}

// This shortcut recognizes consent topics, but only the database may attest a
// current, affirmative instruction. Questions and negations cannot write.
export function ownerConsentRequest(message){
  const text=String(message||'').trim();
  if(!/\b(?:consent(?:ed)?|agreed)\b/i.test(text)||!/\b(?:reminders?|WhatsApp|consent)\b/i.test(text))return null;
  const invoice=text.match(/\bINV[-/][A-Z0-9][A-Z0-9/-]*/i)?.[0];
  const named=text.match(/^(?:record|save)\s+(?:(?:the|reminder)\s+)?consent\s*(?:(?:for|:)\s*)?(.+?)(?=\s+(?:on|agreed|has agreed|have agreed)\b|[.!]?$)/i)?.[1]?.trim()
    ||text.match(/^(.+?)\s+(?:(?:has|have)\s+)?(?:agreed|consented)\s+(?:to|for)\b/i)?.[1]?.trim();
  const name=named&&!/^(?:yes[, ]*)?(?:he|she|they|the customer|this customer)$/i.test(named)?named:null;
  const rawPhone=text.match(/\+\d[\d -]{6,}\d\b|\b[6-9]\d{9}\b/)?.[0];
  let phone=null;
  if(rawPhone)try{phone=normalizeOwnerPhone(rawPhone);}catch{}
  const filters=invoice?[{column:'invoice_number',operator:'eq',value:invoice}]
    :name?[{column:'name',operator:'eq',value:name}]:phone?[{column:'phone',operator:'eq',value:phone}]:[];
  return {operation:'recordConsent',table:invoice?'invoices':'customers',filters};
}

export function createOwnerConsentRuntime({supabase,scope,message='',messageId,authorize}={}){
  let reply=null;
  const check=async ctx=>{ctx?.assertLive?.();if(!await authorize(scope))throw Error('owner required');await ctx?.assertAuthorized?.();ctx?.assertLive?.();};
  const finish=result=>{reply=result?.ok&&result.completed
    ?`Recorded reminder consent for ${result.customerName} on ${result.phone}. No reminder was sent.`
    :ownerConsentFailure(result?.code).message;return {...result,message:reply,
      ...(result?.code==='INVALID'?{validationCode:'CONSENT_EVIDENCE_REQUIRED'}:{})};};
  return {
    getReply:()=>reply,
    async execute(params,ctx){
      try{
        await check(ctx);
        if(!params.filters?.length)return finish(ownerConsentFailure('INVALID'));
        // A phone-only target can identify the owner collision without choosing
        // between two customer records or touching the verified owner binding.
        if(params.table==='customers'&&params.filters.some(f=>f.column==='phone'&&f.value===scope.phone))
          return finish(ownerConsentFailure('OWNER_PHONE'));
        const found=await resolveWorkspaceRecord({supabase,scope,table:params.table,filters:params.filters,operation:'update',
          select:params.table==='invoices'?'id,customer_id,invoice_number':'id,name,phone',assertAuthorized:()=>check(ctx),assertLive:()=>ctx?.assertLive?.()});
        if(!found.ok)return finish(ownerConsentFailure(found.code));
        const customer=params.table==='customers'?found.row:(await supabase.from('customers').select('id,name,phone')
          .eq('workspace_id',scope.workspaceId).eq('id',found.row.customer_id).single());
        if(customer?.error)throw customer.error;
        const row=params.table==='customers'?customer:customer.data;
        await check(ctx);
        const result=await supabase.rpc('whatsapp_owner_record_consent',{
          p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,p_customer_id:row.id,
          p_contact_phone:row.phone,p_message_id:messageId,p_user_message:String(message),
        });
        if(result.error)throw result.error;
        await check(ctx);return finish(result.data||ownerConsentFailure('UNAVAILABLE'));
      }catch{return finish(ownerConsentFailure('UNAVAILABLE'));}
    },
  };
}
