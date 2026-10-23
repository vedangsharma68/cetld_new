import {brandedReminder} from '../preferences.mjs';
import {reminderDeliveryForm,matchesReminderDelivery,hasPersistedLegacyReminderApproval} from './reminder-approval.mjs';
import {getSendEligibility} from './consent.mjs';
import {getCommercialRecipientEligibility} from './commercial-recipient.mjs';
import {reminderFingerprint} from './reminder-fingerprint.mjs';
import {APPROVED_REMINDER_WABA,REMINDER_TEMPLATES,selectReminderTemplate,selectInvoiceReminderTemplate,buildReminderTemplate} from './reminder-templates.mjs';
import {buildInvoiceReminderParameters,buildDefaultInvoiceReminderDraft} from './reminder-parameters.mjs';
import {readBounded} from '../../ai/http.mjs';
import {hasUnresolvedFollowUpException} from '../preferences.mjs';
import {scheduledOwnerTestMode,scheduledOwnerTestScopeMatches,createScheduledOwnerTestGate} from '../scheduled-owner-test.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QA=new Set(['+919871367051','+919818685252']);
const blocked=reason=>({status:'blocked',reason});

export function createApprovedReminderProvider({env=process.env,supabase,store,ownerId,workspaceId,fetchImpl=fetch,clock=()=>new Date()}={}){
  const test=scheduledOwnerTestMode(env,clock());
  const testGate=test.mode==='test'?createScheduledOwnerTestGate({test,env,supabase,store,fetchImpl,clock}):null;
  function enabled(){return ['WHATSAPP_REMINDERS_ENABLED','AUTOMATION_OUTBOUND_ENABLED','WHATSAPP_OUTBOUND_ENABLED'].every(k=>env[k]==='true')
    &&test.mode!=='blocked'&&(test.mode!=='test'||testGate.isOpen()&&scheduledOwnerTestScopeMatches(test,{ownerId,workspaceId}))
    &&env.WHATSAPP_WABA_ID===APPROVED_REMINDER_WABA&&/^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID||'')
    &&/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_API_VERSION||'')&&!!env.WHATSAPP_ACCESS_TOKEN;}
  function scope(input){return UUID.test(ownerId||'')&&UUID.test(workspaceId||'')&&input.workspaceId===workspaceId&&UUID.test(input.invoiceId||'')
    &&(test.mode!=='test'||input.invoiceId===test.invoiceId&&input.to===test.phone);}
  async function recipientBlock(to){
    if(env.WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED==='true'){
      const eligibility=await getCommercialRecipientEligibility({env,supabase,workspaceId,phone:to});
      return eligibility.allowed?null:blocked(eligibility.reason);
    }else{
      // Default test mode retains the fixed QA set AND configured allowlist.
      const configured=String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(v=>v.trim());
      return QA.has(to)&&configured.includes(to)?null:blocked('test_allowlist');
    }
  }
  async function facts(input){
    if(!scope(input)||await recipientBlock(input.to))throw Error('Reminder scope unavailable');
    const [invoice,settings,eligibility]=await Promise.all([
      store.getInvoice({ownerId,workspaceId,invoiceId:input.invoiceId}),
      store.getWorkspacePreferences({ownerId,workspaceId}),
      getSendEligibility({supabase,workspaceId,phone:input.to,category:'invoice_updates'}),
    ]);
    if(!eligibility.allowed||!invoice||invoice.deleted_at||hasUnresolvedFollowUpException(invoice)||!settings||invoice.customer_id!==eligibility.customer.id
      ||invoice.customerPhone!==input.to||invoice.status!=='sent'||invoice.metadata?.invoice_direction!=='receivable'
      ||!invoice.due_date||Number(invoice.total_amount)<=Number(invoice.amount_paid)
      ||!['approved','active','scheduled'].includes(invoice.followup_state))throw Error('Reminder facts unavailable');
    const reviewed=invoice.metadata?.approved_reminder_delivery;
    if(reviewed?.version===2&&!testGate){
      const checked=await supabase.rpc('owner_assistant_reminder_dispatch_preview',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:invoice.id});
      const evaluation=checked?.data;
      if(checked?.error||evaluation?.ok!==true)throw Object.assign(Error('The exact reminder delivery needs re-review.'),{code:'DELIVERY_REVIEW_REQUIRED',reason:evaluation?.reason});
      const delivery=evaluation.delivery;
      const entry=delivery.type==='template'?REMINDER_TEMPLATES.find(t=>t.name===delivery.name&&t.language===delivery.language&&t.revision===delivery.revision):selectInvoiceReminderTemplate({},reviewed.tone);
      if(!entry)throw Object.assign(Error('The approved template is unavailable.'),{code:'DELIVERY_REVIEW_REQUIRED'});
      const parameters=entry.parameterCount===3?[settings.business_name,invoice.invoice_number,eligibility.customer.name]:buildInvoiceReminderParameters({invoice,settings,customer:eligibility.customer});
      const rendered=buildReminderTemplate(entry,parameters);
      if(delivery.type==='template'&&!matchesReminderDelivery(delivery,reminderDeliveryForm({entry,parameters,body:rendered.body})))throw Object.assign(Error('The approved template facts changed.'),{code:'DELIVERY_REVIEW_REQUIRED'});
      if(delivery.type==='freeform'&&(delivery.body!==reviewed.body||reviewed.type!=='freeform'))throw Object.assign(Error('The approved words changed.'),{code:'DELIVERY_REVIEW_REQUIRED'});
      return {invoice,settings,eligibility,entry,parameters,delivery,body:delivery.body,template:rendered.template,deliveryForm:evaluation.form,windowDeadline:evaluation.windowDeadline};
    }
    const entry=testGate?selectReminderTemplate(settings.follow_up_preferences)
      :selectInvoiceReminderTemplate(settings.follow_up_preferences,eligibility.customer.reminder_tone??null);
    const parameters=entry.parameterCount===3?[settings.business_name,invoice.invoice_number,eligibility.customer.name]
      :buildInvoiceReminderParameters({invoice,settings,customer:eligibility.customer});
    const rendered=buildReminderTemplate(entry,parameters);
    if(testGate)await testGate.verifyFacts({invoice,settings,entry});
    const delivery=reminderDeliveryForm({entry,parameters,body:rendered.body});
    if(!matchesReminderDelivery(reviewed,delivery)||invoice.metadata?.approved_reminder_text!==brandedReminder(rendered.body,settings.business_name))throw Object.assign(new Error('The outgoing words and delivery form need review.'),{code:'DELIVERY_REVIEW_REQUIRED'});
    if(!await hasPersistedLegacyReminderApproval({supabase,ownerId,workspaceId,invoiceId:invoice.id,delivery,approvedText:invoice.metadata.approved_reminder_text}))
      throw Object.assign(new Error('The reminder approval record needs review.'),{code:'DELIVERY_REVIEW_REQUIRED'});
    return {invoice,settings,eligibility,entry,parameters,delivery,...rendered};
  }
  return {async prepareReminder(input){if(!enabled())throw Error('Reminder disabled');const result=await facts(input);return {body:result.body,delivery:result.delivery};},
    async sendReminder(input={}){
      if(!enabled())return blocked('disabled');
      const recipientDenied=await recipientBlock(input.to);
      if(recipientDenied)return recipientDenied;
      if(!scope(input)||!UUID.test(input.customerId||''))return blocked('scope');
      const prefix=`reminder:${workspaceId}:`,claimId=String(input.idempotencyKey||'').slice(prefix.length);
      if(!String(input.idempotencyKey||'').startsWith(prefix)||!UUID.test(claimId))return blocked('claim');
      let payload,callbackToken,serviceDeadline;
      try{
        const f=await facts(input);
        if(f.eligibility.customer.id!==input.customerId||f.body!==input.body&&f.deliveryForm!=='template_fallback')return blocked('reviewed_facts_changed');
        const snapshot={invoiceId:input.invoiceId,customerId:input.customerId,phone:input.to,body:f.body,
          invoiceVersion:f.invoice.automation_version,invoiceUpdatedAt:f.invoice.updated_at,preferencesUpdatedAt:f.settings.updated_at,
          delivery:f.delivery,...(f.deliveryForm?{deliveryForm:f.deliveryForm}:{}),consentId:f.eligibility.consent.id,consentCreatedAt:f.eligibility.consent.created_at,
          template:{name:f.entry.name,language:f.entry.language,body:f.entry.body,revision:f.entry.revision,
            wabaId:env.WHATSAPP_WABA_ID,phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,parameters:f.parameters}};
        if(f.entry.parameterCount===5)snapshot.defaultDraft=buildDefaultInvoiceReminderDraft({invoice:f.invoice,settings:f.settings,customer:f.eligibility.customer});
        const hash=reminderFingerprint(snapshot);
        payload={messaging_product:'whatsapp',recipient_type:'individual',to:input.to.slice(1),...(f.delivery.type==='freeform'?{type:'text',text:{preview_url:false,body:f.body}}:{type:'template',template:f.template})};
        serviceDeadline=f.delivery.type==='freeform'?Date.parse(f.windowDeadline):null;
        if(testGate&&!await testGate.claimAttempt())return blocked('scheduled_owner_test_already_attempted');
        const result=await supabase.rpc('cetld_core_authorize_first_party_reminder',{
          p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claimId,p_snapshot:snapshot,p_snapshot_hash:hash});
        if(result.error)return blocked('atomic_gate_unavailable');
        const receipt=Array.isArray(result.data)?result.data[0]:result.data;
        if(receipt?.authorized!==true&&receipt?.reason==='needs_re_review')return blocked('needs_re_review');
        if(receipt?.authorized!==true||! /^[a-f0-9]{64}$/.test(receipt.callback_token||''))return blocked('atomic_gate_denied');
        if(f.deliveryForm){
          const approved=f.invoice.metadata.approved_reminder_delivery,d=receipt.delivery;
          const permitted=d?.type==='freeform'&&approved.type==='freeform'&&receipt.deliveryForm==='freeform'&&d.body===approved.body
            ||d?.type==='template'&&(approved.type==='template'&&receipt.deliveryForm==='template'&&matchesReminderDelivery(approved,d)
              ||approved.type==='freeform'&&receipt.deliveryForm==='template_fallback'&&matchesReminderDelivery(approved.fallback,d));
          const finalSnapshot={...snapshot,body:d?.body,delivery:d,deliveryForm:receipt.deliveryForm};
          if(!permitted||reminderFingerprint(finalSnapshot)!==receipt.snapshot_hash)return blocked('atomic_gate_denied');
          if(d.type==='freeform'){
            serviceDeadline=Date.parse(receipt.windowDeadline);
            if(!Number.isFinite(serviceDeadline))return blocked('atomic_gate_denied');
            payload.type='text';payload.text={preview_url:false,body:d.body};delete payload.template;
          }else{
            const entry=REMINDER_TEMPLATES.find(t=>t.name===d.name&&t.language===d.language&&t.revision===d.revision);
            const rendered=entry&&buildReminderTemplate(entry,d.parameters);
            if(!rendered||rendered.body!==d.body)return blocked('atomic_gate_denied');
            payload.type='template';payload.template=rendered.template;delete payload.text;serviceDeadline=null;
          }
        }else if(receipt.snapshot_hash!==hash)return blocked('atomic_gate_denied');
        callbackToken=receipt.callback_token;payload.biz_opaque_callback_data=callbackToken;
      }catch(error){return blocked(error?.code==='DELIVERY_REVIEW_REQUIRED'?'needs_re_review':'eligibility_unavailable');}
      // No asynchronous operation between the final atomic reservation and POST.
      if(serviceDeadline!==null&&serviceDeadline<=clock().getTime()){
        // No HTTP dispatch follows this branch. Persist the freshly evaluated
        // expiry/hold reason if the window closed while the reservation returned.
        try{await supabase.rpc('owner_assistant_reminder_dispatch_preview',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:input.invoiceId});}catch{}
        return blocked('needs_re_review');
      }
      if(testGate&&!testGate.isOpen())return blocked('scheduled_owner_test_window_closed');
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
