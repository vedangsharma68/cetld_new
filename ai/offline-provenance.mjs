// Read durable, server-owned provenance before any provider can see business
// context. An unavailable provenance store fails closed at the caller.
export async function offlineProvenance({supabase,workspaceId,ownerId=null,mark=false}) {
  try {
    const result=await supabase.rpc('owner_assistant_offline_provenance',{
      p_workspace_id:workspaceId,p_owner_id:ownerId,p_mark:mark,
    });
    if(result?.error || typeof result?.data !== 'boolean') throw result?.error || new Error('Invalid provenance response');
    return result.data;
  } catch(cause) {
    throw Object.assign(new Error('Offline provenance unavailable', {cause}), {code:'FEATURE_UNAVAILABLE'});
  }
}
