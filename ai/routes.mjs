import {deadlineFetch} from '../automation/invoice-sync.mjs';
import {APIError, object, requestBody, sendError, uuid} from './http.mjs';
import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL, OPENROUTER_FREE_MODEL, VERIFIED_MODELS, isFallbackModelId, isPrimaryModelId, verifyModel} from './provider.mjs';
import {authorizeAIWorkspace} from './store.mjs';
import {extractInvoice} from './extraction.mjs';
import {answerWorkspaceQuestion, shouldLoadAccountingConnection} from './assistant.mjs';
import {saveAssistantInvoice, retryAssistantInvoiceSync} from './invoice-ops.mjs';
import {createAccountingTools} from './accounting-tools.mjs';
import {createAccountingActionToken} from './accounting-actions.mjs';
import {createGeminiDiagnostic} from './diagnostic.mjs';
import {createOwnerAssistantActions,ownerActionDecision} from './owner-actions.mjs';
import {confirmAssistantAction,invoiceConfirmationAnswer} from './confirm-action.mjs';
import {randomUUID} from 'node:crypto';

async function invoiceAccounting({env,fetchImpl,accountingFactory}) {
 try{
  if(accountingFactory)return await accountingFactory({env,fetchImpl});
  if(env.SUPABASE_SERVICE_ROLE_KEY&&env.ACCOUNTING_TOKEN_ENCRYPTION_KEY){const {createAccountingRuntime}=await import('../automation/runtime.mjs');return createAccountingRuntime({env,fetchImpl:deadlineFetch(fetchImpl,40_000)});}
 }catch{}
 return null;
}

export function createAIHandler({env = process.env, fetchImpl = fetch, authorize = authorizeAIWorkspace, providerFactory = options => new AIProvider(options), verify = verifyModel, clock = () => new Date(), accountingFactory, logger = console, diagnosticRunner = createGeminiDiagnostic({fetchImpl}), invoiceConnectionLookup} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const action = req.query?.action;
      if (!['models', 'settings', 'diagnostic', 'extract', 'assistant', 'assistant-history', 'save-invoice', 'retry-invoice-sync', 'invoice-sync-status', 'confirm-accounting-action', 'cancel-assistant-action'].includes(action)) throw new APIError(404, 'NOT_FOUND');
      const methods = ['models','invoice-sync-status','assistant-history'].includes(action) ? ['GET'] : action === 'settings' ? ['GET', 'PUT'] : ['POST'];
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new APIError(405, 'METHOD_NOT_ALLOWED'); }
      if (action === 'models') {
        const checks = await Promise.all(VERIFIED_MODELS.map(async id => {
          try { await verify(id, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY,
            zenApiKey: env.OPENCODE_ZEN_API_KEY, cfAccountId: env.CLOUDFLARE_ACCOUNT_ID, cfApiToken: env.CLOUDFLARE_API_TOKEN, timeoutMs: 5000}); return id; }
          catch { return null; }
        }));
        const available = [...new Set(checks.filter(Boolean))];
        return res.status(200).json({models: available.filter(isPrimaryModelId), fallbackModels: available.filter(isFallbackModelId), extractionModels: available.filter(id => id === DEFAULT_EXTRACTION_MODEL), openRouterFallback: available.includes(OPENROUTER_FREE_MODEL)});
      }
      const allowed = action === 'settings' ? ['workspaceId', 'primary_model', 'fallback_model']
        : action === 'diagnostic' ? ['workspaceId']
        : action === 'extract' ? ['workspaceId', 'fileId', 'file']
        : action === 'assistant' ? ['workspaceId', 'message', 'history']
        : action === 'save-invoice' ? ['workspaceId', 'confirmed', 'idempotencyKey', 'invoice', 'conversationSource']
        : ['confirm-accounting-action','cancel-assistant-action'].includes(action) ? ['workspaceId', 'confirmed', 'confirmationToken']
        : ['workspaceId', 'invoiceId', 'idempotencyKey'];
      const body = req.method === 'GET' ? {} : requestBody(req, allowed, action === 'extract' ? 4400000 : 32768);
      const workspaceId = uuid(req.method === 'GET' ? req.query.workspaceId : body.workspaceId);
      const store = await authorize(req, workspaceId, {env, fetchImpl});
      const conversation=store.role==='owner'?store.ownerConversation:null;
      if(action==='assistant-history'){
        if(!conversation)throw new APIError(403,'OWNER_REQUIRED');
        const pending=await conversation.pending();
        const turns=await conversation.read();
        let proposal=null;
        if(pending){
          const secret=env.AI_ACCOUNTING_CONFIRMATION_SECRET||env.ACCOUNTING_TOKEN_ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
          proposal=pending.action.confirmationToken?{type:pending.action.type,proposalId:pending.id,payload:pending.action.payload,invoice:pending.action.invoice,status:'pending',confirmationToken:pending.action.confirmationToken}:{type:pending.action.type,proposalId:pending.id,payload:{proposalId:pending.id},status:'pending',confirmationToken:createAccountingActionToken({action:pending.action.type,payload:{proposalId:pending.id},userId:store.userId,workspaceId:store.workspaceId,secret,now:clock().getTime()})};
        }
        return res.status(200).json({turns,pending:proposal,pendingSummary:pending?.action?.summary||null});
      }
      if (action === 'invoice-sync-status') {
        if (invoiceConnectionLookup) return res.status(200).json({connected:Boolean(await invoiceConnectionLookup({workspaceId,env,fetchImpl}))});
        if (!env.SUPABASE_SERVICE_ROLE_KEY) return res.status(200).json({connected:false});
        const {SupabaseAccountingStore} = await import('../automation/accounting/store.mjs');
        const connections = new SupabaseAccountingStore({url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
        return res.status(200).json({connected:Boolean(await connections.getWorkspaceInvoiceConnection(workspaceId))});
      }
      if (action === 'diagnostic') {
        if (!['owner','admin'].includes(store.role)) throw new APIError(403, 'DIAGNOSTIC_ADMIN_REQUIRED');
        const result = await diagnosticRunner({userId:store.userId, role:store.role, apiKey:env.GEMINI_API_KEY});
        if (result?.error) throw new APIError(result.status, result.error);
        return res.status(200).json(result);
      }
      if (action === 'save-invoice' || action === 'retry-invoice-sync' || ['confirm-accounting-action','cancel-assistant-action'].includes(action)) {
        const accounting=await invoiceAccounting({env,fetchImpl,accountingFactory});
        if (action === 'save-invoice') {
          if(body.invoice?.alreadyPaid===true&&store.role!=='owner')throw new APIError(403,'OWNER_REQUIRED');
          if(body.conversationSource!==undefined&&body.conversationSource!=='assistant')throw new APIError(400,'INVALID_INPUT');
          if(body.conversationSource==='assistant'){if(!conversation)throw new APIError(403,'OWNER_REQUIRED');await conversation.read();}
          const result = await saveAssistantInvoice({store, invoice: body.invoice, confirmed: body.confirmed, idempotencyKey: body.idempotencyKey, accounting});
          if (result.needsInput) return res.status(422).json({error: 'MISSING_DUE_DATE', question: result.question});
          if(body.conversationSource==='assistant'){
            const saved=result.invoice;
            await conversation.append({key:`upload:${body.idempotencyKey}:user`,role:'user',content:`Save the reviewed invoice ${saved.invoiceNumber} for ${body.invoice.clientName}: ${saved.currency} ${saved.total}, due ${saved.dueDate}.`});
            await conversation.append({key:`upload:${body.idempotencyKey}:assistant`,role:'assistant',content:`Saved the reviewed invoice ${saved.invoiceNumber}${body.invoice.alreadyPaid?' as paid':''}.`});
          }
          return res.status(200).json(result);
        }
        if (['confirm-accounting-action','cancel-assistant-action'].includes(action)) {
          if ((action==='confirm-accounting-action'&&body.confirmed!==true)||(action==='cancel-assistant-action'&&body.confirmed!==false))throw new APIError(409,'CONFIRMATION_REQUIRED');
          const result=await confirmAssistantAction({store,confirmationToken:body.confirmationToken,confirmed:body.confirmed,env,clock,accounting});
          if(result.needsInput)return res.status(422).json({error:'MISSING_DUE_DATE',question:result.question});
          return res.status(200).json(result);
        }
        if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(body.idempotencyKey)) throw new APIError(400, 'INVALID_IDEMPOTENCY_KEY');
        return res.status(200).json(await retryAssistantInvoiceSync({store, invoiceId: body.invoiceId, accounting}));
      }
      if (action === 'settings') {
        if (req.method === 'GET') return res.status(200).json({...await store.getSettings(), role:store.role});
        if (!['owner', 'admin'].includes(store.role)) throw new APIError(403, 'SETTINGS_ADMIN_REQUIRED');
        const {primary_model, fallback_model = null} = body;
        if (!isPrimaryModelId(primary_model) || (fallback_model !== null && !isFallbackModelId(fallback_model)) || primary_model === fallback_model) throw new APIError(400, 'INVALID_MODEL_CONFIGURATION');
        await verify(primary_model, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY,
          zenApiKey: env.OPENCODE_ZEN_API_KEY, cfAccountId: env.CLOUDFLARE_ACCOUNT_ID, cfApiToken: env.CLOUDFLARE_API_TOKEN});
        if (fallback_model) await verify(fallback_model, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY,
          zenApiKey: env.OPENCODE_ZEN_API_KEY, cfAccountId: env.CLOUDFLARE_ACCOUNT_ID, cfApiToken: env.CLOUDFLARE_API_TOKEN});
        return res.status(200).json({...await store.saveSettings({primary_model, fallback_model}), role:store.role});
      }
      const settings = await store.getSettings();
      const provider = providerFactory({primaryModel: settings.primary_model, fallbackModel: settings.fallback_model,
        geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY, zenApiKey: env.OPENCODE_ZEN_API_KEY,
        cfAccountId: env.CLOUDFLARE_ACCOUNT_ID, cfApiToken: env.CLOUDFLARE_API_TOKEN, fetchImpl, timeoutMs: 16000});
      if (action === 'extract') {
        const extractionBudgetMs = 42_000;
        const deadlineAt = Date.now() + extractionBudgetMs;
        const signal = AbortSignal.timeout(extractionBudgetMs);
        if (Boolean(body.fileId) === Boolean(body.file)) throw new APIError(400, 'ONE_FILE_SOURCE_REQUIRED');
        let file;
        if (body.file) {
          const f = object(body.file, ['base64', 'mimeType', 'fileName']);
          if (typeof f.base64 !== 'string' || f.base64.length === 0 || f.base64.length > 4194304 || f.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) || !['application/pdf','image/png','image/jpeg','image/webp'].includes(f.mimeType) || typeof f.fileName !== 'string' || f.fileName.length > 255) throw new APIError(400, 'INVALID_UPLOAD');
          file = {bytes: Buffer.from(f.base64, 'base64'), mimeType: f.mimeType, fileName: f.fileName};
        } else file = await store.downloadInvoiceFile(uuid(body.fileId));
        const extractionProvider = providerFactory({primaryModel: DEFAULT_EXTRACTION_MODEL, fallbackModel: DEFAULT_EXTRACTION_FALLBACK_MODEL,
          requestPurpose: 'extraction', geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY,
          zenApiKey: env.OPENCODE_ZEN_API_KEY, fetchImpl, timeoutMs: 23000});
        const businessName = typeof store.getBusinessName === 'function' ? await store.getBusinessName() : null;
        return res.status(200).json(await extractInvoice({provider: extractionProvider, businessName, signal, deadlineAt, ...file}));
      }
      let accounting = null;
      if (shouldLoadAccountingConnection(body.message) && env.SUPABASE_SERVICE_ROLE_KEY && env.ACCOUNTING_TOKEN_ENCRYPTION_KEY) {
        try {
          const {createAccountingRuntime} = await import('../automation/runtime.mjs');
          const integration = createAccountingRuntime({env, fetchImpl});
          const status = await integration.connectionStatus({userId: store.userId, workspaceId: store.workspaceId, provider: 'zoho_books'});
          if (status.status === 'connected') accounting = createAccountingTools({integration, userId: store.userId, workspaceId: store.workspaceId, provider: 'zoho_books'});
        } catch { accounting = null; }
      }
      // Owner history is server authoritative. A failed/missing migration blocks
      // the turn before planning or writes; browser history is never a fallback.
      if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000)throw new APIError(400,'INVALID_CONVERSATION');
      const rows=conversation?await conversation.read():null;
      const history=rows?rows.map(({role,content})=>({role,content})):body.history;
      const turnId=randomUUID();
      if(conversation)await conversation.append({key:`web:${turnId}:user`,role:'user',content:body.message});
      const decision=ownerActionDecision(body.message);
      const activeProposal=conversation&&decision!==null?await conversation.pending():null;
      const invoiceProposal=activeProposal?.action?.confirmationToken?activeProposal.action:conversation&&decision!==null?rows.findLast(turn=>turn.pending_action&&['create_invoice','update_invoice'].includes(turn.pending_action.type)&&(!turn.pending_action.status||turn.pending_action.status==='pending'))?.pending_action:null;
      if(invoiceProposal&&(!activeProposal||activeProposal.action.confirmationToken)){
        const saved=await confirmAssistantAction({store,confirmationToken:invoiceProposal.confirmationToken,confirmed:decision,env,clock,accounting:await invoiceAccounting({env,fetchImpl,accountingFactory})});
        const answer=saved.needsInput?saved.question:invoiceConfirmationAnswer(saved);
        await conversation.append({key:`web:${turnId}:assistant`,role:'assistant',content:answer});
        return res.status(200).json({answer,pendingAction:null});
      }
      const ownerActions=conversation?createOwnerAssistantActions({store,conversation,clock}):null;
      let result = await answerWorkspaceQuestion({provider, store, message: body.message, history,ownerHistory:rows, clock, accounting,ownerMode:Boolean(conversation),ownerActions});
      if (result.pendingAction) {
        const type = result.pendingAction.type;
        const action = ['create_invoice','update_invoice','owner_reminder','owner_payment','owner_correction','owner_schedule'].includes(type)?type:null;
        if (!action) throw new APIError(500, 'INVALID_ACCOUNTING_ACTION');
        const legacy=conversation&&['create_invoice','update_invoice'].includes(type);
        const proposalId=legacy?randomUUID():null;
        if(legacy&&await conversation.pending())result={answer:'Finish or cancel the pending action before preparing another change.',pendingAction:null};
        if(result.pendingAction){
        if(legacy)result.pendingAction={...result.pendingAction,proposalId,payload:{...result.pendingAction.payload,proposalId}};
        const secret = env.AI_ACCOUNTING_CONFIRMATION_SECRET || env.ACCOUNTING_TOKEN_ENCRYPTION_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
        const confirmationToken = createAccountingActionToken({action,payload:result.pendingAction.payload,userId:store.userId,workspaceId:store.workspaceId,secret,now:clock().getTime()});
        result.pendingAction = {...result.pendingAction,confirmationToken,expiresAt:new Date(clock().getTime()+10*60_000).toISOString()};
        if(legacy){const saved=await conversation.propose({id:proposalId,...result.pendingAction,summary:result.answer,instruction:body.message});if(!saved?.id)result={answer:'Finish or cancel the pending WhatsApp action before preparing another change.',pendingAction:null};}
        }

      }
      if(typeof result.answer==='string')result.answer=result.answer.replace(/\bworkspace\b/gi,'business');
      if(conversation)await conversation.append({key:`web:${turnId}:assistant`,role:'assistant',content:result.answer.slice(0,4000),pendingAction:result.pendingAction||null});
      return res.status(200).json(result);
    } catch (error) {
      if (req.query?.action === 'extract' && error?.code === 'INVALID_OUTPUT') return res.status(502).json({error:'INVOICE_EXTRACTION_UNAVAILABLE',message:'The invoice could not be read safely. Please retry or enter its details manually.'});
      if (req.query?.action === 'confirm-accounting-action' && req.body?.confirmed === true) logger.error?.('Assistant accounting confirmation failed', {code:error?.code || 'UNEXPECTED_ERROR', status:error?.status || 503});
      return sendError(res, error);
    }
  };
}
