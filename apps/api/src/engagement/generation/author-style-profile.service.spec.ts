/**
 * Author style profile (Phase 1 §3.e1, §5.3).
 *
 * The invariant under test is that NO raw example text reaches a prompt, and
 * that examples are never read across clients. Both were true bugs in the
 * few-shot path this replaces.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { AuthorStyleProfileService } from './author-style-profile.service.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

const CRED = {
  provider: 'anthropic' as const,
  apiKey: 'k',
  model: 'claude-sonnet-4-6',
  usedTenantKey: false,
  modelOverridden: false,
};

const SECRET_EXAMPLE =
  'Dear Senator, per our conversation the CONFIDENTIAL merger closes at $4.2B on March 3.';

function makeService(opts: {
  voiceMemory?: string | null;
  examples?: Array<{ body: string | null }>;
  consent?: boolean;
  extractText?: string;
  extractThrows?: boolean;
} = {}) {
  const findMany = jest.fn(async () => opts.examples ?? []);
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenant: {
          findFirst: async () => ({
            settings: opts.consent
              ? { clioFeatureFlags: { engagementAuthorExampleAnalysis: true } }
              : {},
          }),
        },
        outreachRecord: { findMany },
      }),
  };
  const contextCompiler = {
    compile: jest.fn(async () => ({
      rendered:
        opts.voiceMemory == null
          ? []
          : [{ layer: 'user-voice', type: 'user-voice', body: opts.voiceMemory }],
      items: [],
      exclusions: [],
    })),
  };
  const complete = jest.fn(async () => {
    if (opts.extractThrows) throw new Error('provider down');
    return {
      text:
        opts.extractText ??
        JSON.stringify({
          sentenceLength: 'short',
          greetingPattern: 'First name + em dash',
          closingPattern: 'Best,',
          toneTags: ['direct', 'warm'],
          structureSequence: ['hook', 'ask', 'close'],
          preferredTransitions: ['That said'],
          phrasesToAvoid: ['circle back'],
          formattingPreferences: ['short paragraphs'],
        }),
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });
  const svc = new AuthorStyleProfileService(
    prisma as never,
    contextCompiler as never,
    { complete } as never,
  );
  return { svc, complete, findMany };
}

describe('no raw example text ever reaches the prompt', () => {
  test('the rendered profile block contains no example content', async () => {
    const { svc } = makeService({
      consent: true,
      examples: [{ body: SECRET_EXAMPLE }],
      voiceMemory: 'Direct, warm, no jargon.',
    });
    const profile = await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(profile).not.toBeNull();
    const block = svc.renderProfileBlock(profile!);
    expect(block).not.toMatch(/CONFIDENTIAL/);
    expect(block).not.toMatch(/4\.2B/);
    expect(block).not.toMatch(/March 3/);
    expect(block).toMatch(/AUTHOR STYLE PROFILE/);
    expect(block).toMatch(/contains no prior email text/);
  });

  test('the profile object has no field a raw body could hide in', async () => {
    const { svc } = makeService({ consent: true, examples: [{ body: SECRET_EXAMPLE }] });
    const profile = await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(JSON.stringify(profile)).not.toMatch(/CONFIDENTIAL/);
  });
});

describe('examples are client-scoped and consent-gated (§4.17)', () => {
  test('with NO consent, examples are not even queried', async () => {
    const { svc, findMany, complete } = makeService({
      consent: false,
      voiceMemory: 'Direct and warm.',
    });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(findMany).not.toHaveBeenCalled();
    // …and no extraction call is made either.
    expect(complete).not.toHaveBeenCalled();
  });

  test('with consent, the query is scoped to the CAMPAIGN client', async () => {
    const { svc, findMany } = makeService({ consent: true, examples: [{ body: 'x' }] });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    const calls = findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>;
    const where = calls[0]![0].where;
    expect(where.clientId).toBe('c1');
    expect(where.createdByUserId).toBe('u1');
  });

  test('with NO campaign client there is no safe scope, so no examples are read', async () => {
    const { svc, findMany } = makeService({ consent: true, voiceMemory: 'Direct.' });
    await svc.getProfile(CTX, null, { creds: [CRED], now: NOW });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('degradation never blocks factual generation (§4.18)', () => {
  test('an extractor failure falls back to voice memory', async () => {
    const { svc } = makeService({
      consent: true,
      examples: [{ body: SECRET_EXAMPLE }],
      voiceMemory: 'Direct, warm, no jargon.',
      extractThrows: true,
    });
    const profile = await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(profile).not.toBeNull();
    expect(profile!.derivedFrom).toEqual(['voice_memory']);
  });

  test('no voice memory and no consented examples yields null, not an error', async () => {
    const { svc } = makeService({ voiceMemory: null });
    await expect(svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW })).resolves.toBeNull();
  });
});

describe('extraction is not repeated per recipient', () => {
  test('a second call with the same sources reuses the cached profile', async () => {
    const { svc, complete } = makeService({ consent: true, examples: [{ body: SECRET_EXAMPLE }] });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('voice-memory-only path', () => {
  test('needs no LLM call at all', async () => {
    const { svc, complete } = makeService({ voiceMemory: 'Short, direct, no jargon.' });
    const profile = await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    expect(complete).not.toHaveBeenCalled();
    expect(profile?.sentenceLength).toBe('short');
    expect(profile?.toneTags).toContain('direct');
    expect(profile?.phrasesToAvoid).toContain('jargon');
  });
});

describe('untrusted-sample handling', () => {
  test('examples are spotlighted in the extraction prompt', async () => {
    const { svc, complete } = makeService({ consent: true, examples: [{ body: SECRET_EXAMPLE }] });
    await svc.getProfile(CTX, 'c1', { creds: [CRED], now: NOW });
    const call = (complete.mock.calls as unknown as Array<[{ system: string; userVolatile: string }]>)[0]![0];
    expect(call.userVolatile).toMatch(/<<<EXTERNAL_CONTENT/);
    expect(call.system).toMatch(/untrusted sample DATA/);
    expect(call.system).toMatch(/Never quote or paraphrase/);
  });
});
