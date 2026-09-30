function data(result, operation) {
  if (result?.error) throw Object.assign(new Error(`WhatsApp pending action ${operation} failed`), {cause: result.error});
  return result?.data;
}

export function createWhatsAppPendingActionStore({supabase, clock = () => new Date()} = {}) {
  if (!supabase?.from) throw new TypeError('Supabase service client required');
  return Object.freeze({
    async storePendingAction({workspaceId, customerId, phone, action, source}) {
      data(await supabase.from('whatsapp_pending_actions').update({consumed_at: clock().toISOString()})
        .eq('workspace_id', workspaceId).eq('customer_id', customerId).eq('phone', phone).is('consumed_at', null), 'replace');
      data(await supabase.from('whatsapp_pending_actions').insert({workspace_id: workspaceId,
        customer_id: customerId, phone, action, source}), 'store');
    },
    async loadPendingAction({workspaceId, customerId, phone}) {
      return data(await supabase.from('whatsapp_pending_actions').select('id,workspace_id,customer_id,phone,action,created_at')
        .eq('workspace_id', workspaceId).eq('customer_id', customerId).eq('phone', phone)
        .is('consumed_at', null).order('created_at', {ascending: false}).limit(1).maybeSingle(), 'load') || null;
    },
    async consumePendingAction({id, workspaceId, customerId, phone}) {
      data(await supabase.from('whatsapp_pending_actions').update({consumed_at: clock().toISOString()})
        .eq('id', id).eq('workspace_id', workspaceId).eq('customer_id', customerId).eq('phone', phone)
        .is('consumed_at', null), 'consume');
    },
  });
}
