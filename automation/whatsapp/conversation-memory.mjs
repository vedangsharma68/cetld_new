const TABLE = 'whatsapp_conversation_turns';
const MAX_TURNS = 20;

function dataOrThrow(result) {
  if (result?.error) throw result.error;
  return result?.data;
}

/** Load trusted, bounded conversation context for one WhatsApp binding. */
export async function readConversationHistory({supabase, workspaceId, phone}) {
  const rows = dataOrThrow(await supabase.from(TABLE).select('role,content,created_at,id')
    .eq('phone', phone).eq('workspace_id', workspaceId)
    .order('created_at', {ascending: false}).order('id', {ascending: false}).limit(MAX_TURNS)) || [];
  return rows.reverse().map(({role, content}) => ({role, content}));
}

/** Store one turn and prune everything older than the newest 20 turns. */
export async function writeConversationTurn({supabase, workspaceId, customerId = null, phone, role, content}) {
  dataOrThrow(await supabase.from(TABLE).insert({workspace_id: workspaceId, customer_id: customerId,
    phone, role, content}));
  const stale = dataOrThrow(await supabase.from(TABLE).select('id')
    .eq('phone', phone).eq('workspace_id', workspaceId)
    .order('created_at', {ascending: false}).order('id', {ascending: false}).range(MAX_TURNS, 9999)) || [];
  if (stale.length) dataOrThrow(await supabase.from(TABLE).delete().in('id', stale.map(row => row.id)));
}

export const WHATSAPP_CONVERSATION_LIMIT = MAX_TURNS;
