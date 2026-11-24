export default async function handler(request, response) {
  const { handleAccountingRequest } = await import('../../../automation/accounting-routes.mjs');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'POST required' });
  }
  const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
  return handleAccountingRequest({ method: 'POST', headers: request.headers || {}, url: '/api/integrations/quickbooks/connect', body: { ...body, provider: 'quickbooks', action: 'start' } }, response);
}
