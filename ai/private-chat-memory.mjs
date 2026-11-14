import {createPrivateValueMatcher,privateOriginStart} from './private-value-matcher.mjs';
import {createCanonicalPrivateValueIndex} from './private-payload-boundary.mjs';
import {randomUUID} from 'node:crypto';
import {privateChatTopic,PRIVATE_CHAT_SYSTEM_MESSAGE} from './private-chat.mjs';

const TABLE='whatsapp_provider_memory';
const PROVENANCE='ordinary_chat_v1';
const data=result=>{if(result?.error)throw Object.assign(new Error('Chat memory temporarily unavailable'),{code:'CHAT_MEMORY_UNAVAILABLE'});return result?.data;};

// This is a positive provenance store, separate from the full local audit.
// No legacy audit rows are assumed safe or copied into provider memory.
export function createPrivateChatMemory({supabase,scope}) {
  const {workspaceId,ownerId,customerId,phone,audience='customer'}=scope;
  const messageId=scope.messageId||randomUUID();
  const query=()=>{
    let q=supabase.from(TABLE).select('role,content,provenance,id').eq('workspace_id',workspaceId)
      .eq('phone',phone).eq('audience',audience).eq('provenance',PROVENANCE);
    q=audience==='owner'?q.eq('owner_id',ownerId):q.eq('customer_id',customerId);
    return q;
  };
  let appended=false,privateTerms=[],index,matchPrivate=()=>true;
  const containsPrivate=text=>matchPrivate(text);
  const containsOrdinary=text=>matchPrivate.ordinary?matchPrivate.ordinary(text):matchPrivate(text);
  const retainOrigin=async message=>{
    if(privateOriginStart(message)===null&&!matchPrivate.entities?.(message))return false;
    const retained=data(await supabase.rpc('whatsapp_retain_private_chat_origin',{p_workspace_id:workspaceId,p_text:message}));
    if(retained!==true)throw Object.assign(new Error('Private origin retention unavailable'),{code:'CHAT_MEMORY_UNAVAILABLE'});
    return true;
  };
  const loadTerms=async first=>{
        let page=data(first??await supabase.from('whatsapp_private_invoice_terms').select('term').eq('workspace_id',workspaceId).order('term_hash').range(0,499))||[];
        privateTerms=page.map(row=>row.term);
        for(let offset=500;page.length===500;offset+=500){
          page=data(await supabase.from('whatsapp_private_invoice_terms').select('term').eq('workspace_id',workspaceId).order('term_hash').range(offset,offset+499))||[];
          privateTerms.push(...page.map(row=>row.term));
        }
        index=createCanonicalPrivateValueIndex(privateTerms);
        matchPrivate=Object.assign(index.contains,{ordinary:index.ordinary,entities:index.entities,spans:index.spans});
      };
  return {
    containsPrivate,containsOrdinary,retainOrigin,
    async refresh(){await loadTerms();},
    async assertFinalPayload(payload){await loadTerms();this.assertPayload(payload);},
    assertPayload(payload){if(!index)throw Object.assign(new Error('Privacy snapshot unavailable'),{code:'CHAT_MEMORY_UNAVAILABLE'});index.assertPayload(payload,{trustedSystem:PRIVATE_CHAT_SYSTEM_MESSAGE});},
    privateSpans:text=>matchPrivate.spans?.(text,{ordinary:true})||[],
    async read(message,{allowPrivateCurrent=false}={}){
      const readiness=data(await supabase.from('whatsapp_private_invoice_backfill').select('complete').limit(4));
      if(!Array.isArray(readiness)||readiness.length!==4||readiness.some(row=>row.complete!==true))
        throw Object.assign(new Error('Chat privacy backfill is not complete'),{code:'CHAT_MEMORY_UNAVAILABLE'});
      // Retain private-origin atomic fields before loading history/keys. A
      // canceled review or process restart cannot turn its fragments ordinary.
      const capturedCurrent=await retainOrigin(message);
      const [historyResult,termsResult]=await Promise.all([query().order('id',{ascending:false}).limit(20),
        supabase.from('whatsapp_private_invoice_terms').select('term').eq('workspace_id',workspaceId).order('term_hash').range(0,499)]);
      await loadTerms(termsResult);
      // A scoped identity binds supplied facts even when the prose uses a new
      // verb. Capture before routing and before admitting any later fragments.
      if(!capturedCurrent&&await retainOrigin(message))await loadTerms();
      const eligible=row=>row.provenance===PROVENANCE&&['user','assistant'].includes(row.role)
        &&typeof row.content==='string'&&row.content.length<=4000&&!privateChatTopic(row.content)&&!containsOrdinary(row.content);
      const allRows=data(historyResult)||[];let historyPage=allRows,ordinary;
      for(let offset=20;;offset+=20){
        // Defense for previously mislabelled history: retain its origin before
        // deciding which newer fragments may enter this request or later ones.
        let retained=false;for(const row of historyPage)retained=(await retainOrigin(row.content))||retained;
        if(retained)await loadTerms();
        ordinary=allRows.filter(eligible);
        if(ordinary.length>=20||historyPage.length<20)break;
        historyPage=data(await query().order('id',{ascending:false}).range(offset,offset+19))||[];
        allRows.push(...historyPage);
      }
      if(!allowPrivateCurrent&&containsOrdinary(message))return null;
      return ordinary.slice(0,20).reverse().map(({role,content})=>({role,content}));
    },
    async append(message,answer){
      await retainOrigin(message);await retainOrigin(answer);await loadTerms();
      if(appended||privateChatTopic(message)||privateChatTopic(answer)||containsOrdinary(message)||containsPrivate(answer))return;
      const rows=[['user',message],['assistant',answer]].map(([role,content])=>({workspace_id:workspaceId,
        owner_id:audience==='owner'?ownerId:null,customer_id:audience==='customer'?customerId:null,
        phone,audience,source_message_id:messageId,role,content,provenance:PROVENANCE}));
      const result=await supabase.from(TABLE).insert(rows);
      if(result?.error?.code!=='23505')data(result);
      appended=true;
    },
  };
}
