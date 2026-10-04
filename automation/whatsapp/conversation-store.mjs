import {createHash} from 'node:crypto';
import {normalizeOwnerNextActionRef} from './owner-next-actions.mjs';

export const conversationCallbackToken=(workspaceId,key)=>createHash('sha256').update(JSON.stringify([workspaceId,key])).digest('hex');
export function normalizeOwnerReplyMediaRef(value){
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['invoiceId','invoiceUpdatedAt','fileId'].includes(k))
    ||!uuid.test(value.invoiceId||'')||!uuid.test(value.fileId||'')||!Number.isFinite(Date.parse(value.invoiceUpdatedAt)))return null;
  return {invoiceId:value.invoiceId,invoiceUpdatedAt:value.invoiceUpdatedAt,fileId:value.fileId};
}

const check=result=>{if(result?.error)throw result.error;return result?.data;};
function ownerActionReference(value,audience,direction){
  if(value==null)return null;
  if(audience!=='owner'||direction!=='outbound'||!value||typeof value!=='object'||Array.isArray(value))
    throw new TypeError('Owner action reference is only valid on an owner reply.');
  const pendingId=Number(value.pendingId),pendingVersion=Number(value.pendingVersion);
  if(!Number.isSafeInteger(pendingId)||pendingId<1||!Number.isSafeInteger(pendingVersion)||pendingVersion<1)
    throw new TypeError('Invalid owner action reference.');
  return {pendingId,pendingVersion};
}

/** Permanent dashboard history is separate from the bot's bounded context. */
export function createConversationStore(supabase) {
  return {
    async record({workspaceId,customerId=null,invoiceId=null,phone,direction,body,kind='text',
      audience='customer',status,providerMessageId=null,key,createdAt,ownerActionRef=null,ownerNextActionRef=null,ownerReplyMediaRef=null}) {
      if(!workspaceId)return;
      const actionRef=ownerActionReference(ownerActionRef,audience,direction);
      const nextRef=normalizeOwnerNextActionRef(ownerNextActionRef);
      const mediaRef=normalizeOwnerReplyMediaRef(ownerReplyMediaRef);
      if(ownerReplyMediaRef!=null&&(!mediaRef||audience!=='owner'||direction!=='outbound'||kind!=='normal'||actionRef||nextRef))throw new TypeError('Invalid owner file receipt.');
      if(ownerNextActionRef!=null&&(!nextRef||audience!=='owner'||direction!=='outbound'||kind!=='normal'||actionRef))
        throw new TypeError('Invalid owner next-action reference.');
      check(await supabase.from('whatsapp_messages').upsert({
        workspace_id:workspaceId,customer_id:customerId,invoice_id:invoiceId,phone,direction,
        body:String(body||'').slice(0,4000),kind,audience,status,
        provider_message_id:providerMessageId,idempotency_key:key,
        ...(actionRef?{owner_action_ref:actionRef}:{}),
        ...(nextRef?{owner_next_action_ref:nextRef}:{}),
        ...(mediaRef?{owner_reply_media_ref:mediaRef}:{}),
        ...(direction==='outbound'?{callback_token:conversationCallbackToken(workspaceId,key)}:{}),
        ...(createdAt?{created_at:createdAt}:{}),
      },{onConflict:'workspace_id,idempotency_key',ignoreDuplicates:true}));
      if(direction==='outbound')return check(await supabase.from('whatsapp_messages').select('body,audience,phone,customer_id,invoice_id,kind,status,owner_action_ref,owner_next_action_ref,owner_reply_media_ref')
        .eq('workspace_id',workspaceId).eq('idempotency_key',key).maybeSingle());
    },
    async status({messageId,phone,status,callbackToken=null}) {
      check(await supabase.rpc('whatsapp_record_delivery_status',{
        p_message_id:messageId,p_phone:phone,p_status:status,p_callback_token:callbackToken,
      }));
    },
    async abandonReply({workspaceId,key}) {
      if(!key.startsWith('reply:'))return;
      check(await supabase.rpc('whatsapp_block_unclaimed_reply',{
        p_workspace_id:workspaceId,p_message_id:key.slice(6),
      }));
    },
    async finish({workspaceId,key,status,providerMessageId=null}) {
      check(await supabase.from('whatsapp_messages').update({status,provider_message_id:providerMessageId,
        updated_at:new Date().toISOString()}).eq('workspace_id',workspaceId).eq('idempotency_key',key)
        .in('status',['pending','unknown']));
    },
  };
}

export function parseMetaStatuses(payload,phoneNumberId,wabaId) {
  const result=[];
  for(const entry of payload?.entry||[]) {
    if(String(entry.id)!==String(wabaId))continue;
    for(const change of entry.changes||[]) {
      if(change.field!=='messages'||String(change.value?.metadata?.phone_number_id)!==String(phoneNumberId))continue;
      for(const item of change.value.statuses||[]) {
        const phone=String(item.recipient_id||'').replace(/^\+?/,'+');
        if(typeof item.id==='string'&&item.id.length<=256&&/^\+[1-9]\d{6,14}$/.test(phone)
          &&['sent','delivered','read','failed'].includes(item.status))result.push({messageId:item.id,phone,status:item.status,
            ...(/^[a-f0-9]{64}$/.test(item.biz_opaque_callback_data||'')?{callbackToken:item.biz_opaque_callback_data}:{} )});
      }
    }
  }
  return result.slice(0,100);
}
