import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { CAPIRO_APPROVED_GENERIC_POLICY_PACK, policyPackRulesHash } from '@capiro/meriv2-core';
import {
  MeriPolicyPackService,
  resolveActionPolicyContext,
  resolvePersistedPolicyPackMode,
} from './meri-policy-pack.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const PUBLISHER = '55555555-5555-4555-8555-555555555555';
const PACK_ROW = '66666666-6666-4666-8666-666666666666';

function context(userId = OWNER, role: TenantRole = 'user_admin'): TenantContext {
  return {
    tenantId: TENANT,
    tenantSlug: 'test',
    userId,
    clerkUserId: `clerk-${userId}`,
    role,
  };
}

function row(over: Record<string, unknown> = {}) {
  const pack = CAPIRO_APPROVED_GENERIC_POLICY_PACK;
  return {
    id: PACK_ROW,
    tenantId: TENANT,
    packKey: pack.id,
    version: pack.version,
    jurisdiction: pack.jurisdiction,
    status: 'published',
    legalReviewStatus: pack.legalReviewStatus,
    authorityJson: structuredClone(pack.authority),
    effectiveFrom: new Date(pack.effectiveFrom),
    effectiveUntil: null,
    ownerUserId: OWNER,
    reviewedByUserId: OWNER,
    reviewedAt: new Date(pack.reviewedAt!),
    secondApprovedByUserId: null,
    secondApprovedAt: null,
    publishedByUserId: OWNER,
    publishedAt: new Date(pack.publishedAt!),
    fourEyesRequired: false,
    rulesJson: structuredClone(pack.rules),
    fallbackOutcome: pack.fallback,
    nonProduction: false,
    rulesHash: policyPackRulesHash(pack),
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    ...over,
  };
}

function valueMatches(value: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const comparison = expected as { in?: unknown[] };
    if (comparison.in) return comparison.in.includes(value);
  }
  return value === expected;
}

function harness(
  initialRows: Array<Record<string, unknown>> = [row()],
  options: { publishedLoadError?: Error } = {},
) {
  let rows = initialRows.map((item) => ({ ...item }));
  const decisions: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let sequence = 0;

  function filter(where: Record<string, unknown> | undefined) {
    return rows.filter((candidate) => {
      if (!where) return true;
      return Object.entries(where).every(([key, expected]) =>
        valueMatches(candidate[key], expected),
      );
    });
  }

  const tx = {
    compliancePolicyPack: {
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        if (options.publishedLoadError && where?.status === 'published') {
          throw options.publishedLoadError;
        }
        return filter(where);
      }),
      findFirst: jest.fn(
        async ({ where }: { where?: Record<string, unknown> }) => filter(where)[0] ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        sequence += 1;
        const created = {
          id: `77777777-7777-4777-8777-${String(sequence).padStart(12, '0')}`,
          reviewedByUserId: null,
          reviewedAt: null,
          secondApprovedByUserId: null,
          secondApprovedAt: null,
          publishedByUserId: null,
          publishedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(created);
        return created;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = rows.findIndex((candidate) => candidate.id === where.id);
          if (index < 0) throw new Error('not found');
          rows[index] = { ...rows[index], ...data, updatedAt: new Date() };
          return rows[index];
        },
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    compliancePolicyDecision: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        decisions.push(data);
        return { id: `decision-${decisions.length}`, ...data };
      }),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        decisions.filter((decision) =>
          Object.entries(where ?? {}).every(([key, expected]) => decision[key] === expected),
        ),
      ),
    },
    compliancePolicyPackEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ id: `event-${events.length + 1}`, occurredAt: new Date(), ...data });
        return events.at(-1);
      }),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        events.filter((event) =>
          Object.entries(where ?? {}).every(([key, expected]) => event[key] === expected),
        ),
      ),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (db: typeof tx) => unknown) => fn(tx)),
  } as never;
  return {
    service: new MeriPolicyPackService(prisma),
    tx,
    decisions,
    events,
    rows: () => rows,
  };
}

const original = process.env.MERI_POLICY_PACK_SOURCE;
afterEach(() => {
  if (original === undefined) delete process.env.MERI_POLICY_PACK_SOURCE;
  else process.env.MERI_POLICY_PACK_SOURCE = original;
  jest.restoreAllMocks();
});

describe('Phase 10 authoritative policy source', () => {
  it('parses off/shadow/enforce exactly', () => {
    expect(resolvePersistedPolicyPackMode(undefined)).toBe('off');
    expect(resolvePersistedPolicyPackMode('shadow')).toBe('shadow');
    expect(resolvePersistedPolicyPackMode(' enforce ')).toBe('enforce');
    expect(resolvePersistedPolicyPackMode('true')).toBe('off');
  });

  it('derives jurisdiction, recipient, actor, and effective user server-side', () => {
    expect(
      resolveActionPolicyContext(context(), 'update_state_bill', { stateCode: 'FL' }).jurisdiction,
    ).toBe('state');
    expect(
      resolveActionPolicyContext(context(), 'update_local_target', { city: 'Miami' }).jurisdiction,
    ).toBe('local');
    expect(
      resolveActionPolicyContext(context(), 'send_email', { to: 'staff@mail.house.gov' })
        .recipientType,
    ).toBe('government');
    const impersonatedContext = { ...context(), actorUserId: REVIEWER };
    const impersonated = resolveActionPolicyContext(impersonatedContext, 'create_task', {});
    expect(impersonated.actorUserId).toBe(REVIEWER);
    expect(impersonated.effectiveUserId).toBe(OWNER);
    expect(impersonated.contextFlags).toEqual({ impersonating: true });
  });

  it('off keeps the reviewed static baseline authoritative', async () => {
    delete process.env.MERI_POLICY_PACK_SOURCE;
    const decision = await harness([]).service.decideForAction(context(), 'create_word', {});
    expect(decision.source).toBe('static');
    expect(decision.outcome).toBe('PASS');
    expect(decision.binding).toContain('internal_artifacts.pass');
  });

  it('shadow never lets a persisted decision bind real traffic', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'shadow';
    const decision = await harness().service.decideForAction(context(), 'send_email', {
      to: 'x@example.com',
    });
    expect(decision.source).toBe('static');
    expect(decision.mode).toBe('shadow');
    expect(decision.shadowDecision?.source).toBe('persisted');
  });

  it('enforce selects a verified persisted row and preserves its database id', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    const decision = await harness().service.decideForAction(context(), 'send_email', {
      to: 'x@example.com',
    });
    expect(decision.source).toBe('persisted');
    expect(decision.policyPackRowId).toBe(PACK_ROW);
    expect(decision.outcome).toBe('WARN');
    expect(decision.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('missing, tampered, and unavailable enforced policy all fail closed', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    await expect(
      harness([]).service.decideForAction(context(), 'create_word', {}),
    ).resolves.toEqual(
      expect.objectContaining({
        source: 'fail_closed',
        outcome: 'BLOCK',
        code: 'policy_pack_missing',
      }),
    );
    await expect(
      harness([row({ rulesHash: '0'.repeat(64) })]).service.decideForAction(
        context(),
        'create_word',
        {},
      ),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: 'BLOCK', code: 'policy_pack_integrity' }),
    );
    await expect(
      harness([row()], {
        publishedLoadError: new Error('database unavailable'),
      }).service.decideForAction(context(), 'create_word', {}),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: 'BLOCK', code: 'policy_pack_unavailable' }),
    );
  });

  it('records the exact selected-version decision and effective actor context', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    const h = harness();
    const decision = await h.service.decideForAction(context(), 'send_email', {
      to: 'staff@mail.house.gov',
    });
    await h.service.recordDecisionInTx(h.tx as never, TENANT, decision, {
      tool: 'send_email',
      channel: 'email',
      recipientType: 'government',
      actorUserId: OWNER,
      actorRole: 'user_admin',
      jurisdiction: 'federal',
    });
    expect(h.decisions).toEqual([
      expect.objectContaining({
        policyPackId: PACK_ROW,
        packKey: CAPIRO_APPROVED_GENERIC_POLICY_PACK.id,
        packVersion: CAPIRO_APPROVED_GENERIC_POLICY_PACK.version,
        simulated: false,
        decisionHash: decision.decisionHash,
        contextHash: decision.contextHash,
        effectiveUserId: OWNER,
      }),
    ]);
  });
});

describe('Phase 10 policy-pack administration lifecycle', () => {
  it('denies administration to a standard user before returning tenant policy data', async () => {
    const h = harness();
    await expect(h.service.listAdmin(context(OWNER, 'standard_user'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.tx.compliancePolicyPack.findMany).not.toHaveBeenCalled();
  });

  it('requires independent first review, second approval, and publication', async () => {
    const h = harness();
    const generic = CAPIRO_APPROVED_GENERIC_POLICY_PACK;
    const created = await h.service.createDraft(context(OWNER), {
      packKey: generic.id,
      version: '2026-08-01.v2',
      jurisdiction: 'all',
      legalReviewStatus: 'pending',
      authority: structuredClone(generic.authority),
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      fourEyesRequired: true,
      rules: structuredClone(generic.rules),
      fallback: generic.fallback,
      nonProduction: false,
    });
    const id = String(created.id);

    await h.service.submitReview(context(OWNER), id, 'Ready for independent review.');
    await expect(
      h.service.review(context(OWNER), id, 'approved', 'Self review attempt.'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await h.service.review(context(REVIEWER), id, 'approved', 'First independent review.');
    await expect(
      h.service.secondApprove(context(REVIEWER), id, 'Duplicate reviewer attempt.'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await h.service.secondApprove(context(SECOND), id, 'Second independent approval.');

    await expect(
      h.service.publish(context(REVIEWER), id, 'Reviewer publication attempt.'),
    ).rejects.toBeInstanceOf(BadRequestException);
    const published = await h.service.publish(
      context(PUBLISHER),
      id,
      'Independent administrator publication.',
    );

    expect(published.status).toBe('published');
    expect(published.publishedByUserId).toBe(PUBLISHER);
    const prior = h.rows().find((candidate) => candidate.id === PACK_ROW);
    expect(prior?.status).toBe('retired');
    expect(h.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['create', 'submit_review', 'review', 'approve', 'retire', 'publish']),
    );
  });

  it('rolls back only to a retired production version of the same pack key', async () => {
    const currentId = '77777777-7777-4777-8777-000000000001';
    const targetId = '77777777-7777-4777-8777-000000000002';
    const wrongId = '77777777-7777-4777-8777-000000000003';
    const h = harness([
      row({ id: currentId, version: 'v2', status: 'published', publishedByUserId: PUBLISHER }),
      row({ id: targetId, version: 'v1', status: 'retired', publishedByUserId: REVIEWER }),
      row({
        id: wrongId,
        packKey: 'other-policy',
        version: 'v1',
        status: 'retired',
        publishedByUserId: REVIEWER,
      }),
    ]);

    await expect(
      h.service.rollback(context(PUBLISHER), currentId, wrongId, 'Wrong-key rollback.'),
    ).rejects.toThrow('same pack key');

    const restored = await h.service.rollback(
      context(PUBLISHER),
      currentId,
      targetId,
      'Restore the last known-good reviewed version.',
    );
    expect(restored).toMatchObject({ id: targetId, status: 'published' });
    expect(h.rows().find((candidate) => candidate.id === currentId)?.status).toBe('retired');
    expect(h.events.filter((event) => event.action === 'rollback')).toHaveLength(2);
  });

  it('keeps simulations explicitly non-bindable while retaining audit evidence', async () => {
    const h = harness();
    const result = await h.service.simulateAdmin(context(), PACK_ROW, 'send_email', {
      to: 'x@example.com',
    });
    expect(result).toMatchObject({
      simulated: true,
      bindable: false,
      binding: null,
      decisionHash: null,
    });
    expect(h.decisions).toEqual([expect.objectContaining({ simulated: true })]);
    expect(h.events).toEqual([expect.objectContaining({ action: 'simulate' })]);
  });
});
