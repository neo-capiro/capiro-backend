import { describe, expect, it, jest } from '@jest/globals';
import type { EvidenceDecision, EvidenceEnvelope } from './decision-contract';
import {
  assessWithJevCache,
  decisionsAgree,
  JevDecisionCache,
  jevDecisionCacheKey,
  type JevOutcomeDecision,
} from './decision-cache';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'claim',
  claimText: 'Claim',
  claimKind: 'fact',
  claimCategory: 'general_background',
  tenantId: 'tenant',
  clientId: 'client',
  scopeQualifiers: [],
  asOf: null,
  sources: [
    {
      evidenceId: 'e',
      sourceType: 'document',
      sourceId: 's',
      documentId: 'd',
      version: 'v1',
      locator: null,
      passage: 'Evidence',
      sourceDate: null,
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: null,
    },
  ],
};
const outcome = (value: 'supported' | 'contradicted' = 'supported'): JevOutcomeDecision => ({
  kind: 'outcome',
  outcome: value,
  probabilities: {
    supported: value === 'supported' ? 1 : 0,
    contradicted: value === 'contradicted' ? 1 : 0,
    insufficient_evidence: 0,
    conflicting_evidence: 0,
  },
  confidence: 1,
  reasonCodes: [],
  evidenceIds: ['e'],
  provider: { name: 'jev', model: 'jev-1.13.0', questionVersion: 'claim_support.v1' },
  latencyMs: 1,
});
const question = {
  state: { claim: 'Claim' },
  questions: {
    claim_support: {
      type: 'choice' as const,
      instructions: 'Judge.',
      criteria: { supported: 'yes', contradicted: 'no' },
    },
  },
};
const key = (overrides: Partial<Parameters<typeof jevDecisionCacheKey>[0]> = {}) =>
  jevDecisionCacheKey({
    task: 'claim_support',
    tenantId: 'tenant',
    clientId: 'client',
    envelope,
    claim: { id: 'claim', text: 'Claim' },
    questionVersion: 'claim_support.v1',
    question,
    modelVersion: 'jev-1.13.0',
    cacheIdentityVersion: 'claim_support-cache.v1',
    ...overrides,
  });

describe('JevDecisionCache', () => {
  it('isolates task, tenant, client, envelope, claim, question, model, cache and registry versions', () => {
    const base = key();
    expect(
      new Set([
        base,
        key({ task: 'citation_support' }),
        key({ tenantId: 'other' }),
        key({ clientId: 'other' }),
        key({ envelope: { ...envelope, sources: [{ ...envelope.sources[0]!, version: 'v2' }] } }),
        key({ claim: { id: 'other', text: 'Claim' } }),
        key({ claim: { id: 'claim', text: 'Other' } }),
        key({ questionVersion: 'claim_support.v2' }),
        key({ modelVersion: 'jev-next' }),
        key({ question: { ...question, state: { claim: 'Other' } } }),
        key({ cacheIdentityVersion: 'claim_support-cache.v2' }),
        key({ candidateIdentity: ['other'] }),
        key({ registryVersion: 'registry-next' }),
      ]).size,
    ).toBe(13);
  });

  it('changes identity when provenance changes for provenance-consuming tasks', () => {
    const withProvenance = {
      ...envelope,
      sources: envelope.sources.map((source) => ({
        ...source,
        provenance: {
          evidenceClass: 'official_government_data' as const,
          primary: true,
          authoritative: true,
        },
      })),
    };
    const changed = {
      ...withProvenance,
      sources: withProvenance.sources.map((source) => ({
        ...source,
        provenance: { ...source.provenance, authoritative: false },
      })),
    };
    expect(key({ task: 'program_identity', envelope: withProvenance })).not.toBe(
      key({ task: 'program_identity', envelope: changed }),
    );
  });

  it('expires by TTL and evicts the least recently used entry at the size bound', () => {
    let now = 0;
    const cache = new JevDecisionCache({ maxEntries: 2, ttlMs: 10 }, () => now);
    cache.set('a', outcome());
    cache.set('b', outcome());
    expect(cache.get('a')).toBeDefined();
    cache.set('c', outcome());
    expect(cache.get('b')).toBeUndefined();
    now = 10;
    expect(cache.get('a')).toBeUndefined();
  });

  it('never stores failures and compares only successful outcomes', () => {
    const cache = new JevDecisionCache();
    const failure: EvidenceDecision = {
      kind: 'failure',
      state: 'judge_unavailable',
      reasonCodes: ['failed'],
      provider: { name: 'jev', model: 'jev', questionVersion: 'q' },
      latencyMs: 0,
    };
    cache.set('failure', failure);
    expect(cache.get('failure')).toBeUndefined();
    expect(decisionsAgree(outcome(), outcome())).toBe(true);
    expect(decisionsAgree(outcome(), outcome('contradicted'))).toBe(false);
    expect(decisionsAgree(outcome(), failure)).toBe(false);
  });

  it('shadow never serves while enforce serves a zero-usage, zero-latency marked hit', async () => {
    const cache = new JevDecisionCache();
    const fresh = { ...outcome(), usage: { inputTokens: 10, outputTokens: 1 } };
    cache.set('key', outcome());
    const shadow = await assessWithJevCache({
      mode: 'shadow',
      cache,
      key: 'key',
      assess: async () => fresh,
    });
    expect(shadow).toMatchObject({
      decision: fresh,
      observation: { lookups: 1, hits: 1, agreements: 1 },
    });
    const assess = jest.fn(async () => fresh);
    const enforce = await assessWithJevCache({ mode: 'enforce', cache, key: 'key', assess });
    expect(enforce.decision).toMatchObject({ cached: true, latencyMs: 0 });
    expect(enforce.decision).not.toHaveProperty('usage');
    expect(assess).not.toHaveBeenCalled();
  });
});
