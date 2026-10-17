import {OWNER_TEST_SCOPE} from './whatsapp/owner-test.mjs';
import {resolveOwnerBinding} from './whatsapp/owner-binding.mjs';
import {readApprovedReminderTemplates} from './whatsapp/template-diagnostic.mjs';
import {matchesApprovedReminderTemplate,APPROVED_REMINDER_FOOTER} from './whatsapp/reminder-templates.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCHEDULED_OWNER_TEST=Object.freeze({ownerId:OWNER_TEST_SCOPE.ownerId,workspaceId:OWNER_TEST_SCOPE.workspaceId,
  phone:OWNER_TEST_SCOPE.phone,sourceNumber:'CETLD-SCHED-TEST-20261017',
  note:'TEST ONLY: one owner-only scheduled reminder; no payment requested.',
  attemptKey:'scheduled-owner-test:20261017:v1'});

// Absence preserves production behavior. Any partial/disabled test configuration
// blocks scheduler work instead of falling back to a workspace-wide tick.
export function scheduledOwnerTestMode(env){
  if(env.WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED===undefined&&env.WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID===undefined)return {mode:'off'};
  const invoiceId=env.WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID;
  if(env.WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED!=='true'||!UUID.test(invoiceId||'')
    ||invoiceId===OWNER_TEST_SCOPE.invoiceId||env.WHATSAPP_PROVIDER!=='first_party_meta')return {mode:'blocked'};
  let scopes;try{scopes=JSON.parse(env.AUTOMATION_WORKSPACES||'null');}catch{return {mode:'blocked'};}
  const s=SCHEDULED_OWNER_TEST;
  if(!Array.isArray(scopes)||scopes.length!==1||!scopes[0]||scopes[0].ownerId!==s.ownerId||scopes[0].workspaceId!==s.workspaceId
    ||Object.keys(scopes[0]).some(key=>!['ownerId','workspaceId'].includes(key)))return {mode:'blocked'};
  return {mode:'test',...s,invoiceId};
}

export function scheduledOwnerTestScopeMatches(test,scope){
  return test.mode==='test'&&scope.ownerId===test.ownerId&&scope.workspaceId===test.workspaceId
    &&(scope.invoiceId===undefined||scope.invoiceId===test.invoiceId);
}

export function createScheduledOwnerTestGate({test,env,supabase,store,fetchImpl}){
  if(test?.mode!=='test'||!supabase?.from)throw Error('Scheduled owner test unavailable');
  const check=result=>{if(result?.error)throw result.error;return result?.data;};
  async function verifyInvoice(invoice){
    if(!invoice||invoice.id!==test.invoiceId||invoice.workspace_id!==test.workspaceId||invoice.deleted_at
      ||invoice.metadata?.source_invoice_number!==test.sourceNumber||invoice.notes!==test.note
      ||invoice.currency!=='USD'||Number(invoice.total_amount)!==1||Number(invoice.amount_paid)!==0
      ||Number(invoice.reminder_count)!==0||invoice.customerPhone!==test.phone)throw Error('Scheduled test fixture mismatch');
    const owner=await resolveOwnerBinding({supabase,phone:test.phone});
    if(owner?.ownerId!==test.ownerId||owner.workspaceId!==test.workspaceId||owner.customerId!==invoice.customer_id)
      throw Error('Scheduled test owner mismatch');
    return owner;
  }
  return Object.freeze({
    async consumed(){
      return Boolean(check(await supabase.from('cetld_core_automation_events').select('id')
        .eq('workspace_id',test.workspaceId).eq('idempotency_key',test.attemptKey).maybeSingle()));
    },
    async review(){await verifyInvoice(await store.getInvoice(test));},
    async verifyFacts({invoice,settings,entry}){
      const owner=await verifyInvoice(invoice);
      if(settings.business_name?.trim()!==owner.businessName||entry.name!=='cetld_invoice_update_v2')
        throw Error('Scheduled test template mismatch');
      const metadata=await readApprovedReminderTemplates({env,fetchImpl});
      const actual=metadata.templates.find(t=>t.name===entry.name&&t.language==='en');
      if(!matchesApprovedReminderTemplate(actual,entry)||!actual.components.some(c=>c.type==='FOOTER'&&c.text===APPROVED_REMINDER_FOOTER))
        throw Error('Scheduled test approval mismatch');
    },
    async claimAttempt(){
      // The existing unique(workspace_id,idempotency_key) is the atomic one-use
      // reservation. Never delete/reset it, even after rejection or uncertainty.
      const rows=check(await supabase.from('cetld_core_automation_events').upsert({workspace_id:test.workspaceId,invoice_id:test.invoiceId,
        type:'scheduled_owner_test_attempt',idempotency_key:test.attemptKey,
        metadata:{version:1,invoiceId:test.invoiceId,recipient:test.phone}},
      {onConflict:'workspace_id,idempotency_key',ignoreDuplicates:true}).select('id'));
      return Array.isArray(rows)&&rows.length===1;
    },
  });
}
