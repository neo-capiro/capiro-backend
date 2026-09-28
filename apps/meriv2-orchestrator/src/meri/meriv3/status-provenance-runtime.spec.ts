import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import {
  enforceRetainedStatusProvenance,
  runStatusProvenance,
} from './status-provenance-runtime';

const ctx = {
  tenantId: 'tenant', userId: 'user', clerkUserId: 'clerk', role: 'standard_user',
} as MeriContext;
const result = {
  found: true,
  ambiguous: false,
  record: {
    productId: 'FR123',
    cspName: 'Acme',
    csoName: 'Acme Cloud',
    status: 'FedRAMP Certified',
    impactLevel: 'Moderate',
    sourceUrl: 'https://fedramp.gov/marketplace/products/',
    observedAt: '2026-09-23T00:00:00.000Z',
  },
};

function registry(value: unknown, failure = false): ToolRegistry {
  const invoke: ToolRegistry['invoke'] = async <O>() => {
    if (failure) throw new Error('down');
    return value as O;
  };
  return { invoke, get: jest.fn(), list: jest.fn(), register: jest.fn(), executionMetadata: jest.fn() };
}

describe('status provenance runtime', () => {
  it('keeps shadow output identical while measuring the released reply', async () => {
    const reply = 'Acme Cloud is FedRAMP approved.';
    const measured = await runStatusProvenance({ reply, mode: 'shadow', registry: registry(result), ctx, deadlineAt: Date.now() + 1000 });
    expect(measured).toMatchObject({ reply, lookupOk: true, detected: 1, outcomes: { paraphrased: 1 } });
  });

  it('enforces exact source wording and attribution', async () => {
    const enforced = await runStatusProvenance({ reply: 'Acme Cloud is FedRAMP approved.', mode: 'enforce', registry: registry(result), ctx, deadlineAt: Date.now() + 1000 });
    expect(enforced.reply).toBe('Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z).');
  });

  it('degrades to the original reply when lookup fails', async () => {
    const reply = 'Acme Cloud is FedRAMP approved.';
    const failed = await runStatusProvenance({ reply, mode: 'enforce', registry: registry(null, true), ctx, deadlineAt: Date.now() + 1000 });
    expect(failed).toMatchObject({ reply, lookupOk: false, failureReason: 'lookup_failed' });
  });

  it('repairs from retained authoritative evidence without another lookup', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved.',
      retainedResults: [result],
    });
    expect(enforced.reply).toBe(
      'Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z).',
    );
    expect(enforced).toMatchObject({ lookupOk: true, outcomes: { paraphrased: 1 } });
  });

  it('does not elevate a retained product status to a company-wide CSP claim', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'Acme is FedRAMP Certified.',
      retainedResults: [result],
    });
    expect(enforced.reply).toBe(
      'Acme is FedRAMP Certified (unverified against the FedRAMP Marketplace).',
    );
    expect(enforced).toMatchObject({ lookupOk: false, outcomes: { exact: 0, unsupported: 1 } });
  });

  it('uses the latest retained status for the same product instead of the first result', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'FR123 is FedRAMP approved.',
      retainedResults: [result, {
        ...result,
        record: {
          ...result.record,
          status: 'FedRAMP In Process',
          observedAt: '2026-09-24T00:00:00.000Z',
        },
      }],
    });
    expect(enforced.reply).toBe(
      'FR123 is FedRAMP In Process at Moderate impact (FedRAMP Marketplace, observed 2026-09-24T00:00:00.000Z).',
    );
    expect(enforced).toMatchObject({ lookupOk: true, outcomes: { mismatch: 1 } });
  });

  it.each([
    ['equal', '2026-09-23T00:00:00.000Z'],
    ['unknown', 'not-a-timestamp'],
  ])('fails closed for retained product statuses with conflicting %s recency', (_label, observedAt) => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'FR123 is FedRAMP approved.',
      retainedResults: [result, {
        ...result,
        record: { ...result.record, status: 'FedRAMP In Process', observedAt },
      }],
    });
    expect(enforced.reply).toContain('unverified against the FedRAMP Marketplace');
    expect(enforced).toMatchObject({ lookupOk: false, outcomes: { unsupported: 1 } });
  });

  it('does not bind retained authority to a different entity', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'Other Cloud is FedRAMP approved.',
      retainedResults: [result],
    });
    expect(enforced.reply).toContain('Other Cloud is FedRAMP approved (unverified against the FedRAMP Marketplace).');
    expect(enforced.reply).not.toContain('Other Cloud is FedRAMP Certified');
    expect(enforced).toMatchObject({
      lookupOk: false,
      failureReason: 'retained_evidence_only',
      outcomes: { paraphrased: 0, unsupported: 1 },
    });
  });

  it('repairs only the matching entity in a mixed retained-evidence reply', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved. Other Cloud is FedRAMP approved.',
      retainedResults: [result],
    });
    expect(enforced.reply).toBe(
      'Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z). '
      + 'Other Cloud is FedRAMP approved (unverified against the FedRAMP Marketplace).',
    );
    expect(enforced).toMatchObject({
      lookupOk: false,
      outcomes: { paraphrased: 1, unsupported: 1 },
    });
  });

  it('treats a mismatched fresh lookup result as unsupported', async () => {
    const enforced = await runStatusProvenance({
      reply: 'Other Cloud is FedRAMP approved.',
      mode: 'enforce',
      registry: registry(result),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain('Other Cloud is FedRAMP approved (unverified against the FedRAMP Marketplace).');
    expect(enforced.reply).not.toContain('Other Cloud is FedRAMP Certified');
    expect(enforced).toMatchObject({ lookupOk: false, outcomes: { unsupported: 1 } });
  });

  it('does not elevate a fresh product lookup to a company-wide CSP claim', async () => {
    const enforced = await runStatusProvenance({
      reply: 'Acme is FedRAMP Certified.',
      mode: 'enforce',
      registry: registry(result),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain('unverified against the FedRAMP Marketplace');
    expect(enforced).toMatchObject({ lookupOk: false, outcomes: { exact: 0, unsupported: 1 } });
  });

  it.each(['Acme Cloud', 'FR123'])('accepts a fresh canonical product %s claim', async (identity) => {
    const enforced = await runStatusProvenance({
      reply: `${identity} is FedRAMP approved.`,
      mode: 'enforce',
      registry: registry(result),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain(`${identity} is FedRAMP Certified at Moderate impact`);
    expect(enforced).toMatchObject({ lookupOk: true, outcomes: { paraphrased: 1 } });
  });

  it('rejects a matching record without authoritative source provenance', async () => {
    const unproven = {
      ...result,
      record: { ...result.record, sourceUrl: undefined },
    };
    const enforced = await runStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved.',
      mode: 'enforce',
      registry: registry(unproven),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain('unverified against the FedRAMP Marketplace');
    expect(enforced).toMatchObject({ lookupOk: false, outcomes: { unsupported: 1 } });
  });

  it.each([
    ['ambiguous', { ...result, ambiguous: true }],
    ['unbound', {
      ...result,
      record: { ...result.record, cspName: undefined, csoName: undefined },
    }],
  ])('treats an %s fresh lookup result as unsupported', async (_label, lookupResult) => {
    const enforced = await runStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved.',
      mode: 'enforce',
      registry: registry(lookupResult),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain('unverified against the FedRAMP Marketplace');
    expect(enforced).toMatchObject({
      lookupOk: false,
      failureReason: 'unsupported_entity',
      outcomes: { unsupported: 1 },
    });
  });

  it('does not bind complete-dataset absence to an unreturned claim identity', async () => {
    const absent = {
      found: false,
      searchedEntireDataset: true,
      evidenceOfAbsence: true,
      sourceUrl: 'https://fedramp.gov/marketplace/products/',
      observedAt: '2026-09-23T00:00:00.000Z',
    };
    const enforced = await runStatusProvenance({
      reply: 'Acme Cloud is not FedRAMP authorized.',
      mode: 'enforce',
      registry: registry(absent),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toContain('unverified; complete-dataset coverage was not established');
    expect(enforced).toMatchObject({
      lookupOk: false,
      outcomes: { negative_unsupported: 1 },
    });
  });

  it('qualifies a status claim when no retained authoritative evidence supports it', () => {
    const enforced = enforceRetainedStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved.',
      retainedResults: [],
    });
    expect(enforced.reply).toContain('unverified against the FedRAMP Marketplace');
    expect(enforced).toMatchObject({
      lookupOk: false,
      failureReason: 'retained_evidence_only',
      outcomes: { unsupported: 1 },
    });
  });
});
