import {OWNER_TEST_SCOPE} from './whatsapp/owner-test.mjs';
import {resolveOwnerBinding} from './whatsapp/owner-binding.mjs';
import {readApprovedReminderTemplates} from './whatsapp/template-diagnostic.mjs';
import {matchesApprovedReminderTemplate,APPROVED_REMINDER_FOOTER} from './whatsapp/reminder-templates.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_KEYS=['WHATSAPP_SCHEDULED_OWNER_TEST_START_AT','WHATSAPP_SCHEDULED_OWNER_TEST_END_AT'];
const MAX_WINDOW_MS=65*60*1000;
const utcSecond=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value.replace('Z','.000Z');
export const SCHEDULED_OWNER_TEST=Object.freeze({ownerId:OWNER_TEST_SCOPE.ownerId,workspaceId:OWNER_TEST_SCOPE.workspaceId,
  phone:OWNER_TEST_SCOPE.phone,sourceNumber:'CETLD-SCHED-TEST-20261017',
  note:'TEST ONLY: one owner-only scheduled reminder; no payment requested.',
  attemptKey:'scheduled-owner-test:20261017:v1'});

// Absence preserves production behavior. Any partial/disabled test configuration
// blocks scheduler work instead of falling back to a workspace-wide tick.
export function scheduledOwnerTestWindowOpen(test,now=new Date()){
  const at=Number(now);
  return Number.isFinite(at)&&at>=test.startMs&&at<test.endMs;
}

export function scheduledOwnerTestMode(env,now=new Date()){
  if(['WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED','WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID',...WINDOW_KEYS]
    .every(key=>env[key]===undefined))return {mode:'off'};
  const invoiceId=env.WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID;
  if(env.WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED!=='true'||!UUID.test(invoiceId||'')
    ||invoiceId===OWNER_TEST_SCOPE.invoiceId||env.WHATSAPP_PROVIDER!=='first_party_meta')return {mode:'blocked'};
  const [startAt,endAt]=WINDOW_KEYS.map(key=>env[key]);
  if(!utcSecond(startAt)||!utcSecond(endAt))return {mode:'blocked'};
  const startMs=Date.parse(startAt),endMs=Date.parse(endAt);
  if(endMs<=startMs||endMs-startMs>MAX_WINDOW_MS||!scheduledOwnerTestWindowOpen({startMs,endMs},now))return {mode:'blocked'};
  let scopes;try{scopes=JSON.parse(env.AUTOMATION_WORKSPACES||'null');}catch{return {mode:'blocked'};}
  const s=SCHEDULED_OWNER_TEST;
  if(!Array.isArray(scopes)||scopes.length!==1||!scopes[0]||scopes[0].ownerId!==s.ownerId||scopes[0].workspaceId!==s.workspaceId
    ||Object.keys(scopes[0]).some(key=>!['ownerId','workspaceId'].includes(key)))return {mode:'blocked'};
  return {mode:'test',...s,invoiceId,startAt,endAt,startMs,endMs};
}

export function scheduledOwnerTestScopeMatches(test,scope){
  return test.mode==='test'&&scope.ownerId===test.ownerId&&scope.workspaceId===test.workspaceId
    &&(scope.invoiceId===undefined||scope.invoiceId===test.invoiceId);
}

export function createScheduledOwnerTestGate({test,env,supabase,store,fetchImpl,clock=()=>new Date()}){
  if(test?.mode!=='test'||!supabase?.from)throw Error('Scheduled owner test unavailable');
  const isOpen=()=>scheduledOwnerTestWindowOpen(test,clock());
  const assertOpen=()=>{if(!isOpen())throw Error('Scheduled owner test window closed');};
  const check=result=>{if(result?.error)throw result.error;return result?.data;};
  async function verifyInvoice(invoice){
    assertOpen();
    if(!invoice||invoice.id!==test.invoiceId||invoice.workspace_id!==test.workspaceId||invoice.deleted_at
      ||invoice.metadata?.source_invoice_number!==test.sourceNumber||invoice.notes!==test.note
      ||invoice.currency!=='USD'||Number(invoice.total_amount)!==1||Number(invoice.amount_paid)!==0
      ||Number(invoice.reminder_count)!==0||invoice.customerPhone!==test.phone)throw Error('Scheduled test fixture mismatch');
    const owner=await resolveOwnerBinding({supabase,phone:test.phone});
    assertOpen();
    if(owner?.ownerId!==test.ownerId||owner.workspaceId!==test.workspaceId||owner.customerId!==invoice.customer_id)
      throw Error('Scheduled test owner mismatch');
    return owner;
  }
  return Object.freeze({
    isOpen,
    async consumed(){
      assertOpen();
      const consumed=Boolean(check(await supabase.from('cetld_core_automation_events').select('id')
        .eq('workspace_id',test.workspaceId).eq('idempotency_key',test.attemptKey).maybeSingle()));
      assertOpen();return consumed;
    },
    async review(){assertOpen();await verifyInvoice(await store.getInvoice(test));},
    async verifyFacts({invoice,settings,entry}){
      const owner=await verifyInvoice(invoice);
      if(settings.business_name?.trim()!==owner.businessName||entry.name!=='cetld_invoice_update_v2')
        throw Error('Scheduled test template mismatch');
      const metadata=await readApprovedReminderTemplates({env,fetchImpl});
      assertOpen();
      const actual=metadata.templates.find(t=>t.name===entry.name&&t.language==='en');
      if(!matchesApprovedReminderTemplate(actual,entry)||!actual.components.some(c=>c.type==='FOOTER'&&c.text===APPROVED_REMINDER_FOOTER))
        throw Error('Scheduled test approval mismatch');
    },
    async claimAttempt(){
      assertOpen();
      // The existing unique(workspace_id,idempotency_key) is the atomic one-use
      // reservation. Never delete/reset it, even after rejection or uncertainty.
      const rows=check(await supabase.from('cetld_core_automation_events').upsert({workspace_id:test.workspaceId,invoice_id:test.invoiceId,
        type:'scheduled_owner_test_attempt',idempotency_key:test.attemptKey,
        metadata:{version:1,invoiceId:test.invoiceId,recipient:test.phone,startAt:test.startAt,endAt:test.endAt}},
      {onConflict:'workspace_id,idempotency_key',ignoreDuplicates:true}).select('id'));
      assertOpen();
      return Array.isArray(rows)&&rows.length===1;
    },
  });
}
