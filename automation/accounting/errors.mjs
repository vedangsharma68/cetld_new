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

