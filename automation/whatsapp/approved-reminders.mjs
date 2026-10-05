import {getSendEligibility} from './consent.mjs';
import {reminderFingerprint} from './reminder-fingerprint.mjs';
import {APPROVED_REMINDER_WABA,selectReminderTemplate,buildReminderTemplate} from './reminder-templates.mjs';
import {readBounded} from '../../ai/http.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QA=new Set(['+919871367051','+919818685252']);
const blocked=reason=>({status:'blocked',reason});

export function createApprovedReminderProvider({env=process.env,supabase,store,ownerId,workspaceId,fetchImpl=fetch}={}){
  function enabled(){return ['WHATSAPP_REMINDERS_ENABLED','AUTOMATION_OUTBOUND_ENABLED','WHATSAPP_OUTBOUND_ENABLED'].every(k=>env[k]==='true')
    &&env.WHATSAPP_WABA_ID===APPROVED_REMINDER_WABA&&/^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID||'')
    &&/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_API_VERSION||'')&&!!env.WHATSAPP_ACCESS_TOKEN;}
  function scope(input){return UUID.test(ownerId||'')&&UUID.test(workspaceId||'')&&input.workspaceId===workspaceId&&UUID.test(input.invoiceId||'');}
  function allowed(to){const configured=String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(v=>v.trim());return QA.has(to)&&configured.includes(to);}
  async function facts(input){
    if(!scope(input)||!allowed(input.to))throw Error('Reminder scope unavailable');
    const [invoice,settings,eligibility]=await Promise.all([
      store.getInvoice({ownerId,workspaceId,invoiceId:input.invoiceId}),
      store.getWorkspacePreferences({ownerId,workspaceId}),
      getSendEligibility({supabase,workspaceId,phone:input.to,category:'invoice_updates'}),
    ]);
    if(!eligibility.allowed||!invoice||invoice.deleted_at||!settings||invoice.customer_id!==eligibility.customer.id
      ||invoice.customerPhone!==input.to||invoice.status!=='sent'||invoice.metadata?.invoice_direction!=='receivable'
      ||!invoice.due_date||Number(invoice.total_amount)<=Number(invoice.amount_paid)
      ||!['approved','active','scheduled'].includes(invoice.followup_state))throw Error('Reminder facts unavailable');
    const entry=selectReminderTemplate(settings.follow_up_preferences);
    const parameters=[settings.business_name,invoice.invoice_number,eligibility.customer.name];
    const rendered=buildReminderTemplate(entry,parameters);
    return {invoice,settings,eligibility,entry,parameters,...rendered};
  }
  return {async prepareReminder(input){if(!enabled())throw Error('Reminder disabled');const result=await facts(input);return {body:result.body};},
    async sendReminder(input={}){
      if(!enabled())return blocked('disabled');
      if(!allowed(input.to))return blocked('test_allowlist');
      if(!scope(input)||!UUID.test(input.customerId||''))return blocked('scope');
      const prefix=`reminder:${workspaceId}:`,claimId=String(input.idempotencyKey||'').slice(prefix.length);
      if(!String(input.idempotencyKey||'').startsWith(prefix)||!UUID.test(claimId))return blocked('claim');
      let payload,callbackToken;
      try{
        const f=await facts(input);
        if(f.eligibility.customer.id!==input.customerId||f.body!==input.body)return blocked('reviewed_facts_changed');
        const snapshot={invoiceId:input.invoiceId,customerId:input.customerId,phone:input.to,body:f.body,
          invoiceVersion:f.invoice.automation_version,invoiceUpdatedAt:f.invoice.updated_at,preferencesUpdatedAt:f.settings.updated_at,
          consentId:f.eligibility.consent.id,consentCreatedAt:f.eligibility.consent.created_at,
          template:{name:f.entry.name,language:f.entry.language,body:f.entry.body,revision:f.entry.revision,
            wabaId:env.WHATSAPP_WABA_ID,phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,parameters:f.parameters}};
        const hash=reminderFingerprint(snapshot);
        payload={messaging_product:'whatsapp',recipient_type:'individual',to:input.to.slice(1),type:'template',template:f.template};
        const result=await supabase.rpc('cetld_core_authorize_first_party_reminder',{
          p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claimId,p_snapshot:snapshot,p_snapshot_hash:hash});
        if(result.error)return blocked('atomic_gate_unavailable');
        const receipt=Array.isArray(result.data)?result.data[0]:result.data;
        if(receipt?.authorized!==true||receipt.snapshot_hash!==hash||! /^[a-f0-9]{64}$/.test(receipt.callback_token||''))return blocked('atomic_gate_denied');
        callbackToken=receipt.callback_token;payload.biz_opaque_callback_data=callbackToken;
      }catch{return blocked('eligibility_unavailable');}
      // No asynchronous operation between the final atomic reservation and POST.
      try{
        const response=await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
          method:'POST',redirect:'error',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},
          body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000)});
        if(!response.ok)return {status:response.status>=500||response.status===408?'unknown':'failed'};
        const id=JSON.parse((await readBounded(response,64*1024)).toString('utf8'))?.messages?.[0]?.id;
        return typeof id==='string'&&id.trim()&&id.length<=256?{status:'accepted',providerMessageId:id,callbackToken}:{status:'unknown'};
      }catch{return {status:'unknown'};}
    }};
}
