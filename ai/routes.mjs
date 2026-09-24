import {APIError, object, requestBody, sendError, uuid} from './http.mjs';
import {AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL, VERIFIED_MODELS, isFreeModelId, verifyModel} from './provider.mjs';
import {authorizeAIWorkspace} from './store.mjs';
import {extractInvoice} from './extraction.mjs';
import {answerWorkspaceQuestion} from './assistant.mjs';
import {saveAssistantInvoice, retryAssistantInvoiceSync} from './invoice-ops.mjs';

export function createAIHandler({env = process.env, fetchImpl = fetch, authorize = authorizeAIWorkspace, providerFactory = options => new AIProvider(options), verify = verifyModel, clock = () => new Date(), accountingFactory} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const action = req.query?.action;
      if (!['models', 'settings', 'extract', 'assistant', 'save-invoice', 'retry-invoice-sync'].includes(action)) throw new APIError(404, 'NOT_FOUND');
      const methods = action === 'models' ? ['GET'] : action === 'settings' ? ['GET', 'PUT'] : ['POST'];
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new APIError(405, 'METHOD_NOT_ALLOWED'); }
      if (action === 'models') {
        const checks = await Promise.all(VERIFIED_MODELS.map(async id => {
          try { await verify(id, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY, timeoutMs: 5000}); return id; }
          catch { return null; }
        }));
        const available = [...new Set(checks.filter(Boolean))];
        return res.status(200).json({models: available.filter(id => !id.includes('flash-lite')), extractionModels: available.filter(id => id.includes('flash-lite')), openRouterFallback: available.includes('openrouter/free')});
      }
      const allowed = action === 'settings' ? ['workspaceId', 'primary_model', 'fallback_model']
        : action === 'extract' ? ['workspaceId', 'fileId', 'file']
        : action === 'assistant' ? ['workspaceId', 'message', 'history']
        : action === 'save-invoice' ? ['workspaceId', 'confirmed', 'idempotencyKey', 'invoice']
        : ['workspaceId', 'invoiceId', 'idempotencyKey'];
      const body = req.method === 'GET' ? {} : requestBody(req, allowed, action === 'extract' ? 4400000 : 32768);
      const workspaceId = uuid(req.method === 'GET' ? req.query.workspaceId : body.workspaceId);
      const store = await authorize(req, workspaceId, {env, fetchImpl});
      if (action === 'save-invoice' || action === 'retry-invoice-sync') {
        let accounting = null;
        try {
          if (accountingFactory) accounting = await accountingFactory({env, fetchImpl, store});
          else if (env.SUPABASE_SERVICE_ROLE_KEY && env.ACCOUNTING_TOKEN_ENCRYPTION_KEY) {
            const {createAccountingRuntime} = await import('../automation/runtime.mjs');
            accounting = createAccountingRuntime({env, fetchImpl});
          }
        } catch {
          // Saving to cetld must remain available when bookkeeping is unavailable.
          accounting = null;
        }
        if (action === 'save-invoice') {
          const result = await saveAssistantInvoice({store, invoice: body.invoice, confirmed: body.confirmed, idempotencyKey: body.idempotencyKey, accounting});
          if (result.needsInput) return res.status(422).json({error: 'MISSING_DUE_DATE', question: result.question});
          return res.status(200).json(result);
        }
        if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(body.idempotencyKey)) throw new APIError(400, 'INVALID_IDEMPOTENCY_KEY');
        return res.status(200).json(await retryAssistantInvoiceSync({store, invoiceId: body.invoiceId, accounting}));
      }
      if (action === 'settings') {
        if (req.method === 'GET') return res.status(200).json(await store.getSettings());
        if (!['owner', 'admin'].includes(store.role)) throw new APIError(403, 'SETTINGS_ADMIN_REQUIRED');
        const {primary_model, fallback_model = null} = body;
        if (!isFreeModelId(primary_model) || (fallback_model !== null && !isFreeModelId(fallback_model)) || primary_model === fallback_model) throw new APIError(400, 'INVALID_MODEL_CONFIGURATION');
        await verify(primary_model, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY});
        if (fallback_model) await verify(fallback_model, {fetchImpl, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY});
        return res.status(200).json(await store.saveSettings({primary_model, fallback_model}));
      }
      const settings = await store.getSettings();
      const provider = providerFactory({primaryModel: settings.primary_model, fallbackModel: settings.fallback_model, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY, fetchImpl, timeoutMs: 16000});
      if (action === 'extract') {
        if (Boolean(body.fileId) === Boolean(body.file)) throw new APIError(400, 'ONE_FILE_SOURCE_REQUIRED');
        let file;
        if (body.file) {
          const f = object(body.file, ['base64', 'mimeType', 'fileName']);
          if (typeof f.base64 !== 'string' || f.base64.length === 0 || f.base64.length > 4194304 || f.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) || !['application/pdf','image/png','image/jpeg','image/webp'].includes(f.mimeType) || typeof f.fileName !== 'string' || f.fileName.length > 255) throw new APIError(400, 'INVALID_UPLOAD');
          file = {bytes: Buffer.from(f.base64, 'base64'), mimeType: f.mimeType, fileName: f.fileName};
        } else file = await store.downloadInvoiceFile(uuid(body.fileId));
        const extractionProvider = providerFactory({primaryModel: DEFAULT_EXTRACTION_MODEL, fallbackModel: DEFAULT_EXTRACTION_FALLBACK_MODEL, geminiApiKey: env.GEMINI_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY, fetchImpl, timeoutMs: 14000});
        return res.status(200).json(await extractInvoice({provider: extractionProvider, ...file}));
      }
      return res.status(200).json(await answerWorkspaceQuestion({provider, store, message: body.message, history: body.history, clock}));
    } catch (error) { return sendError(res, error); }
  };
}

