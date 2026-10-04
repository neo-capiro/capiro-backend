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
          if (!existing) next.updatedAt = new Date();
          rows.set(key, next);
          return { ...next, updatedAt: next.updatedAt ?? new Date(), lastValidatedAt: new Date() };
        },
      ),
      findMany: jest.fn(async (args: { where: { tenantId: string } }) =>
        Array.from(rows.values()).filter((r) => r.tenantId === args.where.tenantId),
      ),
      findUnique: jest.fn(
        async (args: { where: { tenantId_provider: { tenantId: string; provider: string } } }) => {
          const key = `${args.where.tenantId_provider.tenantId}:${args.where.tenantId_provider.provider}`;
          const row = rows.get(key);
          return row ? { ...row } : null;
        },
      ),
      updateMany: jest.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const key = `${args.where.tenantId}:${args.where.provider}`;
          const row = rows.get(key);
          if (
            !row ||
            Object.entries(args.where).some(([k, v]) =>
              v instanceof Date && row[k] instanceof Date
                ? (row[k] as Date).getTime() !== v.getTime()
                : row[k] !== v,
            )
          )
            return { count: 0 };
          rows.set(key, { ...row, ...args.data, updatedAt: new Date() });
          return { count: 1 };
        },
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

describe('AiCredentialStoreService.updateModelOverride', () => {
  it('changes only modelOverride and preserves key envelope and credential metadata', async () => {
    const { svc, rows, resolver, tx } = makeStore();
    await svc.upsert(TENANT, { provider: 'openai', apiKey: '«redacted:sk-…»' });
    const key = `${TENANT}:openai`;
    const before = rows.get(key)!;
    const expectedUpdatedAt = before.updatedAt as Date;
    const result = await svc.updateModelOverride(
      TENANT,
      'openai',
      { modelOverride: null, updatedAt: expectedUpdatedAt },
      'gpt-6.1-sol',
    );
    const after = rows.get(key)!;

    for (const [field, value] of Object.entries(before)) {
      if (field !== 'modelOverride' && field !== 'updatedAt') {
        expect(after[field]).toEqual(value);
      }
    }
    expect(after.modelOverride).toBe('gpt-6.1-sol');
    expect(result).toMatchObject({
      provider: 'openai',
      last4: before.keyLast4,
      modelOverride: 'gpt-6.1-sol',
      status: 'active',
    });
    expect(JSON.stringify(result)).not.toContain('keyCiphertext');
    expect(JSON.stringify(result)).not.toContain('keyIv');
    expect(JSON.stringify(result)).not.toContain('keyAuthTag');
    expect(tx.tenantAiCredential.updateMany).toHaveBeenCalledTimes(1);
    expect(resolver.validateKey).toHaveBeenCalledTimes(1); // only initial upsert
  });

  it('restores a null override, rejects unknown provider, absent credential, and stale CAS', async () => {
    const { svc, rows } = makeStore();
    await expect(
      svc.updateModelOverride(
        TENANT,
        'gemini',
        { modelOverride: null, updatedAt: new Date() },
        'gpt-6.1-sol',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'anthropic',
        { modelOverride: null, updatedAt: new Date() },
        'gpt-6.1-sol',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: null, updatedAt: new Date() },
        'gpt-6.1-sol',
      ),
    ).rejects.toThrow(/not found/i);

    await svc.upsert(TENANT, { provider: 'openai', apiKey: '«redacted:sk-…»' });
    const before = rows.get(`${TENANT}:openai`)!;
    const timestamp = before.updatedAt as Date;
    before.modelOverride = 'gpt-6.1-sol';
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: 'other', updatedAt: timestamp },
        null,
      ),
    ).rejects.toThrow(/changed/i);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: 'gpt-6.1-sol', updatedAt: new Date(timestamp.getTime() + 1) },
        null,
      ),
    ).rejects.toThrow(/changed/i);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: 'gpt-6.1-sol', updatedAt: new Date(timestamp) },
        null,
      ),
    ).resolves.toMatchObject({ modelOverride: null });
  });

  it('rejects invalid model and malformed compare-and-set inputs before database access', async () => {
    const { svc, tx } = makeStore();
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: null, updatedAt: new Date() },
        'gpt-6-astra' as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: undefined as never, updatedAt: new Date() },
        null,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        { modelOverride: null, updatedAt: 'not-a-date' as never },
        null,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.updateModelOverride('', 'openai', { modelOverride: null, updatedAt: new Date() }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.tenantAiCredential.findUnique).not.toHaveBeenCalled();
    expect(tx.tenantAiCredential.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an atomic CAS miss without changing or returning a credential', async () => {
    const { svc, rows, tx } = makeStore();
    await svc.upsert(TENANT, { provider: 'openai', apiKey: 'sk-test-secret-1111' });
    const key = `${TENANT}:openai`;
    const before = { ...rows.get(key)! };
    tx.tenantAiCredential.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expect(
      svc.updateModelOverride(
        TENANT,
        'openai',
        {
          modelOverride: null,
          updatedAt: before.updatedAt as Date,
        },
        'gpt-6.1-sol',
      ),
    ).rejects.toThrow(/changed/i);
    expect(rows.get(key)).toEqual(before);
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
