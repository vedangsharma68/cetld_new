function data(result, operation) {
  if (result?.error) throw Object.assign(new Error(`WhatsApp pending action ${operation} failed`), {cause: result.error});
  return result?.data;
}

export function createWhatsAppPendingActionStore({supabase} = {}) {
  if (!supabase?.from) throw new TypeError('Supabase service client required');
  return Object.freeze({
    async beginInvoiceReview({workspaceId, customerId, phone}) {
      const row = data(await supabase.rpc('whatsapp_begin_invoice_review', {
        p_workspace_id: workspaceId, p_customer_id: customerId, p_phone: phone,
      }), 'begin invoice review');
      return Array.isArray(row) ? row[0] : row;
    },
    async loadInvoiceReview({workspaceId, customerId, phone}) {
      const row = data(await supabase.rpc('whatsapp_load_invoice_review', {
        p_workspace_id: workspaceId, p_customer_id: customerId, p_phone: phone,
      }), 'load invoice review');
      return (Array.isArray(row) ? row[0] : row) || null;
    },
    async transitionInvoiceReview({id, version, workspaceId, customerId, phone, fromStage, action}) {
      const row = data(await supabase.rpc('whatsapp_transition_invoice_review', {
        p_id: id, p_version: version, p_workspace_id: workspaceId, p_customer_id: customerId,
        p_phone: phone, p_from_stage: fromStage, p_action: action,
      }), 'transition invoice review');
      return (Array.isArray(row) ? row[0] : row) || null;
    },
    async loadPendingActionState({workspaceId, customerId, phone}) {
      const row = data(await supabase.rpc('whatsapp_load_pending_action_state', {
        p_workspace_id: workspaceId, p_customer_id: customerId, p_phone: phone,
      }), 'load state');
      return (Array.isArray(row) ? row[0] : row) || {generation: 0, id: null, version: null, action: null};
    },
    async storePendingAction({workspaceId, customerId, phone, action, source, expectedState}) {
      if (!expectedState || !Number.isSafeInteger(Number(expectedState.generation))) {
        throw new TypeError('Expected pending-action state required');
      }
      const row = data(await supabase.rpc('whatsapp_store_pending_action', {
        p_workspace_id: workspaceId, p_customer_id: customerId, p_phone: phone,
        p_action: action, p_source: source, p_expected_generation: Number(expectedState.generation),
        p_expected_id: expectedState.id ?? null, p_expected_version: expectedState.version ?? null,
      }), 'store');
      return (Array.isArray(row) ? row[0] : row) || null;
    },
    async loadPendingAction({workspaceId, customerId, phone}) {
      return data(await supabase.from('whatsapp_pending_actions').select('id,workspace_id,customer_id,phone,action,created_at')
        .eq('workspace_id', workspaceId).eq('customer_id', customerId).eq('phone', phone)
        .is('consumed_at', null).order('created_at', {ascending: false}).limit(1).maybeSingle(), 'load') || null;
    },
    async consumePendingAction({id, workspaceId, customerId, phone}) {
      const row = data(await supabase.rpc('whatsapp_claim_pending_action', {
        p_id: id, p_workspace_id: workspaceId, p_customer_id: customerId, p_phone: phone,
      }), 'consume');
      return (Array.isArray(row) ? row[0] : row) || null;
    },
  });
}
