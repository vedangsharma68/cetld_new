import { MockWhatsAppProvider } from './mock.mjs';
import { UnsupportedWhatsAppProviderError } from './errors.mjs';

/** Explicit provider selection is mandatory. This factory never defaults. */
export function createWhatsAppProvider({ mode, environment = process.env.NODE_ENV, mockOptions } = {}) {
  if (typeof mode !== 'string' || !mode.trim()) throw new UnsupportedWhatsAppProviderError('WhatsApp provider mode must be explicit');
  const selected = mode.trim().toLowerCase();
  if (selected === 'mock') {
    if (environment === 'production') throw new UnsupportedWhatsAppProviderError('mock WhatsApp provider is disabled in production');
    return new MockWhatsAppProvider(mockOptions);
  }
  if (selected === 'wapi' || selected === 'meta') throw new UnsupportedWhatsAppProviderError('WAPI adapter is not configured');
  throw new UnsupportedWhatsAppProviderError(`unknown WhatsApp provider: ${mode}`);
}

export const createWhatsAppProviderFromEnv = (options = {}) => createWhatsAppProvider({ ...options, mode: options.mode ?? process.env.WHATSAPP_PROVIDER });
