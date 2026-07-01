import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for client-relevant hearing transcript text.
 *
 * VERBATIM scheme of apps/api/src/engagement/meeting-notes-crypto.service.ts
 * (same algorithm, IV size, payload shape) so the security posture is identical
 * to encrypted meeting debriefs — NO new crypto invented.
 *
 * Key source: dedicated `HEARING_ENCRYPTION_KEY` (recommended — isolates the
 * hearing data domain from meeting notes so keys can rotate independently).
 * Falls back to `NOTES_ENCRYPTION_KEY` if the dedicated key is unset, so a
 * single-key deployment still works.
 */
export interface EncryptedText {
  textCiphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

@Injectable()
export class HearingCryptoService {
  private readonly logger = new Logger(HearingCryptoService.name);
  private readonly key?: Buffer;
  private readonly keyVersion: string;

  constructor(config: ConfigService) {
    const rawKey =
      config.get<string>('HEARING_ENCRYPTION_KEY') ??
      config.get<string>('NOTES_ENCRYPTION_KEY');
    this.key = rawKey ? parseAesKey(rawKey) : undefined;
    this.keyVersion =
      config.get<string>('HEARING_ENCRYPTION_KEY_VERSION') ??
      config.get<string>('NOTES_ENCRYPTION_KEY_VERSION') ??
      'v1';
  }

  /** True when an encryption key is configured. */
  get configured(): boolean {
    return Boolean(this.key);
  }

  encrypt(plainText: string): EncryptedText {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'Hearing transcript encryption is not configured. Set HEARING_ENCRYPTION_KEY.',
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      textCiphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(payload: Pick<EncryptedText, 'textCiphertext' | 'iv' | 'authTag'>): string {
    if (!this.key) {
      throw new ServiceUnavailableException(
        'Hearing transcript encryption is not configured. Set HEARING_ENCRYPTION_KEY.',
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.textCiphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function parseAesKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) {
    throw new Error('HEARING_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return decoded;
}
