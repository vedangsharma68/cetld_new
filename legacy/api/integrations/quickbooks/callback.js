export default async function handler(request, response) {
  const { handleAccountingRequest } = await import('../../../automation/accounting-routes.mjs');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'GET required' });
  }
  const incoming = new URL(request.url, 'https://cetld.invalid');
  incoming.searchParams.set('provider', 'quickbooks');
  return handleAccountingRequest({ method: 'GET', headers: request.headers || {}, url: incoming.pathname + incoming.search }, response);
}
