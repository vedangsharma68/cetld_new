// CommonJS entrypoint preserves the existing Vercel application's module mode.
module.exports = async function handler(request, response) {
  const { handleAutomationRequest } = await import('../automation/routes.mjs');
  return handleAutomationRequest(request, response);
};
