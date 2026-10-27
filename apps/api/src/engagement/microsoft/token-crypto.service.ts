import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema.js';

export interface TokenCiphertext {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface TokenEnvelope extends TokenCiphertext {
  keyVersion: string;
}

interface RotationKey {
  version: string;
  key: Buffer;
}

const NOT_CONFIGURED = 'OAuth token encryption is not configured. Set OAUTH_TOKEN_ENCRYPTION_KEY.';

@Injectable()
export class TokenCryptoService {
  /** New envelopes are always written with the active key and its version. */
  private readonly key?: Buffer;
  private readonly keyVersion: string;
  /** The single explicitly configured rotation-window key, while a rotation is open. */
  private readonly rotationKey?: RotationKey;

  constructor(config: ConfigService<AppConfig, true>) {
    const rawKey = config.get('OAUTH_TOKEN_ENCRYPTION_KEY', { infer: true });
    this.key = rawKey ? parseAesKey(rawKey, 'OAUTH_TOKEN_ENCRYPTION_KEY') : undefined;
    this.keyVersion = config.get('OAUTH_TOKEN_ENCRYPTION_KEY_VERSION', { infer: true });
    this.rotationKey = readRotationKey(config, this.keyVersion);
  }

  isConfigured(): boolean {
    return Boolean(this.key);
  }

  getKeyVersion(): string {
    return this.keyVersion;
  }

  encrypt(plainText: string): TokenEnvelope {
    if (!this.key) throw new ServiceUnavailableException(NOT_CONFIGURED);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  /**
   * Decrypt the stored envelope with the key the row's persisted `keyVersion`
   * names — the active key, or the one rotation key still configured for rows
   * written before it. No other key is tried: a wrong key is indistinguishable
   * from a right one when it happens to authenticate, so guessing would misread a
   * mailbox token and hide the key-ring mistake. An unknown version and an
   * envelope that does not authenticate both refuse with the same operational
   * instruction, and neither falls back to plaintext.
   */
  decrypt(payload: TokenCiphertext, keyVersion: string): string {
    const key = this.selectKey(keyVersion);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException(
        `Stored OAuth token does not decrypt with configured key version '${keyVersion}'; ` +
          'restore the key for that version or reconnect the mailbox',
      );
    }
  }

  private selectKey(keyVersion: string): Buffer {
    if (!this.key) throw new ServiceUnavailableException(NOT_CONFIGURED);
    if (keyVersion === this.keyVersion) return this.key;
    if (this.rotationKey?.version === keyVersion) return this.rotationKey.key;
    throw new ServiceUnavailableException(
      `OAuth token encryption key version '${keyVersion}' is not configured; ` +
        'restore that key or reconnect the mailbox',
    );
  }
}

/** Blank is unset, matching the config schema's blank-to-undefined treatment. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read the bounded rotation window: exactly one previous key plus the version
 * that key was written under. `OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY` and
 * `OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION` are not in `config.schema.ts`
 * yet — that shared edit is a root-owned proposal in this lane — so this accessor
 * is deliberately narrow and the rotation window stays empty until the schema
 * entry lands. A half-configured or version-colliding window is rejected at boot
 * rather than being resolved to whichever key the deployment happens to hold.
 */
function readRotationKey(
  config: ConfigService<AppConfig, true>,
  activeVersion: string,
): RotationKey | undefined {
  const raw = config as unknown as { get(key: string): unknown };
  const value = optionalText(raw.get('OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY'));
  const version = optionalText(raw.get('OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION'));
  if (!value && !version) return undefined;
  if (!value || !version) {
    throw new Error(
      'OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY and OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION must be set together',
    );
  }
  if (version === activeVersion) {
    throw new Error(
      'OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION must differ from OAUTH_TOKEN_ENCRYPTION_KEY_VERSION',
    );
  }
  return { version, key: parseAesKey(value, 'OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY') };
}

function parseAesKey(value: string, name: string): Buffer {
  const trimmed = value.trim();
  const decoded =
    /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return decoded;
}
