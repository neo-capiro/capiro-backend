import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AiCredentialResolverService } from './ai-credential-resolver.service.js';
import { encryptSecret, parseAesKey } from '../common/secret-crypto.js';
import { randomBytes } from 'node:crypto';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ctx = { tenantId: TENANT, userId: 'u1', role: 'standard_user' } as never;

const AES_KEY_B64 = randomBytes(32).toString('base64');
const aesKey = parseAesKey(AES_KEY_B64);

interface CredRow {
  tenantId: string;
  provider: string;
  keyCiphertext: string;
  keyIv: string;
  keyAuthTag: string;
  modelOverride: string | null;
  status: string;
}

function credRow(provider: string, plainKey: string, overrides: Partial<CredRow> = {}): CredRow {
  const env = encryptSecret(aesKey, plainKey);
  return {
    tenantId: TENANT,
    provider,
    keyCiphertext: env.ciphertext,
    keyIv: env.iv,
    keyAuthTag: env.authTag,
    modelOverride: null,
    status: 'active',
    ...overrides,
  };
}

function makeService(opts: {
  rows?: CredRow[];
  openaiKey?: string;
  anthropicKey?: string;
  preferred?: 'openai' | 'anthropic';
  encryptionKey?: string | undefined;
}) {
  const values: Record<string, unknown> = {
    OPENAI_API_KEY: opts.openaiKey,
    ANTHROPIC_API_KEY: opts.anthropicKey,
    AI_PROVIDER: opts.preferred,
    OPENAI_MODEL: 'gpt-4.1-mini',
    ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    AI_CREDENTIAL_ENCRYPTION_KEY: opts.encryptionKey,
  };
  const config = { get: (key: string) => values[key] };
  const rows = opts.rows ?? [];
  const prisma = {
    withTenant: jest.fn(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenantAiCredential: {
          findFirst: async (args: {
            where: { tenantId: string; provider: string; status: string };
          }) =>
            rows.find(
              (r) =>
                r.tenantId === args.where.tenantId &&
                r.provider === args.where.provider &&
                r.status === args.where.status &&
                tenantId === r.tenantId,
            ) ?? null,
        },
      }),
    ),
    withSystem: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ tenantAiCredential: { count: async () => rows.length } }),
    ),
  };
  return { svc: new AiCredentialResolverService(config as never, prisma as never), prisma };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AiCredentialResolverService.resolveOrder', () => {
  it('uses the decrypted tenant key + model override when an active credential exists', async () => {
    const { svc } = makeService({
      rows: [credRow('openai', 'sk-tenant-own-key', { modelOverride: 'gpt-4.1' })],
      openaiKey: 'sk-global',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order[0]).toEqual({
      provider: 'openai',
      apiKey: 'sk-tenant-own-key',
      model: 'gpt-4.1',
      usedTenantKey: true,
      modelOverridden: true,
    });
  });

  it('falls back to the global env key when the tenant has no credential', async () => {
    const { svc } = makeService({ openaiKey: 'sk-global', encryptionKey: AES_KEY_B64 });
    const order = await svc.resolveOrder(ctx);
    expect(order).toEqual([
      {
        provider: 'openai',
        apiKey: 'sk-global',
        model: 'gpt-4.1-mini',
        usedTenantKey: false,
        modelOverridden: false,
      },
    ]);
  });

  it('resolves global-only when ctx is null (background/system paths)', async () => {
    const { svc, prisma } = makeService({
      rows: [credRow('openai', 'sk-tenant')],
      openaiKey: 'sk-global',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(null);
    expect(order[0]?.apiKey).toBe('sk-global');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('returns an empty order when no tenant credential and no global keys exist', async () => {
    const { svc } = makeService({ encryptionKey: AES_KEY_B64 });
    await expect(svc.resolveOrder(ctx)).resolves.toEqual([]);
  });

  it('ignores non-active credentials', async () => {
    const { svc } = makeService({
      rows: [credRow('openai', 'sk-tenant', { status: 'disabled' })],
      openaiKey: 'sk-global',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order[0]?.apiKey).toBe('sk-global');
    expect(order[0]?.usedTenantKey).toBe(false);
  });

  it('skips tenant lookup entirely when the encryption key is not configured', async () => {
    const { svc, prisma } = makeService({
      rows: [credRow('openai', 'sk-tenant')],
      openaiKey: 'sk-global',
      encryptionKey: undefined,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order[0]?.apiKey).toBe('sk-global');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('falls back to the global key when decryption fails (rotated/corrupt envelope)', async () => {
    const wrongKey = parseAesKey(randomBytes(32).toString('base64'));
    const env = encryptSecret(wrongKey, 'sk-tenant');
    const { svc } = makeService({
      rows: [
        credRow('openai', 'ignored', {
          keyCiphertext: env.ciphertext,
          keyIv: env.iv,
          keyAuthTag: env.authTag,
        }),
      ],
      openaiKey: 'sk-global',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order[0]?.apiKey).toBe('sk-global');
    expect(order[0]?.usedTenantKey).toBe(false);
  });

  it('honors the preferred provider ordering', async () => {
    const { svc } = makeService({
      openaiKey: 'sk-o',
      anthropicKey: 'sk-a',
      preferred: 'anthropic',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order.map((c) => c.provider)).toEqual(['anthropic', 'openai']);
  });

  it('a tenant key makes a provider available even with no global key for it', async () => {
    const { svc } = makeService({
      rows: [credRow('anthropic', 'sk-ant-tenant')],
      openaiKey: 'sk-global',
      encryptionKey: AES_KEY_B64,
    });
    const order = await svc.resolveOrder(ctx);
    expect(order.map((c) => c.provider)).toEqual(['openai', 'anthropic']);
    expect(order[1]).toMatchObject({ apiKey: 'sk-ant-tenant', usedTenantKey: true });
  });
});

describe('AiCredentialResolverService.resolveProvider (Meri single-provider path)', () => {
  it('resolves the tenant Anthropic key + override when present', async () => {
    const { svc } = makeService({
      rows: [credRow('anthropic', 'sk-tenant-a', { modelOverride: 'claude-opus-4-1' })],
      anthropicKey: 'sk-global-a',
      encryptionKey: AES_KEY_B64,
    });
    const cred = await svc.resolveProvider(ctx, 'anthropic');
    expect(cred).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-tenant-a',
      model: 'claude-opus-4-1',
      usedTenantKey: true,
      modelOverridden: true,
    });
  });

  it('falls back to the global Anthropic key (usedTenantKey=false) when no tenant key', async () => {
    const { svc } = makeService({ anthropicKey: 'sk-global-a', encryptionKey: AES_KEY_B64 });
    const cred = await svc.resolveProvider(ctx, 'anthropic');
    expect(cred).toMatchObject({ apiKey: 'sk-global-a', usedTenantKey: false });
    expect(cred?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('returns null when neither a tenant nor a global Anthropic key exists', async () => {
    const { svc } = makeService({ encryptionKey: AES_KEY_B64 });
    await expect(svc.resolveProvider(ctx, 'anthropic')).resolves.toBeNull();
  });
});

describe('AiCredentialResolverService.validateKey', () => {
  it('returns ok on a 200 provider response', async () => {
    const { svc } = makeService({ encryptionKey: AES_KEY_B64 });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as never);
    await expect(svc.validateKey('openai', 'sk-test')).resolves.toEqual({ ok: true });
  });

  it('returns a bounded status without exposing the provider error body', async () => {
    const { svc } = makeService({ encryptionKey: AES_KEY_B64 });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: 'Incorrect API key provided: sk-provider-echo' },
      }),
    } as never);
    const result = await svc.validateKey('anthropic', 'sk-bad');
    expect(result).toEqual({
      ok: false,
      error: 'Provider rejected the credential (HTTP 401)',
    });
    expect(JSON.stringify(result)).not.toContain('sk-provider-echo');
    expect(JSON.stringify(result)).not.toContain('Incorrect API key');
  });

  it('returns a bounded unavailable error when the provider request fails', async () => {
    const { svc } = makeService({ encryptionKey: AES_KEY_B64 });
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('ECONNRESET request included sk-transport-echo'),
    );
    const result = await svc.validateKey('openai', 'sk-test');
    expect(result).toEqual({
      ok: false,
      error: 'Provider credential validation was unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('ECONNRESET');
    expect(JSON.stringify(result)).not.toContain('sk-transport-echo');
  });
});
