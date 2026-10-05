import {reminderFingerprint} from './reminder-fingerprint.mjs';
import {getSendEligibility} from './consent.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QA=new Set(['+919871367051','+919818685252']);
const blocked=reason=>({status:'blocked',reason});

/** Review-only adapter. Not registered with the factory/runtime. The required
 * final atomic gate deliberately does not exist in the deployed schema.
 * templateSnapshot and fixed owner/workspace are trusted server configuration,
 * never model arguments. No arbitrary text or recipient selection is exposed.
 */
export function createFirstPartyReminderProvider({env=process.env,supabase,store,ownerId,workspaceId,templateSnapshot,fetchImpl=fetch}={}) {
  const template=templateSnapshot?structuredClone(templateSnapshot):null;
  const validTemplate=template?.status==='APPROVED'&&template.category==='UTILITY'
    &&template.useCase==='first_party_invoice_reminder'&&/^[a-z][a-z0-9_]{0,511}$/.test(template.name||'')
    &&/^[a-z]{2}(?:_[A-Z]{2})?$/.test(template.language||'')&&typeof template.body==='string'
    &&/^[A-Za-z0-9._:-]{1,128}$/.test(template.revision||'')
    &&/^\d{5,30}$/.test(template.wabaId||'')&&/^\d{5,30}$/.test(template.phoneNumberId||'')
    &&template.body.length<=1000&&[1,2,3,4,5,6].every(n=>template.body.includes(`{{${n}}}`))
    &&!template.body.replace(/\{\{[1-6]\}\}/g,'').includes('{{');
  return {async sendReminder(input={}) {
    if(env.WHATSAPP_REMINDERS_ENABLED!=='true'||env.AUTOMATION_OUTBOUND_ENABLED!=='true'||env.WHATSAPP_OUTBOUND_ENABLED!=='true')return blocked('disabled');
    const allowlist=String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(s=>s.trim());
    if(!QA.has(input.to)||!allowlist.includes(input.to))return blocked('test_allowlist');
    if(!UUID.test(ownerId||'')||!UUID.test(workspaceId||'')||input.workspaceId!==workspaceId
      ||!UUID.test(input.invoiceId||'')||!UUID.test(input.customerId||''))return blocked('scope');
    const prefix=`reminder:${workspaceId}:`,claimId=String(input.idempotencyKey||'').slice(prefix.length);
    if(!String(input.idempotencyKey||'').startsWith(prefix)||!UUID.test(claimId))return blocked('idempotency_key');
    if(!validTemplate)return blocked('unreviewed_template');
    if(!env.WHATSAPP_ACCESS_TOKEN||!/^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID||'')||!/^\d{5,30}$/.test(env.WHATSAPP_WABA_ID||'')||!/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_API_VERSION||''))return blocked('missing_configuration');
    if(template.wabaId!==env.WHATSAPP_WABA_ID||template.phoneNumberId!==env.WHATSAPP_PHONE_NUMBER_ID)return blocked('template_account_mismatch');
    if(!store?.getInvoice||!store?.getWorkspacePreferences||!supabase?.rpc)return blocked('missing_store');
    let snapshot,payload,hash,callbackToken;
    try {
      const scope={ownerId,workspaceId,invoiceId:input.invoiceId};
      const invoice=await store.getInvoice(scope),settings=await store.getWorkspacePreferences(scope);
      if(!invoice||invoice.deleted_at)return blocked('invoice_unavailable');
      if(invoice.customer_id!==input.customerId)return blocked('customer_changed');
      if(invoice.status!=='sent'||invoice.metadata?.invoice_direction!=='receivable'||Number(invoice.amount_paid)>=Number(invoice.total_amount))return blocked('invoice_not_remindable');
      if(!['approved','active','scheduled'].includes(invoice.followup_state))return blocked('paused_or_unreviewed');
      if(!settings?.business_name||new Date(invoice.metadata?.approved_preferences_updated_at).getTime()!==new Date(settings.updated_at).getTime())return blocked('stale_review');
      const eligibility=await getSendEligibility({supabase,workspaceId,phone:input.to});
      if(!eligibility.allowed)return blocked(eligibility.reason);
      if(eligibility.customer.id!==input.customerId||invoice.customerPhone!==input.to)return blocked('customer_changed');
      const money=value=>/^\d+(?:\.\d{1,2})?$/.test(String(value))&&Number.isSafeInteger(Math.round(Number(value)*100));
      if(!money(invoice.total_amount)||!money(invoice.amount_paid))return blocked('invalid_invoice_facts');
      const remaining=(Math.round(Number(invoice.total_amount)*100)-Math.round(Number(invoice.amount_paid)*100))/100;
      // Supabase date strings and isolated SQL's midnight-UTC date encoding.
      const dueDate=/^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/.test(invoice.due_date||'')?invoice.due_date.slice(0,10):null;
      if(!Number.isFinite(remaining)||remaining<=0||!dueDate||! /^[A-Z]{3}$/.test(invoice.currency||''))return blocked('invalid_invoice_facts');
      const parameters=[settings.business_name,eligibility.customer.name,invoice.invoice_number,remaining.toFixed(2),invoice.currency,dueDate];
      if(parameters.some(value=>typeof value!=='string'||!value.trim()||value.length>256||/[\r\n{}]/.test(value)))return blocked('invalid_invoice_facts');
      const body=template.body.replace(/\{\{([1-6])\}\}/g,(_,n)=>parameters[Number(n)-1]);
      if(body!==input.body||body!==invoice.metadata?.approved_reminder_text)return blocked('reviewed_body_mismatch');
      snapshot={invoiceId:input.invoiceId,customerId:input.customerId,phone:input.to,body,
        invoiceVersion:invoice.automation_version,invoiceUpdatedAt:invoice.updated_at,preferencesUpdatedAt:settings.updated_at,
        consentId:eligibility.consent.id,consentCreatedAt:eligibility.consent.created_at,
        template:{name:template.name,language:template.language,body:template.body,revision:template.revision,
          wabaId:template.wabaId,phoneNumberId:template.phoneNumberId,parameters}};
      hash=reminderFingerprint(snapshot);
      payload={messaging_product:'whatsapp',recipient_type:'individual',to:input.to.slice(1),type:'template',
        template:{name:template.name,language:{code:template.language},components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}};
      // Required future RPC: lock owner/workspace, claim, invoice, preferences,
      // customer, consent and suppression; validate this entire snapshot; reserve
      // one dispatch durably. Missing/failed gate never falls back to old SQL.
      const gate=await supabase.rpc('cetld_core_authorize_first_party_reminder',{
        p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claimId,p_snapshot:snapshot,p_snapshot_hash:hash});
      if(gate?.error)return blocked('atomic_gate_unavailable');
      const receipt=Array.isArray(gate.data)?gate.data[0]:gate.data;
      if(receipt?.authorized!==true)return blocked('atomic_gate_denied');
      if(receipt.snapshot_hash!==hash||! /^[a-f0-9]{64}$/.test(receipt.callback_token||''))return blocked('invalid_gate_receipt');
      payload.biz_opaque_callback_data=receipt.callback_token;
      callbackToken=receipt.callback_token;
    }catch{return blocked('eligibility_unavailable');}
    // No asynchronous operation between final gate completion and HTTP dispatch.
    try {
      const response=await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
        method:'POST',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok)return {status:response.status>=500||response.status===408?'unknown':'failed'};
      const result=await response.json();
      const id=result?.messages?.[0]?.id;
      return typeof id==='string'&&id.trim()&&id.length<=256?{status:'accepted',providerMessageId:id,callbackToken}:{status:'unknown'};
    }catch{return {status:'unknown'};}
  }};
}
