export default async function handler(request, response) {
  const { handleAccountingRequest } = await import('../automation/accounting-routes.mjs');
  return handleAccountingRequest(request, response);
};
