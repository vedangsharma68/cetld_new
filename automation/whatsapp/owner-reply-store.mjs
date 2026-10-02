import {createConversationStore} from './conversation-store.mjs';

const data=result=>{if(result?.error)throw result.error;return result?.data;};
const epoch=clock=>{const value=clock();return value instanceof Date?value.getTime():Number(value);};

/** Reuse only replies belonging to the currently verified workspace and phone. */
export function createOwnerReplyStore({supabase,clock=()=>new Date()}={}) {
  const conversations=createConversationStore(supabase);
  const reply=async(scope,messageId)=>{
    if(typeof messageId!=='string'||!messageId)return null;
    const row=data(await supabase.from('whatsapp_messages').select('body,kind,status')
      .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('audience','owner')
      .eq('direction','outbound').eq('kind','normal').eq('idempotency_key',`reply:${messageId}`).maybeSingle());
    return typeof row?.body==='string'&&row.body.trim()
      ?{answer:row.body,replayMessageId:messageId,replayDeliveryStatus:row.status}:null;
  };
  return {
    async find(scope) {
      const exact=await reply(scope,scope.messageId);
      if(exact)return exact;
      // Empty captions and distinct attachments are not text resends. Compare
      // only the previous inbound turn, so a new proposal's "yes" is not a
      // duplicate of a different confirmation earlier in the conversation.
      if(scope.media||scope.mediaError||!String(scope.message||'').trim())return null;
      let q=supabase.from('whatsapp_messages').select('body,provider_message_id,created_at')
        .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('audience','owner')
        .eq('direction','inbound').eq('status','received')
        .gte('created_at',new Date(epoch(clock)-120_000).toISOString());
      if(scope.messageId)q=q.neq('provider_message_id',scope.messageId);
      const previous=(data(await q.order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1))||[])[0];
      if(!previous||previous.body!==String(scope.message)||!previous.provider_message_id)return null;
      const age=epoch(clock)-Date.parse(previous.created_at);
      if(!Number.isFinite(age)||age<0||age>120_000)return null;
      return reply(scope,previous.provider_message_id);
    },
    async save(scope,result) {
      if(!scope.messageId||!result?.answer?.trim())return result;
      const stored=await conversations.record({workspaceId:scope.workspaceId,phone:scope.phone,
        customerId:null,invoiceId:null,audience:'owner',direction:'outbound',kind:'normal',status:'pending',
        body:result.answer,key:`reply:${scope.messageId}`,createdAt:new Date(epoch(clock)).toISOString()});
      if(!stored?.body||stored.phone!==scope.phone||stored.audience!=='owner'||stored.kind!=='normal')
        throw Object.assign(new Error('Owner reply receipt unavailable'),{code:'OWNER_REPLY_STORE_FAILED'});
      return {...result,answer:stored.body};
    },
  };
}
