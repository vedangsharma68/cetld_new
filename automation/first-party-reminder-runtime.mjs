import {createClient} from '@supabase/supabase-js';
import {createApprovedReminderProvider} from './whatsapp/approved-reminders.mjs';
import {createFirstPartyReminderReceiptStore,createDurableReminderProvider} from './whatsapp/reminder-receipts.mjs';
import {createLocalReminderPaymentChecker} from './local-reminder-payment.mjs';

// This mode is opt-in server configuration. No account/template/consent approval
// is inferred from its flags; the final SQL gate independently verifies them.
export function firstPartyReminderEnabled(env){
  return env.WHATSAPP_PROVIDER==='first_party_meta'
    &&['AUTOMATION_OUTBOUND_ENABLED','WHATSAPP_OUTBOUND_ENABLED','WHATSAPP_REMINDERS_ENABLED',
      'WHATSAPP_REMINDER_RECEIPTS_ENABLED','WHATSAPP_REMINDER_SCHEDULER_ENABLED'].every(key=>env[key]==='true');
}
export function createFirstPartyReminderRuntime({env=process.env,scope,store,supabase,fetchImpl=fetch}={}){
  if(!firstPartyReminderEnabled(env))throw Error('First-party reminders disabled');
  let scopes;
  try{scopes=JSON.parse(env.AUTOMATION_WORKSPACES);}catch{throw Error('Reviewed reminder configuration unavailable');}
  if(!Array.isArray(scopes)||scopes.length>1000||!scopes.some(item=>item.ownerId===scope.ownerId&&item.workspaceId===scope.workspaceId))throw Error('Reminder scope unavailable');
  // External accounting is deliberately unsupported by this candidate. All four
  // external ledger markers are denied by the local checker AND final SQL gate.
  if(env.WHATSAPP_REMINDER_PAYMENT_MODE!=='local_verified')throw Error('Reviewed payment verification unavailable');
  supabase ||= createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false},global:{fetch:fetchImpl}});
  const receiptStore=createFirstPartyReminderReceiptStore({supabase,env});
  if(!receiptStore.isEnabled())throw Error('Reminder receipt backend unavailable');
  const provider=createDurableReminderProvider({receiptStore,provider:createApprovedReminderProvider({
    env,supabase,store,ownerId:scope.ownerId,workspaceId:scope.workspaceId,fetchImpl})});
  return {provider,paymentChecker:createLocalReminderPaymentChecker({supabase,...scope}),async sweep(){
    // Let PostgreSQL supply its current clock; never use worker-controlled time.
    const result=await supabase.rpc('cetld_core_quarantine_first_party_leases',{
      p_owner_id:scope.ownerId,p_workspace_id:scope.workspaceId});
    if(result.error||!Number.isSafeInteger(result.data)||result.data<0)throw Error('Reminder lease sweep unavailable');
    return result.data;
  }};
}
