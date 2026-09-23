import {APIError, object, requestBody, sendError, uuid} from './http.mjs';
import {AIProvider, isFreeModelId, verifyModel} from './provider.mjs';
import {authorizeAIWorkspace} from './store.mjs';
import {extractInvoice} from './extraction.mjs';
import {answerWorkspaceQuestion} from './assistant.mjs';

export function createAIHandler({env = process.env, fetchImpl = fetch, authorize = authorizeAIWorkspace, providerFactory = options => new AIProvider(options), verify = verifyModel, clock = () => new Date()} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const action = req.query?.action;
      if (!['settings', 'extract', 'assistant'].includes(action)) throw new APIError(404, 'NOT_FOUND');
      const methods = action === 'settings' ? ['GET', 'PUT'] : ['POST'];
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new APIError(405, 'METHOD_NOT_ALLOWED'); }
      const body = req.method === 'GET' ? {} : requestBody(req, action === 'settings' ? ['workspaceId', 'primary_model', 'fallback_model'] : action === 'extract' ? ['workspaceId', 'fileId', 'file'] : ['workspaceId', 'message', 'history'], action === 'extract' ? 4400000 : 32768);
      const workspaceId = uuid(req.method === 'GET' ? req.query.workspaceId : body.workspaceId);
      const store = await authorize(req, workspaceId, {env, fetchImpl});
      if (action === 'settings') {
        if (req.method === 'GET') return res.status(200).json(await store.getSettings());
        if (!['owner', 'admin'].includes(store.role)) throw new APIError(403, 'SETTINGS_ADMIN_REQUIRED');
        const {primary_model, fallback_model = null} = body;
        if (!isFreeModelId(primary_model) || (fallback_model !== null && !isFreeModelId(fallback_model)) || primary_model === fallback_model) throw new APIError(400, 'INVALID_MODEL_CONFIGURATION');
        await verify(primary_model, {fetchImpl});
        if (fallback_model) await verify(fallback_model, {fetchImpl});
        return res.status(200).json(await store.saveSettings({primary_model, fallback_model}));
      }
      const settings = await store.getSettings();
      const provider = providerFactory({primaryModel: settings.primary_model, fallbackModel: settings.fallback_model, apiKey: env.OPENROUTER_API_KEY, fetchImpl, timeoutMs: 20000});
      if (action === 'extract') {
        if (Boolean(body.fileId) === Boolean(body.file)) throw new APIError(400, 'ONE_FILE_SOURCE_REQUIRED');
        let file;
        if (body.file) {
          const f = object(body.file, ['base64', 'mimeType', 'fileName']);
          if (typeof f.base64 !== 'string' || f.base64.length === 0 || f.base64.length > 4194304 || f.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) || !['application/pdf','image/png','image/jpeg','image/webp'].includes(f.mimeType) || typeof f.fileName !== 'string' || f.fileName.length > 255) throw new APIError(400, 'INVALID_UPLOAD');
          file = {bytes: Buffer.from(f.base64, 'base64'), mimeType: f.mimeType, fileName: f.fileName};
        } else file = await store.downloadInvoiceFile(uuid(body.fileId));
        return res.status(200).json(await extractInvoice({provider, ...file}));
      }
      return res.status(200).json(await answerWorkspaceQuestion({provider, store, message: body.message, history: body.history, clock}));
    } catch (error) { return sendError(res, error); }
  };
}
