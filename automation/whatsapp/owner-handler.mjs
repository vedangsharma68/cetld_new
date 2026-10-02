import {AIProvider, CF_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL, sanitizeModelSettings} from '../../ai/provider.mjs';
import {createInvoiceLifecycleService} from '../../ai/invoice-lifecycle.mjs';
import {createOwnerScopedStore} from '../../ai/whatsapp-channel.mjs';
import {authorizeOwnerPhone} from './owner-binding.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createOwnerSettingsStore} from './owner-settings.mjs';
import {createOwnerAgentTools, normalizeOwnerReply, ownerReplySafetyIssue, runOwnerAgent} from './owner-agent.mjs';

const dataOrThrow = result => {if(result?.error)throw result.error;return result?.data;};
async function permanentHistory({supabase,workspaceId,phone}){
  const result=await supabase.from('whatsapp_messages').select('direction,body,status,created_at,id,provider_message_id').eq('workspace_id',workspaceId)
    .eq('phone',phone).eq('audience','owner').in('status',['received','accepted','sent','delivered','read'])
    .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(20);
  if(result?.error)throw result.error;
  return (result?.data||[]).reverse().map(row=>({role:row.direction==='inbound'?'user':'assistant',content:row.body,
    createdAt:row.created_at||null,providerMessageId:row.direction==='inbound'?row.provider_message_id:null}));
}
async function readOwnerSourceMedia({supabase,providerMessageId,phone}){
  if(typeof providerMessageId!=='string'||!providerMessageId)return null;
  const event=dataOrThrow(await supabase.from('whatsapp_inbound_events').select('media_ref,message_type,sender_phone')
    .eq('provider_message_id',providerMessageId).maybeSingle());
  if(!event||event.sender_phone!==phone||!event.media_ref)return null;
  const row=dataOrThrow(await supabase.from('whatsapp_inbound_media').select('mime_type,bytes,size_bytes')
    .eq('provider_message_id',event.media_ref).maybeSingle());
  if(!row)return null;
  const bytes=typeof row.bytes==='string'&&row.bytes.startsWith('\\x')
    ?Buffer.from(row.bytes.slice(2),'hex'):Buffer.from(row.bytes||[]);
  return {bytes,mimeType:row.mime_type||'application/octet-stream',
    fileName:event.message_type==='document'?'invoice.pdf':'invoice-image'};
}

/**
 * A verified owner turn always starts with the model. All ledger reads, invoice
 * and settings proposals, confirmations, deletion and attachment processing
 * are exposed as owner-scoped tools in owner-agent.mjs.
 */
export function createOwnerMessageHandler({supabase,env=process.env,fetchImpl=fetch,
  providerFactory=options=>new AIProvider(options),
  authorize=scope=>authorizeOwnerPhone({supabase,...scope}),
  ownerStoreFactory=scope=>createOwnerScopedStore({supabase,...scope,authorize:()=>authorize(scope)}),
  invoiceStoreFactory=scope=>createWhatsAppInvoiceStore({supabase,...scope,audience:'owner',authorize:()=>authorize(scope)}),
  pendingActionStoreFactory=createWhatsAppPendingActionStore,
  historyReader=permanentHistory,
  agentFactory=runOwnerAgent,
  toolsFactory=createOwnerAgentTools,
  lifecycleFactory=rpc=>createInvoiceLifecycleService({rpc}),
  clock=()=>new Date(),logger=console}={}){
  if(!supabase?.from)throw new TypeError('A server-side Supabase client is required');
  const handle=async scope=>{
    const {workspaceId,ownerId,phone,messageId,media,mediaError,signal,deadlineAt}=scope;
    if(!workspaceId||!ownerId||!phone||!await authorize(scope))return '';
    // Keep the provider text byte-for-byte equivalent to the persisted turn.
    // Lifecycle RPCs validate exact provider message ID and stored content.
    const message=String(scope.message||'');
    let settings={};
    let settingsAvailable=true;
    try{
      settings=dataOrThrow(await supabase.from('workspace_ai_settings').select('primary_model,fallback_model')
        .eq('workspace_id',workspaceId).maybeSingle())||{};
    }catch(error){
      settingsAvailable=false;
      logger?.error?.('WhatsApp owner model settings read failed',{workspaceId,code:String(error?.code||'SETTINGS_UNAVAILABLE').slice(0,60)});
    }
    const hasSavedPrimary=typeof settings.primary_model==='string'&&settings.primary_model.trim().length>0;
    const configurationSource=!settingsAvailable?'defaults_after_settings_error':hasSavedPrimary?'workspace':'defaults';
    const config=configurationSource==='workspace'
      ?sanitizeModelSettings({primaryModel:settings.primary_model,fallbackModel:settings.fallback_model})
      :sanitizeModelSettings({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL});
    const provider=providerFactory({...config,geminiApiKey:env.GEMINI_API_KEY,openRouterApiKey:env.OPENROUTER_API_KEY,
      zenApiKey:env.OPENCODE_ZEN_API_KEY,cfAccountId:env.CLOUDFLARE_ACCOUNT_ID,cfApiToken:env.CLOUDFLARE_API_TOKEN,
      fetchImpl,timeoutMs:15000,maxAttempts:2});
    let pending,pendingStoreAvailable=true;
    try{pending=pendingActionStoreFactory({supabase});}
    catch(error){
      pendingStoreAvailable=false;
      logger?.error?.('WhatsApp owner pending-action store unavailable',{workspaceId,code:String(error?.code||'PENDING_UNAVAILABLE').slice(0,60)});
      const unavailable=()=>{throw Object.assign(new Error(),{code:'UNAVAILABLE'});};
      pending={loadPendingAction:unavailable,loadPendingActionState:unavailable,storePendingAction:unavailable,consumePendingAction:unavailable};
    }
    let pendingAtStart=null;
    try{pendingAtStart=await pending.loadPendingAction({workspaceId,customerId:scope.customerId,phone});}
    catch(error){pendingStoreAvailable=false;logger?.error?.('WhatsApp owner pending-action lookup failed',{workspaceId,code:String(error?.code||'PENDING_UNAVAILABLE').slice(0,60)});}
    let pendingInitialState=null;
    try{
      if(pendingStoreAvailable&&typeof pending.loadPendingActionState==='function')
        pendingInitialState=await pending.loadPendingActionState({workspaceId,customerId:scope.customerId,phone});
      else pendingStoreAvailable=false;
    }catch(error){
      pendingStoreAvailable=false;
      logger?.error?.('WhatsApp owner pending-action snapshot failed',{workspaceId,code:String(error?.code||'PENDING_UNAVAILABLE').slice(0,60)});
    }
    let history=[];
    let historyAvailable=true;
    try{
      history=await historyReader({supabase,workspaceId,phone,customerId:null,audience:'owner'});
      // The inbound worker records this received message before invoking us.
      // Do not repeat the current turn when the durable history already ends in it.
      if(history.at(-1)?.role==='user'&&history.at(-1)?.content===message)history=history.slice(0,-1);
    }catch(error){
      historyAvailable=false;
      logger?.error?.('WhatsApp owner conversation history read failed',{workspaceId,code:String(error?.code||'HISTORY_UNAVAILABLE').slice(0,60)});
    }
    const reauthorize=async input=>authorize(input);
    let ownerStore;
    let ownerStoreAvailable=true;
    try{ownerStore=ownerStoreFactory({supabase,workspaceId,ownerId,phone,authorize:()=>reauthorize(scope)});}
    catch(error){
      ownerStoreAvailable=false;
      logger?.error?.('WhatsApp owner data tools unavailable',{workspaceId,code:String(error?.code||'OWNER_TOOLS_UNAVAILABLE').slice(0,60)});
      ownerStore={workspaceId,userId:ownerId,role:'owner',async query(){throw Object.assign(new Error(),{code:'UNAVAILABLE'});}};
    }
    const invoiceStore=scopeInput=>invoiceStoreFactory({...scope,...scopeInput});
    let lifecycle=null,lifecyclePending=null,lifecycleAvailable=true;
    try{
      lifecycle=lifecycleFactory((name,args)=>supabase.rpc(name,args));
      lifecyclePending=await lifecycle.loadPendingDelete({workspaceId,actor:{kind:'verified_owner_phone',phone}});
      lifecycleAvailable=lifecyclePending?.ok===true;
    }catch(error){
      lifecycleAvailable=false;
      logger?.error?.('WhatsApp owner deletion proposal lookup failed',{workspaceId,code:String(error?.code||'LIFECYCLE_UNAVAILABLE').slice(0,60)});
    }
    let tools,toolSetupIssue=null;
    try{tools=toolsFactory({supabase,scope:{...scope,workspaceId,ownerId,phone},ownerStore,pending,pendingAtStart,pendingInitialState,
      lifecyclePending,invoiceStoreFactory:invoiceStore,settingsStore:createOwnerSettingsStore(supabase),config,signal,deadlineAt,ownerHistory:history,
      sourceMediaReader:input=>readOwnerSourceMedia({supabase,...input}),
      configurationAvailable:settingsAvailable,configurationSource,historyAvailable,ownerStoreAvailable,lifecycleAvailable,
      pendingStoreAvailable,message,messageId,media,mediaError,authorize:reauthorize,lifecycle,providerFactory,env,fetchImpl,clock,logger});}
    catch(error){
      toolSetupIssue='OWNER_TOOLS_UNAVAILABLE';
      logger?.error?.('WhatsApp owner tool setup failed',{workspaceId,code:toolSetupIssue});
      tools={definitions:[{type:'function',function:{name:'ownerToolsStatus',description:'Read the safe availability state of this owner turn.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
        async execute(){return {ok:false,code:'UNAVAILABLE',message:'Workspace tools are temporarily unavailable.'};},setServedModel(){},getMedia(){return null;}};
    }
    const response=await agentFactory({provider,config,store:ownerStore,tools,history,message,signal,deadlineAt,clock,
      attachmentDescriptor:media?{available:true,mimeType:String(media.mimeType||media.mime_type||'application/octet-stream').slice(0,80)}
        :mediaError?{available:false,errorCode:'ATTACHMENT_UNAVAILABLE'}:{available:false},
      toolSetupIssue,...(!historyAvailable?{historyIssue:'HISTORY_UNAVAILABLE'}:{}),
      ...(!settingsAvailable?{settingsIssue:'MODEL_SETTINGS_UNAVAILABLE'}:{})});
    if(!await authorize(scope))return '';
    return {answer:response?.answer||'',...(response?.media?{media:response.media}:{}),
      ...(response?.plannerFailure?{plannerFailure:response.plannerFailure}:{}),
      ...(response?.model?{servedModel:response.model}:{}),...(response?.servedProvider?{servedProvider:response.servedProvider}:{})};
  };
  handle.createSafeFailureReply=async({workspaceId,hasAttachment=false}={})=>{
    if(!workspaceId)return null;
    let selected={};
    try{selected=dataOrThrow(await supabase.from('workspace_ai_settings').select('primary_model,fallback_model')
      .eq('workspace_id',workspaceId).maybeSingle())||{};}catch{}
    const hasSavedPrimary=typeof selected.primary_model==='string'&&selected.primary_model.trim().length>0;
    const config=hasSavedPrimary?sanitizeModelSettings({primaryModel:selected.primary_model,fallbackModel:selected.fallback_model})
      :sanitizeModelSettings({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL});
    try{
      const provider=providerFactory({...config,geminiApiKey:env.GEMINI_API_KEY,openRouterApiKey:env.OPENROUTER_API_KEY,
        zenApiKey:env.OPENCODE_ZEN_API_KEY,cfAccountId:env.CLOUDFLARE_ACCOUNT_ID,cfApiToken:env.CLOUDFLARE_API_TOKEN,
        fetchImpl,timeoutMs:5000,maxAttempts:1});
      let draft='';
      for(let attempt=0;attempt<2;attempt++){
        const result=await provider.generate({messages:[
          {role:'system',content:'Write a short, natural WhatsApp status reply for a verified business owner after a processing interruption. Do not use tools. Do not say an action succeeded, failed, or made no changes because its result may be uncertain. Ask the owner to check the invoice or setting status before retrying. Do not include internal errors, private data, names, identifiers, or instructions to repeat a write. Use answer-first wording, no more than 2 short sentences, no em dash, and no more than 2 emojis.'},
          {role:'user',content:`The interrupted turn ${hasAttachment?'included an attachment':'was a text message'}. Draft the safe status reply now.${attempt?` Your last draft failed this output check: ${draft}. Revise it.`:''}`},
        ],tools:[],toolChoice:'none',maxTokens:180,temperature:0.1});
        draft=String(result?.content||'').trim();
        if(!result?.toolCalls?.length&&!ownerReplySafetyIssue(draft))return normalizeOwnerReply(draft);
      }
    }catch(error){logger?.error?.('WhatsApp owner failure reply generation failed',{workspaceId,code:String(error?.code||'PROVIDER_UNAVAILABLE').slice(0,60)});}
    return null;
  };
  return handle;
}
