export default async function handler(request, response) {
  const { handleAccountingRequest } = await import('../../../automation/accounting-routes.mjs');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'GET required' });
  }
  const incoming = new URL(request.url, 'https://cetld.invalid');
  incoming.searchParams.set('provider', 'zoho_books');
  return handleAccountingRequest({ ...request, url: incoming.pathname + incoming.search }, response);
};
