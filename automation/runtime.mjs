import { FollowUpEngine, isPaid } from './engine.mjs';
import { SupabaseAutomationStore } from './store.mjs';
import { createWhatsAppProvider, normalizeInboundEvent } from './whatsapp/index.mjs';
import { createAccountingIntegration, SupabaseAccountingStore, TokenCipher, encryptionKeyFromEnv, createAccountingProviders } from './accounting/index.mjs';
import { HttpError, required } from './http.mjs';
import { scheduleInitialFollowUp, nextContactTime } from './cadence.mjs';

export function createAccountingRuntime({env=process.env,fetchImpl=fetch}={}) {
  return createAccountingIntegration({
    store:new SupabaseAccountingStore({url:env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || required(env,'SUPABASE_URL'),serviceRoleKey:required(env,'SUPABASE_SERVICE_ROLE_KEY'),fetchImpl}),
    cipher:new TokenCipher(encryptionKeyFromEnv(env.ACCOUNTING_TOKEN_ENCRYPTION_KEY)),
    providers:createAccountingProviders({
      zoho_books:{clientId:env.ZOHO_BOOKS_CLIENT_ID,clientSecret:env.ZOHO_BOOKS_CLIENT_SECRET,redirectUri:env.ZOHO_BOOKS_REDIRECT_URI,region:env.ZOHO_BOOKS_REGION || 'com',fetchImpl},
      quickbooks:{clientId:env.QUICKBOOKS_CLIENT_ID,clientSecret:env.QUICKBOOKS_CLIENT_SECRET,redirectUri:env.QUICKBOOKS_REDIRECT_URI,sandbox:env.QUICKBOOKS_SANDBOX==='true',fetchImpl}
    })
  });
}
export function createAutomationRuntime({env=process.env,fetchImpl=fetch,store,provider,accounting,clock=()=>new Date()}={}) {
  store ||= new SupabaseAutomationStore({url:required(env,'SUPABASE_URL'),key:required(env,'SUPABASE_SERVICE_ROLE_KEY'),fetchImpl,now:clock});
  async function read(scope) { const invoice=await store.getInvoice(scope);if(!invoice)throw new HttpError(404,'Invoice unavailable');return invoice; }
  function makeEngine() {
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
    const settings=row.followUpSettings || row.follow_up_settings || {};
    const at=scheduleInitialFollowUp(row,settings,clock());
    const next=nextContactTime(at>clock()?at:clock(),settings,row.debtor_timezone || settings.timezone || 'UTC');
    const changed=await store.updateInvoice({...scope,expectedVersion:Number(row.automationVersion ?? row.automation_version),followupState:'approved',nextFollowUpAt:next.toISOString()});
    if (!changed) throw new HttpError(409,'Invoice changed; refresh and retry');
    return {status:'scheduled',nextFollowUpAt:next.toISOString()};
  }
  async function configure(scope,configuration) {
    const row=await read(scope);
    if(!configuration || typeof configuration!=='object')throw new HttpError(400,'Configuration required');
    const {customerPhone,timezone='UTC',hoursStart='09:00',hoursEnd='18:00',cadenceDays=3,first_reminder_days=3,escalationAfter=3,weekdays=[1,2,3,4,5]}=configuration;
    if(!/^\+[1-9]\d{7,14}$/.test(customerPhone || ''))throw new HttpError(400,'E.164 customer phone required');
    try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new HttpError(400,'Invalid timezone');}
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(hoursStart)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hoursEnd)||hoursStart>=hoursEnd)throw new HttpError(400,'Contact hours must form a daytime window');
    if(!Number.isInteger(cadenceDays)||cadenceDays<1||cadenceDays>90||!Number.isInteger(first_reminder_days)||first_reminder_days<0||first_reminder_days>90||!Number.isInteger(escalationAfter)||escalationAfter<1||escalationAfter>20||!Array.isArray(weekdays)||!weekdays.length||weekdays.some(d=>!Number.isInteger(d)||d<0||d>6))throw new HttpError(400,'Invalid cadence');
    const settings={timezone,hoursStart,hoursEnd,cadenceDays,first_reminder_days,escalationAfter,weekdays};
    const changed=await store.updateInvoice({...scope,expectedVersion:Number(row.automationVersion ?? row.automation_version),customerPhone,followUpSettings:settings});
    if(!changed)throw new HttpError(409,'Invoice changed; refresh and retry');
    return {configured:true};
  }
  return {
    pause,resume,configure,
    async tick(scope) {
      const rows=await store.request('cetld_invoices',{query:{...store.scopeQuery(scope),select:'id',followup_state:'in.(approved,active,scheduled)',next_follow_up_at:`lte.${clock().toISOString()}`,order:'next_follow_up_at.asc',limit:25}});
      const engine=makeEngine(), results=[];
      for(const row of rows) {try{results.push({invoiceId:row.id,...await engine.run({...scope,invoiceId:row.id})});}catch{results.push({invoiceId:row.id,status:'blocked'});}}
      return {processed:results.length,results};
    },
    async receiveMockReply(scope,event) {
      if(env.NODE_ENV==='production'||env.WHATSAPP_PROVIDER!=='mock')throw new HttpError(404,'Unavailable');
      const normalized=normalizeInboundEvent({events:[event]},{verifiedWorkspaceId:scope.workspaceId});
      return makeEngine().processReply({...scope,body:normalized.body,from:normalized.from,messageId:normalized.providerMessageId});
    }
  };
}
