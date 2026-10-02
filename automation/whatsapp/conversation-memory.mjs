const TABLE='whatsapp_conversation_turns';
const MAX_TURNS=20;
function dataOrThrow(result){if(result?.error)throw result.error;return result?.data;}
function scopeQuery(query,{workspaceId,phone,customerId,audience}){
 query=query.eq('phone',phone).eq('workspace_id',workspaceId).eq('audience',audience);
 if(audience==='customer'&&customerId)query=query.eq('customer_id',customerId);
 return query;
}
export async function readConversationHistory({supabase,workspaceId,phone,customerId=null,audience='customer'}){
 const rows=dataOrThrow(await scopeQuery(supabase.from(TABLE).select('role,content,created_at,id'),{workspaceId,phone,customerId,audience})
  .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(MAX_TURNS))||[];
 return rows.reverse().map(({role,content})=>({role,content}));
}
export async function writeConversationTurn({supabase,workspaceId,customerId=null,phone,role,content,audience='customer'}){
 dataOrThrow(await supabase.from(TABLE).insert({workspace_id:workspaceId,customer_id:audience==='owner'?null:customerId,phone,role,content,audience}));
 const stale=dataOrThrow(await scopeQuery(supabase.from(TABLE).select('id'),{workspaceId,phone,customerId,audience})
  .order('created_at',{ascending:false}).order('id',{ascending:false}).range(MAX_TURNS,9999))||[];
 if(stale.length)dataOrThrow(await supabase.from(TABLE).delete().in('id',stale.map(row=>row.id)));
}
export const WHATSAPP_CONVERSATION_LIMIT=MAX_TURNS;