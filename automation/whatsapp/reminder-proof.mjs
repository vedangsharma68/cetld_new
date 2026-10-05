import {APIError} from '../../ai/http.mjs';
import {getSendEligibility} from './consent.mjs';
import {selectReminderTemplate,buildReminderTemplate,APPROVED_REMINDER_WABA} from './reminder-templates.mjs';
import {readApprovedReminderTemplates} from './template-diagnostic.mjs';
import {createConversationStore,conversationCallbackToken} from './conversation-store.mjs';
import {readBounded} from '../../ai/http.mjs';

export const REMINDER_PROOF_PHONE='+919871367051';
export const REMINDER_PROOF_NUMBER='CETLD-TEST-20261005';
export const reminderProofKey='approved-template-proof:20261005';

// Called only inside the existing authenticated owner/operator test endpoint.
export async function approvedReminderProof({workspaceId,ownerId,env,supabase,fetchImpl=fetch,send=false}){
  if(env.WHATSAPP_WABA_ID!==APPROVED_REMINDER_WABA||!String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(v=>v.trim()).includes(REMINDER_PROOF_PHONE))throw new APIError(409,'TEST_RECIPIENT_REQUIRED');
  const [settings,eligibility]=await Promise.all([
    supabase.from('workspace_settings').select('business_name').eq('workspace_id',workspaceId).maybeSingle(),
    getSendEligibility({supabase,workspaceId,phone:REMINDER_PROOF_PHONE}),
  ]);
  if(settings.error||!eligibility.allowed)throw new APIError(409,'TEST_RECIPIENT_INELIGIBLE');
  const entry=selectReminderTemplate({tone:'professional'});
  const parameters=[settings.data?.business_name,REMINDER_PROOF_NUMBER,eligibility.customer.name];
  let rendered;try{rendered=buildReminderTemplate(entry,parameters);}catch{throw new APIError(409,'TEST_FACTS_REQUIRED');}
  const metadata=await readApprovedReminderTemplates({env,fetchImpl});
  const actual=metadata.templates.find(t=>t.name===entry.name&&t.language==='en');
  const bodies=actual?.components?.filter(c=>c.type==='BODY')||[];
  if(!actual?.found||actual.status!=='APPROVED'||actual.category!=='UTILITY'||bodies.length!==1||bodies[0].text!==entry.body
    ||actual.components.some(c=>c.type==='HEADER'||c.type==='BUTTONS'))throw new APIError(409,'APPROVED_TEST_TEMPLATE_MISMATCH');
  const intent={workspaceId,customerId:eligibility.customer.id,invoiceId:null,phone:REMINDER_PROOF_PHONE,
    direction:'outbound',audience:'customer',body:rendered.body,kind:'invoice_update',status:'pending',key:reminderProofKey};
  if(!send)return {test:true,synthetic:true,recipient:REMINDER_PROOF_PHONE,templateName:entry.name,language:'en',
    parameters,text:rendered.body,providerTemplateId:actual.id,migrationRequired:true,idempotencyKey:reminderProofKey};
  const callbackToken=conversationCallbackToken(workspaceId,reminderProofKey);
  const claim=await supabase.rpc('cetld_core_claim_reminder_proof',{
    p_owner_id:ownerId,p_workspace_id:workspaceId,p_customer_id:eligibility.customer.id,
    p_body:rendered.body,p_callback_token:callbackToken,
  });
  if(claim.error)throw new APIError(503,'REMINDER_MIGRATION_REQUIRED');
  if(claim.data?.claimed!==true)return {status:'blocked',reason:claim.data?.reason||'proof_already_claimed'};
  // The SQL gate durably reserves this exact one-time proof and rechecks consent,
  // phone, business/customer facts and suppression. No async work before POST.
  let result;
  try{
    const response=await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:REMINDER_PROOF_PHONE.slice(1),
        type:'template',template:rendered.template,biz_opaque_callback_data:callbackToken}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)result={status:response.status>=500||response.status===408?'unknown':'failed'};
    else{
      const id=JSON.parse((await readBounded(response,64*1024)).toString('utf8'))?.messages?.[0]?.id;
      result=typeof id==='string'&&id.trim()&&id.length<=256?{status:'accepted',providerMessageId:id}:{status:'unknown'};
    }
  }catch{result={status:'unknown'};}
  try{await createConversationStore(supabase).finish({workspaceId,key:reminderProofKey,...result});}
  catch{return {...result,historySyncPending:true};}
  return {...result,recipient:REMINDER_PROOF_PHONE,templateName:entry.name,language:'en',synthetic:true};
}
