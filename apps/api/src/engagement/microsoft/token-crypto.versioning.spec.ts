import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema.js';
import { TokenCryptoService } from './token-crypto.service.js';

/**
 * ML-25: the persisted `keyVersion` on a stored OAuth token row must select which
 * configured key decrypts it, while every new envelope still uses the active key.
 * These cases are the whole key-version contract; the caller-side behaviour (that
 * each stored row is read with its own persisted version) is covered by the
 * mailbox OAuth / sync specs that pass `token.keyVersion` through.
 *
 * Every key and token value here is generated fresh in-process: no deployment
 * key is read, written or asserted against, and nothing here performs a rotation.
 */
const ACTIVE_VERSION = 'v-new';
const PREVIOUS_VERSION = 'v-old';

/** Fresh synthetic 32-byte key, base64, matching the schema's key material shape. */
const syntheticKey = () => randomBytes(32).toString('base64');
const SECRET = 'synthetic-mailbox-refresh-token';

const service = (env: Record<string, string | undefined>) =>
  new TokenCryptoService({ get: (key: string) => env[key] } as unknown as ConfigService<
    AppConfig,
    true
  >);

describe('TokenCryptoService key versions', () => {
  test('stamps new envelopes with the active version and round-trips them', () => {
    const key = syntheticKey();
    const crypto = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: key,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    });
    const envelope = crypto.encrypt(SECRET);
    expect(envelope.keyVersion).toBe(ACTIVE_VERSION);
    expect(envelope.ciphertext).not.toContain(SECRET);
    expect(crypto.decrypt(envelope, envelope.keyVersion)).toBe(SECRET);
  });

  test('decrypts a row written before the rotation with the configured previous key', () => {
    const oldKey = syntheticKey();
    const newKey = syntheticKey();
    // A row stored while v-old was active: no version field, since the previous
    // implementation encrypted with whatever key the deployment held.
    const legacy = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: oldKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
    }).encrypt(SECRET);

    const rotated = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: newKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: oldKey,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: PREVIOUS_VERSION,
    });

    expect(rotated.getKeyVersion()).toBe(ACTIVE_VERSION);
    expect(rotated.decrypt(legacy, legacy.keyVersion)).toBe(SECRET);
    // New rows keep using the active key, so a rotation drains without rewriting history.
    expect(rotated.encrypt(SECRET).keyVersion).toBe(ACTIVE_VERSION);
  });

  test('does not fall back to the active key for a row that names another version', () => {
    const oldKey = syntheticKey();
    const newKey = syntheticKey();
    const rotated = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: newKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: oldKey,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: PREVIOUS_VERSION,
    });
    // Written by the previous version but relabelled with the active one: the
    // active key must not be tried, because a successful guess would silently
    // misattribute the mailbox token and hide the key-ring mistake.
    const legacy = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: oldKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
    }).encrypt(SECRET);
    expect(() => rotated.decrypt(legacy, ACTIVE_VERSION)).toThrow(ServiceUnavailableException);
  });

  test('refuses an unconfigured version even when the active key would decrypt the bytes', () => {
    const activeKey = syntheticKey();
    const crypto = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: activeKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    });
    const envelope = crypto.encrypt(SECRET);
    expect(() => crypto.decrypt(envelope, 'v-retired')).toThrow(/v-retired.*not configured/);
  });

  test('refuses unreadable ciphertext truthfully instead of returning plaintext', () => {
    const activeKey = syntheticKey();
    const crypto = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: activeKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    });
    const other = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: syntheticKey(),
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    }).encrypt(SECRET);
    expect(() => crypto.decrypt(other, ACTIVE_VERSION)).toThrow(/does not decrypt/);

    const envelope = crypto.encrypt(SECRET);
    const tampered = { ...envelope, authTag: Buffer.from(randomBytes(16)).toString('base64') };
    expect(() => crypto.decrypt(tampered, ACTIVE_VERSION)).toThrow(/does not decrypt/);
  });

  test('keeps the stored ciphertext format of the previous implementation readable', () => {
    // Independently built with the same AES-256-GCM envelope the service always
    // wrote (12-byte IV, base64 ciphertext/iv/tag), so an existing row survives
    // this change untouched under its recorded version.
    const key = Buffer.from(syntheticKey(), 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()]);
    const stored = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
    const crypto = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
    });
    expect(crypto.decrypt(stored, PREVIOUS_VERSION)).toBe(SECRET);
  });

  test('rolls back by demoting the rotated key to the previous key', () => {
    const oldKey = syntheticKey();
    const newKey = syntheticKey();
    const written = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: newKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
    }).encrypt(SECRET);

    // Exact rollback: active version and key go back to the pre-rotation pair and
    // the rotated pair stays configured as the previous key, so rows written in
    // either window stay readable and nothing is rewritten.
    const rolledBack = service({
      OAUTH_TOKEN_ENCRYPTION_KEY: oldKey,
      OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: newKey,
      OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: ACTIVE_VERSION,
    });
    expect(rolledBack.getKeyVersion()).toBe(PREVIOUS_VERSION);
    expect(rolledBack.decrypt(written, ACTIVE_VERSION)).toBe(SECRET);
    expect(rolledBack.decrypt(rolledBack.encrypt(SECRET), PREVIOUS_VERSION)).toBe(SECRET);
  });

  test('rejects a half-configured or version-colliding rotation window at boot', () => {
    const key = syntheticKey();
    expect(() =>
      service({
        OAUTH_TOKEN_ENCRYPTION_KEY: key,
        OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
        OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: syntheticKey(),
      }),
    ).toThrow(/must be set together/);
    expect(() =>
      service({
        OAUTH_TOKEN_ENCRYPTION_KEY: key,
        OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION,
        OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: PREVIOUS_VERSION,
      }),
    ).toThrow(/must be set together/);
    expect(() =>
      service({
        OAUTH_TOKEN_ENCRYPTION_KEY: key,
        OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: PREVIOUS_VERSION,
        OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY: syntheticKey(),
        OAUTH_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION: PREVIOUS_VERSION,
      }),
    ).toThrow(/must differ/);
  });

  test('stays unconfigured, and refuses, without an active key and its version', () => {
    const blank = service({});
    expect(blank.isConfigured()).toBe(false);
    expect(() => blank.encrypt(SECRET)).toThrow(/not configured/);
    expect(() => blank.decrypt({ ciphertext: '', iv: '', authTag: '' }, ACTIVE_VERSION)).toThrow(
      /not configured/,
    );
    // A version without a key is not a usable configuration either.
    const halfway = service({ OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: ACTIVE_VERSION });
    expect(halfway.isConfigured()).toBe(false);
    expect(() => halfway.decrypt({ ciphertext: '', iv: '', authTag: '' }, ACTIVE_VERSION)).toThrow(
      /not configured/,
    );
  });
});
