export class AccountingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
    this.details = details;
  }
}

export class AccountingProviderError extends AccountingError {
  constructor(provider, status, code = 'provider_error', details = undefined) {
    super('ACCOUNTING_PROVIDER_ERROR', `${provider} accounting provider request failed`, details);
    this.name = 'AccountingProviderError';
    this.provider = provider;
    this.status = Number.isInteger(status) ? status : 502;
    this.providerCode = String(code).slice(0, 100);
  }
}

export function redactedError(error) {
  if (error instanceof AccountingProviderError) {
    return {
      code: error.code,
      provider: error.provider,
      status: error.status,
      providerCode: error.providerCode,
      message: error.message,
    };
  }
  return {
    code: error?.code || 'ACCOUNTING_ERROR',
    message: 'Accounting integration request failed',
  };
}

// Select provider fields explicitly. Public errors stay generic; full bodies
// and OAuth responses must never become invoice metadata.
export function providerDiagnostics(error) {
  if (!(error instanceof AccountingProviderError)) return {providerCode:null,providerMessage:null,providerOperation:null};
  return {providerCode:error.providerCode || null,providerMessage:error.providerMessage || null,providerOperation:error.providerOperation || null};
}

export function zohoResponseDiagnostics(body, url, options={}) {
  const path=new URL(url).pathname;
  if (!path.startsWith('/books/v3/')) return {};
  const authorization=new Headers(options.headers).get('authorization') || '';
  const credential=authorization.replace(/^\S+\s+/, '');
  const scrub=value=>{
    if (typeof value!=='string') return null;
    let text=value;
    if (credential.length>=8) text=text.split(credential).join('[redacted]');
    text=text.replace(/(?:Zoho-oauthtoken|Bearer|Basic)\s+[^\s"'<>]+/gi,'[redacted authorization]')
      .replace(/((?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|api[_ -]?key|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;<>}]+/gi,'$1[redacted]');
    // Preserve complete Unicode characters so truncation remains valid jsonb.
    return Array.from(text.toWellFormed()).slice(0,2000).join('');
  };
  return {providerMessage:scrub(body?.message),providerOperation:`${String(options.method || 'GET').toUpperCase()} ${path}`.slice(0,200)};
}
