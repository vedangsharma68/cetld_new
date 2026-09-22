import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AccountingError } from './errors.mjs';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64(value) {
  return Buffer.from(value, 'base64');
}

export function encryptionKeyFromEnv(value = process.env.ACCOUNTING_TOKEN_ENCRYPTION_KEY) {
  if (!value) throw new AccountingError('ACCOUNTING_KEY_MISSING', 'Accounting token encryption is not configured');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new AccountingError('ACCOUNTING_KEY_INVALID', 'Accounting token encryption key must be 32 bytes of base64');
  return key;
}

/** AES-256-GCM envelope. The caller supplies an AAD containing provider/workspace. */
export class TokenCipher {
  constructor(key = encryptionKeyFromEnv()) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('TokenCipher needs a 32-byte key');
    this.key = Buffer.from(key);
  }

  encrypt(tokens, aad) {
    if (!aad || typeof aad !== 'string') throw new TypeError('Token encryption AAD is required');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return {
      version: 1,
      iv: b64url(iv),
      ciphertext: b64url(ciphertext),
      tag: b64url(cipher.getAuthTag()),
    };
  }

  decrypt(envelope, aad) {
    if (!aad || typeof aad !== 'string') throw new TypeError('Token encryption AAD is required');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, fromB64(envelope.iv));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(fromB64(envelope.tag));
      return JSON.parse(Buffer.concat([decipher.update(fromB64(envelope.ciphertext)), decipher.final()]).toString('utf8'));
    } catch {
      throw new AccountingError('ACCOUNTING_TOKEN_INVALID', 'Accounting credentials could not be decrypted');
    }
  }
}

export function connectionAad(provider, workspaceId) {
  return `cetld:accounting:${String(provider)}:${String(workspaceId)}`;
}

