import {createHash} from 'node:crypto';

export const conversationCallbackToken=(workspaceId,key)=>createHash('sha256').update(JSON.stringify([workspaceId,key])).digest('hex');

const check=result=>{if(result?.error)throw result.error;return result?.data;};

/** Permanent dashboard history is separate from the bot's bounded context. */
export function createConversationStore(supabase) {
  return {
    async record({workspaceId,customerId=null,invoiceId=null,phone,direction,body,kind='text',
      audience='customer',status,providerMessageId=null,key,createdAt}) {
      if(!workspaceId)return;
      check(await supabase.from('whatsapp_messages').upsert({
        workspace_id:workspaceId,customer_id:customerId,invoice_id:invoiceId,phone,direction,
        body:String(body||'').slice(0,4000),kind,audience,status,
        provider_message_id:providerMessageId,idempotency_key:key,
        ...(direction==='outbound'?{callback_token:conversationCallbackToken(workspaceId,key)}:{}),
        ...(createdAt?{created_at:createdAt}:{}),
      },{onConflict:'workspace_id,idempotency_key',ignoreDuplicates:true}));
      if(direction==='outbound')return check(await supabase.from('whatsapp_messages').select('body,audience,phone,customer_id,invoice_id,kind,status')
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
