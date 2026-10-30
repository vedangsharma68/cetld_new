import {APIError} from './http.mjs';
import {hasExternalReminderLedger} from '../automation/external-reminder-verification.mjs';

// Both transports supply a server-verified owner identity. Never derive this
// identity from customer metadata, a phone number alone, or browser history.
export function createOwnerConversation({rpc, workspaceId, ownerId, channel = 'web', readProposal, readReminderInvoice}) {
  let historyProvenance;
  const reminderPreflight = async proposal => {
    if(proposal?.type!=='owner_reminder')return;
    if(!readReminderInvoice)throw new APIError(503,'external_accounting_required');
    const invoice=await readReminderInvoice(proposal.payload?.invoiceId);
    if(!invoice||invoice.deleted_at)throw new APIError(409,'INVOICE_NOT_FOUND');
    if(hasExternalReminderLedger(invoice))throw new APIError(409,'external_accounting_required');
  };
  const call = async (name, args = {}) => {
    const result = await rpc(name, {...args,p_workspace_id:workspaceId,p_owner_id:ownerId});
    if (result?.error) throw new APIError(503, 'OWNER_CONVERSATION_UNAVAILABLE');
    return result?.data;
  };
  return Object.freeze({
    async offlineProvenance() {
      if(historyProvenance===undefined)await this.read();
      return historyProvenance;
    },
    async read() {
      const rows=await call('owner_assistant_history');
      if(!Array.isArray(rows))throw new APIError(503,'OWNER_CONVERSATION_UNAVAILABLE');
      historyProvenance=rows.some(row=>row.offline_provenance===true);
      const history=rows.filter(row=>row.offline_provenance!==true);
      if(historyProvenance)history.offlineProvenance=true;
      return history;
    },
    async append({key, role, content, pendingAction = null}) {
      const receipt=await call('owner_assistant_append', {
        p_event_key:key, p_channel:channel, p_role:role, p_content:content, p_pending_action:pendingAction,
      });
      if(!Number.isSafeInteger(Number(receipt?.id))||Number(receipt.id)<1)throw new APIError(503,'OWNER_CONVERSATION_UNAVAILABLE');
      return receipt;
    },
    async propose(proposal) {
      await reminderPreflight(proposal);
      return call('owner_assistant_propose', {p_proposal:proposal});
    },
    pending: () => call('owner_assistant_pending'),
    async decide(id, confirmed, proof = {}) {
      if(confirmed===true){
        if(!readProposal)throw new APIError(503,'OWNER_CONVERSATION_UNAVAILABLE');
        const proposal=await readProposal(id);
        if(proposal?.state==='pending')await reminderPreflight(proposal.action);
      }
      return call('owner_assistant_decide', {
      p_id:id, p_confirmed:confirmed, p_phone:proof.phone ?? null,
      p_message_id:proof.messageId ?? null, p_user_message:proof.message ?? null,
      });
    },
  });
}

export async function readSharedOwnerHistory({supabase, workspaceId, ownerId}) {
  const rows = await createOwnerConversation({rpc:(name,args)=>supabase.rpc(name,args), workspaceId, ownerId, channel:'whatsapp'}).read();
  if (!Array.isArray(rows)) throw new APIError(503, 'OWNER_CONVERSATION_UNAVAILABLE');
  const history=rows.map(({role,content,created_at,source_message_id,event_key,channel})=>({role,content,createdAt:created_at||null,providerMessageId:source_message_id||(channel==='whatsapp'&&role==='user'&&event_key?.startsWith('wa:')?event_key.slice(3,-5):null)}));
  // Server metadata is independent of bounded/pruned conversation text.
  if(rows.offlineProvenance===true)history.offlineProvenance=true;
  return history;
}
