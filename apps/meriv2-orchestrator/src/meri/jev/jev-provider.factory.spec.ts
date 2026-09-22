import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LlmClient } from '@capiro/meriv2-core';
import {
  createChatDecisionProviders,
  resetJevProviderFactoryWarningsForTest,
} from './jev-provider.factory';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';
const baseEnv = {
  TYPESAFE_API_KEY: 'test-secret-value',
  MERI_JEV_PROVIDER_MODE: 'shadow',
  MERI_JEV_PROVIDER_TENANTS: TENANT,
  MERI_JEV_PROVIDER_SURFACES: 'chat',
  MERI_JEV_TASKS: 'claim_support',
  MERI_CHAT_EVIDENCE_JUDGE: 'paired',
};
const llm: LlmClient = {
  completeJson: jest.fn(),
  completeWithSchema: jest.fn(async () => ({
    input: { refuted: false, confidence: 'high', reason: 'The evidence states the claim.' },
    usage: { inputTokens: 10, outputTokens: 3 },
  })),
};

describe('createChatDecisionProviders', () => {
  beforeEach(() => resetJevProviderFactoryWarningsForTest());

  it.each([
    ['off', 'paired', true, false],
    ['shadow', 'llm', true, false],
    ['shadow', 'paired', false, false],
    ['shadow', 'paired', true, true],
  ] as const)('gates mode=%s routing=%s available=%s', (mode, routing, available, expected) => {
    const logger = { warn: jest.fn() };
    const result = createChatDecisionProviders({
      env: {
        ...baseEnv,
        MERI_JEV_PROVIDER_MODE: mode,
        MERI_CHAT_EVIDENCE_JUDGE: routing,
        ...(available ? {} : { TYPESAFE_API_KEY: '' }),
      },
      tenantId: TENANT,
      surface: 'chat',
      llm,
      logger,
    });
    expect(Boolean(result.jev)).toBe(expected);
    expect(result.legacy).toBeDefined();
    if (!expected) expect(logger.warn).toHaveBeenCalledWith('meri.jev.provider_unavailable', expect.any(Object));
  });

  it('rate-limits an unavailable reason to once per process', () => {
    const logger = { warn: jest.fn() };
    for (let i = 0; i < 2; i += 1) createChatDecisionProviders({
      env: { ...baseEnv, MERI_CHAT_EVIDENCE_JUDGE: 'llm' }, tenantId: TENANT,
      surface: 'chat', llm, logger,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('records only when a path is set and excludes credential material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-recording-'));
    const path = join(dir, 'decisions.jsonl');
    try {
      const providers = createChatDecisionProviders({
        env: { ...baseEnv, MERI_CHAT_EVIDENCE_JUDGE: 'llm', MERI_JEV_RECORDING_PATH: path },
        tenantId: TENANT, surface: 'chat', llm,
      });
      await providers.legacy.assess({
        envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c1', claimText: 'Claim.',
        claimKind: 'fact', claimCategory: 'unclassified', tenantId: TENANT, clientId: null,
        scopeQualifiers: [], asOf: null, sources: [],
      }, { state: { claim: 'Claim.' }, questions: {} });
      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain('legacy-skeptic');
      expect(contents).not.toContain(baseEnv.TYPESAFE_API_KEY);
      expect(contents).not.toMatch(/authorization|bearer/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates caller abort to the in-flight Jev fetch', async () => {
    let transportSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        transportSignal = init?.signal ?? undefined;
        transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
      })) as typeof fetch;
    const providers = createChatDecisionProviders({
      env: { ...baseEnv, MERI_JEV_MAX_ATTEMPTS: '1' }, tenantId: TENANT,
      surface: 'chat', llm, fetchImpl,
    });
    const abort = new AbortController();
    const pending = providers.jev!.assess({
      envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c1', claimText: 'Claim.',
      claimKind: 'fact', claimCategory: 'unclassified', tenantId: TENANT, clientId: null,
      scopeQualifiers: [], asOf: null, sources: [],
    }, { state: { claim: 'Claim.' }, questions: {} }, { signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transportSignal?.aborted).toBe(false);
    abort.abort();
    await expect(pending).resolves.toMatchObject({ kind: 'failure', state: 'cancelled' });
    expect(transportSignal?.aborted).toBe(true);
  });
});