import { AccountingProviderError, zohoResponseDiagnostics } from './errors.mjs';

export async function providerFetch(fetchImpl, provider, url, options = {}) {
  // Retry only safe Zoho reads; writes and OAuth exchanges may already have succeeded.
  const retries = provider === 'zoho_books' && ['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) ? 2 : 0;
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      break;
    } catch {
      if (attempt >= retries) throw new AccountingProviderError(provider, 502, 'network_error');
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  if (response.ok) return response;

  let providerCode = `http_${response.status}`, diagnostics={};
  try {
    const body = await response.clone().json();
    const code=body?.Fault?.Error?.[0]?.code ?? body?.error ?? body?.code ?? body?.errorCode;
    if (typeof code==='string' || typeof code==='number') providerCode=code;
    if (provider==='zoho_books') diagnostics=zohoResponseDiagnostics(body,url,options);
  } catch {
    // Do not read or include arbitrary response text: it can contain credentials.
  }
  throw Object.assign(new AccountingProviderError(provider,response.status,providerCode),diagnostics);
}

export async function jsonResponse(response, provider) {
  try {
    return await response.json();
  } catch {
    throw new AccountingProviderError(provider, 502, 'invalid_json');
  }
}

export function formBody(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null)).toString();
}

