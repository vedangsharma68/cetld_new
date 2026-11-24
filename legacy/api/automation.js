export default async function handler(request, response) {
  const { handleAutomationRequest } = await import('../automation/routes.mjs');
  return handleAutomationRequest(request, response);
};
