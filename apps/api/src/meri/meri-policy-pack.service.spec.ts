import { describe, expect, it, jest } from '@jest/globals';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  policyPackRulesHash,
} from '@capiro/meriv2-core';
import {
  MeriPolicyPackService,
  resolveActionPolicyContext,
  resolvePersistedPolicyPackMode,
} from './meri-policy-pack.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PACK_ROW = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId: TENANT, userId: USER, role: 'user_admin' } as never;

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
    authorityJson: pack.authority,
    effectiveFrom: new Date(pack.effectiveFrom),
    effectiveUntil: null,
    ownerUserId: USER,
    reviewedByUserId: USER,
    reviewedAt: new Date(pack.reviewedAt!),
    secondApprovedByUserId: null,
    secondApprovedAt: null,
    publishedByUserId: USER,
    publishedAt: new Date(pack.publishedAt!),
    fourEyesRequired: false,
    rulesJson: pack.rules,
    fallbackOutcome: pack.fallback,
    nonProduction: false,
    rulesHash: policyPackRulesHash(pack),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function harness(rows: unknown[] = [row()]) {
  const decisionCreate = jest.fn(async () => ({}));
  const tx = {
    compliancePolicyPack: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async () => rows[0] ?? null),
      create: jest.fn(async ({ data }: any) => ({ ...row(), ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...row(), ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    compliancePolicyDecision: { create: decisionCreate, findMany: jest.fn(async () => []) },
    compliancePolicyPackEvent: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  };
  const prisma = { withTenant: jest.fn(async (_tenant: string, fn: any) => fn(tx)) } as never;
  return { service: new MeriPolicyPackService(prisma), tx, decisionCreate };
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

  it('derives state/local/government-recipient context server-side', () => {
    expect(resolveActionPolicyContext(ctx, 'update_state_bill', { stateCode: 'FL' }).jurisdiction).toBe('state');
    expect(resolveActionPolicyContext(ctx, 'update_local_target', { city: 'Miami' }).jurisdiction).toBe('local');
    expect(resolveActionPolicyContext(ctx, 'send_email', { to: 'staff@mail.house.gov' }).recipientType).toBe('government');
  });

  it('off keeps the reviewed static baseline authoritative', async () => {
    delete process.env.MERI_POLICY_PACK_SOURCE;
    const decision = await harness([]).service.decideForAction(ctx, 'create_word', {});
    expect(decision.source).toBe('static');
    expect(decision.outcome).toBe('PASS');
    expect(decision.binding).toContain('internal_artifacts.pass');
  });

  it('shadow never lets a persisted PASS/BLOCK bind real traffic', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'shadow';
    const decision = await harness().service.decideForAction(ctx, 'send_email', { to: 'x@example.com' });
    expect(decision.source).toBe('static');
    expect(decision.mode).toBe('shadow');
    expect(decision.shadowDecision?.source).toBe('persisted');
  });

  it('enforce selects a verified persisted row and preserves its database id', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    const decision = await harness().service.decideForAction(ctx, 'send_email', { to: 'x@example.com' });
    expect(decision.source).toBe('persisted');
    expect(decision.policyPackRowId).toBe(PACK_ROW);
    expect(decision.outcome).toBe('WARN');
    expect(decision.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('missing enforced pack blocks rather than falling back to static PASS', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    const decision = await harness([]).service.decideForAction(ctx, 'create_word', {});
    expect(decision.source).toBe('fail_closed');
    expect(decision.outcome).toBe('BLOCK');
    expect(decision.code).toBe('policy_pack_missing');
  });

  it('tampered enforced pack is refused and blocks', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    const decision = await harness([row({ rulesHash: '0'.repeat(64) })]).service.decideForAction(ctx, 'create_word', {});
    expect(decision.outcome).toBe('BLOCK');
    expect(decision.code).toBe('policy_pack_integrity');
  });

  it('simulation is explicitly non-bindable', async () => {
    const result = await harness().service.simulateAdmin(ctx, PACK_ROW, 'send_email', { to: 'x@example.com' });
    expect(result).toMatchObject({ simulated: true, bindable: false, binding: null, decisionHash: null });
  });
});
