import { ConfigService } from '@nestjs/config';
import { HearingCryptoService } from '../src/hearing/hearing-crypto.service.js';

/**
 * SC5.4: client-relevant transcript text is AES-256-GCM encrypted using the
 * meeting_debriefs scheme. Round-trip + tamper-detection.
 */
describe('HearingCryptoService', () => {
  // 32-byte key (hex) for aes-256-gcm.
  const key = '0'.repeat(64);
  const config = {
    get: (name: string) =>
      name === 'HEARING_ENCRYPTION_KEY' ? key : name === 'HEARING_ENCRYPTION_KEY_VERSION' ? 'v1' : undefined,
  } as unknown as ConfigService;

  it('encrypts and decrypts round-trip', () => {
    const svc = new HearingCryptoService(config);
    expect(svc.configured).toBe(true);
    const enc = svc.encrypt('Ranking Member raised unmanned systems funding');
    expect(enc.textCiphertext).not.toContain('unmanned');
    expect(enc.keyVersion).toBe('v1');
    const out = svc.decrypt(enc);
    expect(out).toBe('Ranking Member raised unmanned systems funding');
  });

  it('fails decryption on a tampered auth tag', () => {
    const svc = new HearingCryptoService(config);
    const enc = svc.encrypt('sensitive');
    expect(() =>
      svc.decrypt({ textCiphertext: enc.textCiphertext, iv: enc.iv, authTag: Buffer.alloc(16).toString('base64') }),
    ).toThrow();
  });

  it('reports not-configured when no key is set', () => {
    const empty = { get: () => undefined } as unknown as ConfigService;
    const svc = new HearingCryptoService(empty);
    expect(svc.configured).toBe(false);
    expect(() => svc.encrypt('x')).toThrow();
  });
});
