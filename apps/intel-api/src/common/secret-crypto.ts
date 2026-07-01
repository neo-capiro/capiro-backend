/**
 * AES-256-GCM secret decrypt — byte-for-byte the same scheme as apps/api
 * (common/secret-crypto.ts). The workspace engine needs ONLY decrypt (to read
 * a tenant's BYO AI key from tenant_ai_credentials); it never writes keys, so
 * encrypt is intentionally omitted. Key parsing matches apps/api so the same
 * AI_CREDENTIAL_ENCRYPTION_KEY decrypts envelopes written by the API.
 */
import { createDecipheriv } from 'node:crypto';

export interface SecretEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Parse a 32-byte AES key from hex or base64 (throws on anything else). */
export function parseAesKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) {
    throw new Error('Encryption key must decode to exactly 32 bytes');
  }
  return decoded;
}

export function decryptSecret(key: Buffer, envelope: SecretEnvelope): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
