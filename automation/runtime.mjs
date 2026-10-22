import { config as appConfig } from '../config.js';
import { FollowUpEngine, isPaid } from './engine.mjs';
import { SupabaseAutomationStore } from './store.mjs';
import { CoreAutomationStore } from './core-store.mjs';
import { createWhatsAppProvider, normalizeInboundEvent } from './whatsapp/index.mjs';
import { createAccountingIntegration, SupabaseAccountingStore, TokenCipher, encryptionKeyFromEnv, createAccountingProviders } from './accounting/index.mjs';
import { HttpError, required } from './http.mjs';
import { scheduleInitialFollowUp, nextContactTime, timezoneParts, addLocalDays } from './cadence.mjs';
import { normalizeFollowUpPreferences,hasUnresolvedFollowUpException } from './preferences.mjs';
import {createFirstPartyReminderRuntime,firstPartyReminderEnabled} from './first-party-reminder-runtime.mjs';
import {scheduledOwnerTestMode,scheduledOwnerTestScopeMatches} from './scheduled-owner-test.mjs';
import {invoiceSyncPersistence} from './invoice-sync-store.mjs';

export function createAccountingRuntime({env=process.env,fetchImpl=fetch}={}) {
  const store=new SupabaseAccountingStore({url:env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || appConfig.url,serviceRoleKey:required(env,'SUPABASE_SERVICE_ROLE_KEY'),fetchImpl});
  const integration=createAccountingIntegration({
    store,
    cipher:new TokenCipher(encryptionKeyFromEnv(env.ACCOUNTING_TOKEN_ENCRYPTION_KEY)),
    providers:createAccountingProviders({
      zoho_books:{clientId:env.ZOHO_BOOKS_CLIENT_ID,clientSecret:env.ZOHO_BOOKS_CLIENT_SECRET,redirectUri:env.ZOHO_BOOKS_REDIRECT_URI,region:env.ZOHO_BOOKS_REGION || 'com',fetchImpl},
      quickbooks:{clientId:env.QUICKBOOKS_SANDBOX==='true'?env.QUICKBOOKS_SANDBOX_CLIENT_ID:env.QUICKBOOKS_PRODUCTION_CLIENT_ID,clientSecret:env.QUICKBOOKS_SANDBOX==='true'?env.QUICKBOOKS_SANDBOX_CLIENT_SECRET:env.QUICKBOOKS_PRODUCTION_CLIENT_SECRET,redirectUri:env.QUICKBOOKS_REDIRECT_URI,sandbox:env.QUICKBOOKS_SANDBOX==='true',fetchImpl}
    })
  });
  return Object.freeze({...integration,
    // The database deliberately protects external linkage from authenticated
    // writes. Complete only the claimed, active invoice through this runtime.
    async finishInvoiceSync(claimed,metadata,fields) {
      const read=async id=>(await store.request(`invoices?${new URLSearchParams({workspace_id:`eq.${claimed.workspace_id}`,id:`eq.${id}`,deleted_at:'is.null',select:'*',limit:'1'})}`))?.[0] || null;
      const patch=async(row,body)=>(await store.request(`invoices?${new URLSearchParams({workspace_id:`eq.${claimed.workspace_id}`,id:`eq.${row.id}`,updated_at:`eq.${row.updated_at}`,deleted_at:'is.null',select:'*'})}`,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(body)}))?.[0] || null;
      return invoiceSyncPersistence({read,patch}).finishInvoiceSync(claimed,metadata,fields);
    }
  });
}
export function createAutomationRuntime({env=process.env,fetchImpl=fetch,store,provider,accounting,supabase,clock=()=>new Date()}={}) {
  store ||= new CoreAutomationStore({url:required(env,'SUPABASE_URL'),key:required(env,'SUPABASE_SERVICE_ROLE_KEY'),fetchImpl,now:clock});
  async function read(scope) { const invoice=await store.getInvoice(scope);if(!invoice)throw new HttpError(404,'Invoice unavailable');return invoice; }
  function makeEngine(reminders) {
    if(reminders)return new FollowUpEngine({store,provider:reminders.provider,clock,paymentChecker:reminders.paymentChecker});
    const sender=provider || createWhatsAppProvider({mode:required(env,'WHATSAPP_PROVIDER'),environment:env.NODE_ENV});
    return new FollowUpEngine({store,provider:sender,clock,paymentChecker:async ({invoice,ownerId,workspaceId})=>{
      if (env.WHATSAPP_PROVIDER==='mock' && env.NODE_ENV!=='production' && !invoice.bookkeeping_record_id) return {paidMinor:Number(invoice.paidMinor ?? invoice.paid_minor)};
      const connector=accounting || createAccountingRuntime({env,fetchImpl});
      const providerName=invoice.bookkeeping_provider==='zoho'?'zoho_books':invoice.bookkeeping_provider;
      if (!invoice.bookkeeping_record_id || !['zoho_books','quickbooks'].includes(providerName)) throw new Error('A linked accounting invoice is required');
      const balance=await connector.latestInvoiceBalance({userId:ownerId,workspaceId,provider:providerName,invoiceId:invoice.bookkeeping_record_id});
      if (balance.currency!==invoice.currency || balance.amountMinor!==Number(invoice.amountMinor ?? invoice.amount_minor)) throw new Error('Accounting invoice requires reconciliation');
      return {paidMinor:balance.amountMinor-balance.balanceMinor};
    }});
  }
  async function pause(scope) {const row=await read(scope);await store.updateInvoice({...scope,followupState:isPaid(row)?'cancelled':'paused',nextFollowUpAt:null});await store.recordEvent({...scope,type:'followup_paused',idempotencyKey:`pause:${scope.invoiceId}:${clock().toISOString()}`,payload:{}});return {status:'paused'};}
  async function resume(scope) {
    const row=await read(scope);if(isPaid(row))throw new HttpError(409,'Paid invoices cannot resume');
    if(hasUnresolvedFollowUpException(row))throw new HttpError(409,'Resolve the invoice exception before resuming follow-up');
    if (Object.hasOwn(row,'total_amount') && (row.metadata?.invoice_direction!=='receivable'||!row.due_date||Number(row.total_amount)<=Number(row.amount_paid)||['void','cancelled','paid'].includes(row.status))) throw new HttpError(409,'Invoice is not eligible for follow-up');
    const owner=typeof store.getWorkspacePreferences==='function'?await store.getWorkspacePreferences(scope):null;
    const settings=owner?normalizeFollowUpPreferences(owner.follow_up_preferences,owner.default_timezone):(row.followUpSettings || row.follow_up_settings || {});
    const at=scheduleInitialFollowUp(row,settings,clock());
    const next=nextContactTime(at>clock()?at:clock(),settings,settings.timezone || row.debtor_timezone || 'UTC');
    const changed=await store.updateInvoice({...scope,expectedVersion:Number(row.automationVersion ?? row.automation_version),followupState:'approved',nextFollowUpAt:next.toISOString()});
    if (!changed) throw new HttpError(409,'Invoice changed; refresh and retry');
    return {status:'scheduled',nextFollowUpAt:next.toISOString()};
  }
  async function configure(scope,configuration) {
    const row=await read(scope);
    if(!configuration || typeof configuration!=='object')throw new HttpError(400,'Configuration required');
    const {businessName=(row.followUpSettings || row.follow_up_settings)?.businessName,customerPhone,timezone='Asia/Kolkata',hoursStart='08:00',hoursEnd='21:00',cadenceDays=3,first_reminder_days=3,escalationAfter=3,weekdays=[0,1,2,3,4,5,6]}=configuration;
    if(!/^\+[1-9]\d{7,14}$/.test(customerPhone || ''))throw new HttpError(400,'E.164 customer phone required');
    try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new HttpError(400,'Invalid timezone');}
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(hoursStart)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hoursEnd)||hoursStart>=hoursEnd)throw new HttpError(400,'Contact hours must form a daytime window');
    if(!Number.isInteger(cadenceDays)||cadenceDays<1||cadenceDays>90||!Number.isInteger(first_reminder_days)||first_reminder_days<0||first_reminder_days>90||!Number.isInteger(escalationAfter)||escalationAfter<1||escalationAfter>20||!Array.isArray(weekdays)||!weekdays.length||weekdays.some(d=>!Number.isInteger(d)||d<0||d>6))throw new HttpError(400,'Invalid cadence');
    const settings={businessName,timezone,hoursStart,hoursEnd,cadenceDays,first_reminder_days,escalationAfter,weekdays};
    const changed=await store.updateInvoice({...scope,expectedVersion:Number(row.automationVersion ?? row.automation_version),customerPhone,followUpSettings:settings});
    if(!changed)throw new HttpError(409,'Invoice changed; refresh and retry');
    return {configured:true};
  }
  async function buildDailySummary(scope, previousDay=false) {
    const owner=typeof store.getWorkspacePreferences==='function'?await store.getWorkspacePreferences(scope):null;
    const settings=normalizeFollowUpPreferences(owner?.follow_up_preferences,owner?.default_timezone);
    if (!settings.dailySummary) return {enabled:false,events:[],counts:{}};
    if (typeof store.dailySummary!=='function') throw new HttpError(503,'Daily summary unavailable');
    const local=timezoneParts(clock(),settings.timezone);
    const target=previousDay?addLocalDays(local,-1):local;
    const day=`${target.year}-${String(target.month).padStart(2,'0')}-${String(target.day).padStart(2,'0')}`;
    const events=await store.dailySummary({...scope,day,timezone:settings.timezone});
    const counts={};for(const event of events)counts[event.type]=(counts[event.type]||0)+1;
    if (previousDay) await store.recordEvent({...scope,type:'daily_summary',idempotencyKey:`daily-summary:${scope.workspaceId}:${day}`,payload:{day,counts}});
    return {enabled:true,day,events,counts};
  }
  return {
    pause,resume,configure,
    async tick(scope) {
      const test=scheduledOwnerTestMode(env,clock());
      if(test.mode==='blocked'||(test.mode==='test'&&!scheduledOwnerTestScopeMatches(test,scope)))
        return {processed:0,results:[],disabled:true,test:true};
      const summary=test.mode==='test'?{enabled:false}:await buildDailySummary(scope,true);
      if (env.AUTOMATION_OUTBOUND_ENABLED!=='true') return {processed:0,results:[],disabled:true,summary:summary.enabled?{day:summary.day,counts:summary.counts}:null};
      let reminders;
      if(env.WHATSAPP_PROVIDER==='first_party_meta'){
        if(!firstPartyReminderEnabled(env))return {processed:0,results:[],disabled:true,summary:summary.enabled?{day:summary.day,counts:summary.counts}:null};
        reminders=createFirstPartyReminderRuntime({env,scope,store,supabase,fetchImpl,clock});
        if(test.mode==='test'){
          if(await reminders.testGate.consumed())return {processed:0,results:[],test:true,alreadyAttempted:true};
          await reminders.testGate.review();
        }else await reminders.sweep();
      }
      const rows=test.mode==='test'?[{id:test.invoiceId}]:typeof store.listDueInvoices==='function'?await store.listDueInvoices({...scope,now:clock().toISOString()}):await store.request('cetld_invoices',{query:{...store.scopeQuery(scope),select:'id',followup_state:'in.(approved,active,scheduled)',next_follow_up_at:`lte.${clock().toISOString()}`,order:'next_follow_up_at.asc',limit:25}});
      const engine=makeEngine(reminders), results=[];
      for(const row of rows) {try{results.push({invoiceId:row.id,...await engine.run({...scope,invoiceId:row.id})});}catch{results.push({invoiceId:row.id,status:'blocked'});}}
      return {processed:results.length,results,summary:summary.enabled?{day:summary.day,counts:summary.counts}:null};
    },
    dailySummary(scope) { return buildDailySummary(scope); },
    async receiveMockReply(scope,event) {
      if(env.NODE_ENV==='production'||env.WHATSAPP_PROVIDER!=='mock')throw new HttpError(404,'Unavailable');
      const normalized=normalizeInboundEvent({events:[event]},{verifiedWorkspaceId:scope.workspaceId});
      return makeEngine().processReply({...scope,body:normalized.body,from:normalized.from,messageId:normalized.providerMessageId});
    }
  };
}
