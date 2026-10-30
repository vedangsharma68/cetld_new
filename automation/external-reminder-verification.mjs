import {abortable} from './accounting/zoho-create-receipt.mjs';
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

// Selection for the existing owner confirmation workflow only; never a send or
// generic external-evidence grant. SQL independently rechecks protected origin.
export async function boundOwnerReminderEligible({supabase,ownerId,workspaceId,invoiceId}){
 if(![ownerId,workspaceId,invoiceId].every(x=>typeof x==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x)))return false;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 try{let q=supabase.rpc('cetld_zoho_bound_reminder',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:invoiceId,p_action:'eligible'});
 if(q.abortSignal)q=q.abortSignal(controller.signal);
 const r=await abortable(Promise.resolve(q),controller.signal);return !r.error&&r.data?.ok===true;
 }catch{return false;}finally{clearTimeout(timer);controller.abort();}
}

export async function reminderPaymentRpc({supabase,name,args,invoice,beforeRpc}){
  if(hasExternalReminderLedger(invoice)&&!(name==='whatsapp_owner_reminder'&&await boundOwnerReminderEligible({supabase,ownerId:args.p_owner_id,workspaceId:args.p_workspace_id,invoiceId:invoice.id})))return {data:{ok:false,authorized:false,code:'external_accounting_required',reason:'external_accounting_required'},error:null};
  await beforeRpc?.();
  return supabase.rpc(name,args);
}
