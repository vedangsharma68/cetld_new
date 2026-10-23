import {resolveServiceOwnerBinding} from './owner-binding.mjs';
import {isOptOut,isResubscribe} from './cloud-inbound.mjs';

const denied = reason => ({allowed:false,reason});
const unwrap = result => {if(result?.error)throw result.error;return result?.data;};

// The inbox is service-role-only and populated after raw webhook signature and
// WABA/receiving-number validation. Never accept an event object from a caller.
export async function getServiceReplyAuthority({supabase,env,workspaceId,phone,messageId,kind,audience='customer',phase='answer',clock}) {
  try {
    if(typeof messageId!=='string'||!messageId.trim())return denied('missing_inbound_context');
    const event=unwrap(await supabase.from('whatsapp_inbound_events').select('*')
      .eq('provider_message_id',messageId).maybeSingle());
    if(!event||event.provider_message_id!==messageId||event.sender_phone!==phone
      ||event.phone_number_id!==env.WHATSAPP_PHONE_NUMBER_ID||event.status!=='processing')return denied('inbound_context_mismatch');
    const received=Date.parse(event.provider_timestamp??event.received_at),now=Number(new Date(clock()));
    if(!Number.isFinite(received)||!Number.isFinite(now)||now<received||now-received>=24*60*60*1000)return denied('service_window_closed');
    if(!['normal','verification','start_confirmation','stop_confirmation'].includes(kind))return denied('inbound_kind_mismatch');
    // STOP is a single fixed acknowledgment, authorized by its existing claim,
    // not an exception that can send arbitrary text to a suppressed recipient.
    if(event.stop_processed_at){
      return kind==='stop_confirmation'&&audience==='customer'&&phase==='answer'&&event.stop_confirmation_due===true
        &&(event.stop_workspace_id??null)===workspaceId
        ?{allowed:true,customer:null,authority:'stop_confirmation'}:denied('inbound_kind_mismatch');
    }
    if(kind==='stop_confirmation')return denied('inbound_kind_mismatch');
    if(isOptOut(event.message_text)&&!/^cancel[.!\s]*$/i.test(event.message_text.trim()))return denied('inbound_kind_mismatch');
    const start=event.message_type==='text'&&isResubscribe(event.message_text);
    if(start!== (kind==='start_confirmation') || start&&(!event.start_processed_at||event.start_applied!==true))return denied('inbound_kind_mismatch');
    const owner=await resolveServiceOwnerBinding({supabase,phone});
    if(kind==='normal'&&audience==='owner'){
      if(!owner||owner.workspaceId!==workspaceId
        ||event.owner_job_workspace_id&&event.owner_job_workspace_id!==workspaceId
        ||event.owner_job_owner_id&&event.owner_job_owner_id!==owner.ownerId)return denied('owner_binding_mismatch');
      return {allowed:true,customer:null,ownerId:owner.ownerId,authority:'owner'};
    }
    if(audience!=='customer'||phase!=='answer')return denied('owner_binding_mismatch');
    const global=unwrap(await supabase.from('whatsapp_global_suppressions').select('suppressed_at').eq('phone',phone).maybeSingle());
    if(global)return denied('globally_suppressed');
    const query=supabase.from('whatsapp_suppressions').select('workspace_id').eq('phone',phone);
    const suppressed=workspaceId===null?unwrap(await query.limit(1))?.length:unwrap(await query.eq('workspace_id',workspaceId).maybeSingle());
    if(suppressed)return denied('suppressed');
    if(kind==='verification'||kind==='start_confirmation'){
      return workspaceId===null?{allowed:true,customer:null,authority:'platform'}:denied('inbound_context_mismatch');
    }
    // A current customer binding scopes a transactional answer to this business;
    // it does not authorize a template, reminder, or proactive customer send.
    if(owner||!workspaceId)return denied('inbound_context_mismatch');
    const contexts=unwrap(await supabase.from('whatsapp_messages').select('workspace_id,customer_id,audience')
      .eq('provider_message_id',messageId).eq('direction','inbound').eq('phone',phone).limit(2));
    if(!Array.isArray(contexts)||contexts.length!==1||contexts[0].workspace_id!==workspaceId
      ||contexts[0].audience!=='customer')return denied('inbound_context_mismatch');
    const customer=unwrap(await supabase.from('customers').select('*')
      .eq('workspace_id',workspaceId).eq('phone',phone).maybeSingle());
    if(!customer||customer.workspace_id!==workspaceId||customer.phone!==phone||customer.id!==contexts[0].customer_id)return denied('inbound_context_mismatch');
    return {allowed:true,customer,authority:'customer'};
  } catch {
    return denied('inbound_authority_unavailable');
  }
}
