import { AccountingProviderError } from './errors.mjs';

export async function providerFetch(fetchImpl, provider, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new AccountingProviderError(provider, 502, 'network_error');
  }
  if (response.ok) return response;

  let providerCode = `http_${response.status}`;
  try {
    const body = await response.clone().json();
    providerCode = body?.Fault?.Error?.[0]?.code || body?.error || body?.code || body?.errorCode || providerCode;
  } catch {
    // Do not read or include arbitrary response text: it can contain credentials.
  }
  throw new AccountingProviderError(provider, response.status, providerCode);
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

