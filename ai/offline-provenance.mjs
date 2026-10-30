// Read durable, server-owned provenance before any provider can see business
// context. An unavailable provenance store fails closed at the caller.
export async function offlineProvenance({supabase,workspaceId,ownerId=null,mark=false}) {
  const result=await supabase.rpc('owner_assistant_offline_provenance',{
    p_workspace_id:workspaceId,p_owner_id:ownerId,p_mark:mark,
  });
  if(result?.error || typeof result?.data !== 'boolean') throw new Error('Offline provenance unavailable');
  return result.data;
}
