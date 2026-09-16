import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AiCredentialStoreService } from './ai-credential-store.service.js';
import { decryptSecret, parseAesKey } from '../common/secret-crypto.js';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const aesKey = parseAesKey(randomBytes(32).toString('base64'));

function makeStore(
  opts: { validateOk?: boolean; validateError?: string; keysEnabled?: boolean } = {},
) {
  const rows = new Map<string, Record<string, unknown>>();
  const tx = {
    tenantAiCredential: {
      upsert: jest.fn(
        async (args: {
          where: { tenantId_provider: { tenantId: string; provider: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = `${args.where.tenantId_provider.tenantId}:${args.where.tenantId_provider.provider}`;
          const existing = rows.get(key);
          const next = existing ? { ...existing, ...args.update } : { ...args.create };
          rows.set(key, next);
          return { ...next, updatedAt: new Date(), lastValidatedAt: new Date() };
        },
      ),
      findMany: jest.fn(async (args: { where: { tenantId: string } }) =>
        Array.from(rows.values()).filter((r) => r.tenantId === args.where.tenantId),
      ),
      deleteMany: jest.fn(async (args: { where: { tenantId: string; provider: string } }) => {
        const key = `${args.where.tenantId}:${args.where.provider}`;
        const existed = rows.delete(key);
        return { count: existed ? 1 : 0 };
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  const resolver = {
    tenantKeysEnabled: opts.keysEnabled ?? true,
    encryptionKeyBuffer: () => aesKey,
    validateKey: jest.fn(async () =>
      opts.validateOk === false
        ? { ok: false, error: opts.validateError ?? 'bad key' }
        : { ok: true },
    ),
  };
  const svc = new AiCredentialStoreService(prisma as never, resolver as never);
  return { svc, rows, tx, resolver };
}

describe('AiCredentialStoreService.upsert', () => {
  it('validates, encrypts, stores last4, and never returns key material', async () => {
    const { svc, rows, resolver } = makeStore();

    const result = await svc.upsert(TENANT, {
      provider: 'openai',
      apiKey: 'sk-proj-supersecret-9876',
      modelOverride: 'gpt-4.1',
      createdByUserId: 'u1',
    });

    expect(resolver.validateKey).toHaveBeenCalledWith(
      'openai',
      'sk-proj-supersecret-9876',
      'gpt-6-astra',
    );

    const stored = rows.get(`${TENANT}:openai`)!;
    expect(stored.keyCiphertext).toBeDefined();
    expect(stored.keyCiphertext).not.toContain('supersecret');
    expect(stored.keyLast4).toBe('9876');
    // Round-trip: the stored envelope decrypts back to the original key.
    expect(
      decryptSecret(aesKey, {
        ciphertext: stored.keyCiphertext as string,
        iv: stored.keyIv as string,
        authTag: stored.keyAuthTag as string,
      }),
    ).toBe('sk-proj-supersecret-9876');

    // The API response is masked-only.
    expect(result).toMatchObject({
      provider: 'openai',
      last4: '9876',
      modelOverride: 'gpt-6-astra',
      status: 'active',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('Ciphertext');
  });

  it('rejects an invalid key with the provider error and stores nothing', async () => {
    const { svc, rows, tx } = makeStore({
      validateOk: false,
      validateError: 'Incorrect API key provided',
    });

    await expect(svc.upsert(TENANT, { provider: 'openai', apiKey: 'sk-bad-0000' })).rejects.toThrow(
      /Incorrect API key/,
    );
    expect(rows.size).toBe(0);
    expect(tx.tenantAiCredential.upsert).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailable when the encryption key is not configured', async () => {
    const { svc } = makeStore({ keysEnabled: false });
    await expect(
      svc.upsert(TENANT, { provider: 'openai', apiKey: 'sk-x-1234' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects unknown providers', async () => {
    const { svc } = makeStore();
    await expect(
      svc.upsert(TENANT, { provider: 'gemini' as never, apiKey: 'sk-x-1234' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AiCredentialStoreService.list/remove', () => {
  it('lists masked credentials only', async () => {
    const { svc } = makeStore();
    await svc.upsert(TENANT, { provider: 'openai', apiKey: 'sk-proj-supersecret-1111' });
    const list = await svc.list(TENANT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: 'openai', last4: '1111' });
    expect(JSON.stringify(list)).not.toContain('supersecret');
  });

  it('remove deletes the credential and reports whether one existed', async () => {
    const { svc } = makeStore();
    await svc.upsert(TENANT, { provider: 'anthropic', apiKey: 'sk-ant-supersecret-2222' });
    await expect(svc.remove(TENANT, 'anthropic')).resolves.toEqual({ removed: true });
    await expect(svc.remove(TENANT, 'anthropic')).resolves.toEqual({ removed: false });
  });
});
