import { authorizeWorker, authorizeWorkspace, bodyOf, HttpError, respondError, uuid } from './http.mjs';

export async function handleAutomationRequest(request, response, dependencies = {}) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ error: 'POST required' });
  try {
    const env = dependencies.env || process.env;
    const body = bodyOf(request);
    const workspaceId = uuid(body.workspaceId);
    let identity;
    if (body.action === 'tick') {
      authorizeWorker(request, env);
      identity = { workspaceId, ownerId: uuid(body.ownerId) };
    } else {
      identity = await authorizeWorkspace(request, workspaceId, env, dependencies.fetchImpl);
    }
    if (!['tick', 'pause', 'resume', 'configure', 'mock-reply'].includes(body.action)) throw new HttpError(400, 'Unknown automation action');
    const runtime = dependencies.runtime || await import('./runtime.mjs').then(module => module.createAutomationRuntime({ env }));
    let result;
    if (body.action === 'tick') result = await runtime.tick(identity);
    else {
      const invoiceId = uuid(body.invoiceId);
      const scope = { ...identity, invoiceId };
      if (body.action === 'pause') result = await runtime.pause(scope);
      if (body.action === 'resume') result = await runtime.resume(scope);
      if (body.action === 'configure') result = await runtime.configure(scope, body.configuration);
      if (body.action === 'mock-reply') {
        if (env.NODE_ENV === 'production' || env.WHATSAPP_PROVIDER !== 'mock') throw new HttpError(404, 'Unavailable');
        result = await runtime.receiveMockReply(scope, body.event);
      }
    }
    return response.status(200).json(result);
  } catch (error) { return respondError(response, error); }
}
