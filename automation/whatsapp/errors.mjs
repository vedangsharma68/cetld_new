export class WhatsAppError extends Error {
  constructor(message, code = 'WHATSAPP_ERROR') {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
  }
}

export class InvalidWhatsAppInputError extends WhatsAppError {
  constructor(message) { super(message, 'INVALID_INPUT'); this.name = 'InvalidWhatsAppInputError'; }
}

export class UnsupportedWhatsAppProviderError extends WhatsAppError {
  constructor(message) { super(message, 'UNSUPPORTED_PROVIDER'); this.name = 'UnsupportedWhatsAppProviderError'; }
}
