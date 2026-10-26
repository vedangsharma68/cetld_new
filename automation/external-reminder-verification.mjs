// Match SQL's text/BTRIM linkage markers; malformed JSON markers (including
// empty arrays/objects) are external, never a way to fall into the local path.
const linkedMarker=value=>value!=null&&(typeof value!=='string'||value.replace(/^ +| +$/g,'').length>0);
export const hasExternalReminderLedger=i=>[i.external_provider,i.external_invoice_id,i.metadata?.accounting_provider,i.metadata?.bookkeeping_record_id].some(linkedMarker);
export const localReminderStatusPayable=i=>i.status==='sent'||i.status==='overdue';

// Containment, not provenance capture. Neither current-account reads, matching
// financial facts nor caller/metadata flags prove the original provider account.
// No token preparation, provider read or evidence until authoritative immutable
// provenance is separately implemented.
export async function externalReminderRead({invoice}={}){
  if(!hasExternalReminderLedger(invoice))return null;
  throw Error('External reminders unavailable: immutable provider-account provenance is unsupported');
}

export async function reminderPaymentRpc({supabase,name,args,invoice,beforeRpc}){
  if(hasExternalReminderLedger(invoice))return {data:{ok:false,authorized:false,code:'external_accounting_required',reason:'external_accounting_required'},error:null};
  await beforeRpc?.();
  return supabase.rpc(name,args);
}
