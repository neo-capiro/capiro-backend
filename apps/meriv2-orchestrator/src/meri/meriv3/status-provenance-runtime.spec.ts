import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import { runStatusProvenance } from './status-provenance-runtime';

const ctx = {
  tenantId: 'tenant',
  userId: 'user',
  clerkUserId: 'clerk',
  role: 'standard_user',
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
  return {
    invoke,
    get: jest.fn(),
    list: jest.fn(),
    register: jest.fn(),
    executionMetadata: jest.fn(),
  };
}

describe('status provenance runtime', () => {
  it('keeps shadow output identical while measuring the released reply', async () => {
    const reply = 'Acme Cloud is FedRAMP approved.';
    const measured = await runStatusProvenance({
      reply,
      mode: 'shadow',
      registry: registry(result),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(measured).toMatchObject({
      reply,
      lookupOk: true,
      detected: 1,
      outcomes: { paraphrased: 1 },
    });
  });

  it('enforces exact source wording and attribution', async () => {
    const enforced = await runStatusProvenance({
      reply: 'Acme Cloud is FedRAMP approved.',
      mode: 'enforce',
      registry: registry(result),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(enforced.reply).toBe(
      'Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z).',
    );
  });

  it('degrades to the original reply when lookup fails', async () => {
    const reply = 'Acme Cloud is FedRAMP approved.';
    const failed = await runStatusProvenance({
      reply,
      mode: 'enforce',
      registry: registry(null, true),
      ctx,
      deadlineAt: Date.now() + 1000,
    });
    expect(failed).toMatchObject({ reply, lookupOk: false, failureReason: 'lookup_failed' });
  });
});
