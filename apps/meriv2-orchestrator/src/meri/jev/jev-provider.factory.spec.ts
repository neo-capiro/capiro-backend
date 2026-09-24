import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LlmClient } from '@capiro/meriv2-core';
import {
  createChatDecisionProviders,
  createClientFitClient,
  createPassageSelectionClient,
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

  it('uses the unfiltered passage fallback and emits one event on a model mismatch', () => {
    const logger = { warn: jest.fn() };
    const env = { ...baseEnv, MERI_JEV_TASKS: 'passage_relevance', MERI_JEV_MODEL: 'jev-1.14.0' };
    const first = createPassageSelectionClient({ env, tenantId: TENANT, surface: 'chat', logger });
    const second = createPassageSelectionClient({ env, tenantId: TENANT, surface: 'chat', logger });
    expect(first).toMatchObject({ client: null, reason: 'registry_model_mismatch' });
    expect(second).toMatchObject({ client: null, reason: 'registry_model_mismatch' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('meri.jev.registry_mismatch', {
      task: 'passage_relevance', configuredModel: 'jev-1.14.0', registeredModel: 'jev-1.13.0',
    });
  });

  it.each([
    [{ ...baseEnv, MERI_MATCH_LABEL_MODE: 'off', MERI_JEV_TASKS: 'client_fit' }, 'rollout_off'],
    [{ ...baseEnv, MERI_MATCH_LABEL_MODE: 'shadow', MERI_MATCH_LABEL_TENANTS: TENANT,
      MERI_MATCH_LABEL_SURFACES: 'chat' }, 'task_not_enabled:client_fit'],
    [{ ...baseEnv, MERI_MATCH_LABEL_MODE: 'shadow', MERI_MATCH_LABEL_TENANTS: TENANT,
      MERI_MATCH_LABEL_SURFACES: 'chat', MERI_JEV_TASKS: 'client_fit',
      MERI_JEV_MODEL: 'jev-1.14.0' }, 'registry_model_mismatch'],
  ] as const)('keeps client-fit unavailable when its gates fail', (env, reason) => {
    expect(createClientFitClient({ env, tenantId: TENANT, surface: 'chat' }))
      .toMatchObject({ client: null, reason });
  });

  it('constructs the task-specific client only when match-label and client_fit are enabled', () => {
    const result = createClientFitClient({
      env: { ...baseEnv, MERI_MATCH_LABEL_MODE: 'shadow', MERI_MATCH_LABEL_TENANTS: TENANT,
        MERI_MATCH_LABEL_SURFACES: 'chat', MERI_JEV_TASKS: 'client_fit' },
      tenantId: TENANT, surface: 'chat',
    });
    expect(result.reason).toBeNull();
    expect(result.client?.name).toBe('jev-client-fit');
  });

  it('disables claim-support Jev for live use on a model mismatch', () => {
    const logger = { warn: jest.fn() };
    const result = createChatDecisionProviders({
      env: { ...baseEnv, MERI_JEV_PROVIDER_MODE: 'enforce', MERI_CHAT_EVIDENCE_JUDGE: 'jev',
        MERI_JEV_MODEL: 'jev-1.14.0' },
      tenantId: TENANT, surface: 'chat', llm, logger,
    });
    expect(result.jev).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('meri.jev.registry_mismatch', expect.objectContaining({
      task: 'claim_support',
    }));
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

  it('carries request-scoped LLM usage through the legacy baseline provider', async () => {
    const providers = createChatDecisionProviders({
      env: baseEnv, tenantId: TENANT, surface: 'chat', llm,
    });
    const decision = await providers.legacyBaseline.assess({
      envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c1', claimText: 'Claim.',
      claimKind: 'fact', claimCategory: 'unclassified', tenantId: TENANT, clientId: null,
      scopeQualifiers: [], asOf: null, sources: [],
    }, { state: { claim: 'Claim.' }, questions: {} });
    expect(decision).toMatchObject({
      kind: 'outcome', outcome: 'insufficient_evidence',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });
});