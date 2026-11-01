import {randomUUID} from 'node:crypto';
import {privateChatTopic} from './private-chat.mjs';

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
  let appended=false,privateTerms=[];
  const containsPrivate=text=>{
    const content=String(text||'').toLowerCase();
    return privateTerms.some(term=>term.length>=3?content.includes(term)
      :new RegExp(`(?<![\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\p{L}\\p{N}_])`,'u').test(content));
  };
  return {
    containsPrivate,
    async read(message){
      const [historyResult,termsResult]=await Promise.all([query().order('id',{ascending:false}).limit(20),
        supabase.from('whatsapp_private_invoice_terms').select('term').eq('workspace_id',workspaceId).order('term_hash').range(0,499)]);
      const rows=data(historyResult)||[];
      let page=data(termsResult)||[];
      privateTerms=page.map(row=>row.term);
      for(let offset=500;page.length===500;offset+=500){
        page=data(await supabase.from('whatsapp_private_invoice_terms').select('term').eq('workspace_id',workspaceId).order('term_hash').range(offset,offset+499))||[];
        privateTerms.push(...page.map(row=>row.term));
      }
      if(containsPrivate(message))return null;
      const eligible=row=>row.provenance===PROVENANCE&&['user','assistant'].includes(row.role)
        &&typeof row.content==='string'&&row.content.length<=4000&&!privateChatTopic(row.content)&&!containsPrivate(row.content);
      const ordinary=rows.filter(eligible);
      let historyPage=rows;
      // Later invoice evidence can taint a previously ordinary quotation. Fill
      // the window with older eligible messages instead of shortening memory.
      for(let offset=20;ordinary.length<20&&historyPage.length===20;offset+=20){
        historyPage=data(await query().order('id',{ascending:false}).range(offset,offset+19))||[];
        ordinary.push(...historyPage.filter(eligible));
      }
      return ordinary.slice(0,20).reverse().map(({role,content})=>({role,content}));
    },
    async append(message,answer){
      if(appended||privateChatTopic(message)||privateChatTopic(answer)||containsPrivate(message)||containsPrivate(answer))return;
      const rows=[['user',message],['assistant',answer]].map(([role,content])=>({workspace_id:workspaceId,
        owner_id:audience==='owner'?ownerId:null,customer_id:audience==='customer'?customerId:null,
        phone,audience,source_message_id:messageId,role,content,provenance:PROVENANCE}));
      const result=await supabase.from(TABLE).insert(rows);
      if(result?.error?.code!=='23505')data(result);
      appended=true;
    },
  };
}
