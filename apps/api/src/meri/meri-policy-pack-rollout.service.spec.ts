import type { PolicySelectionContext } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  TenantCanariedMeriPolicyPackService,
  persistedPolicyPacksEnforcedForTenant,
  resolvePersistedPolicyPackModeForTenant,
  staticBaselineDecision,
} from './meri-policy-pack-rollout.service.js';

const CONTEXT: PolicySelectionContext = {
  tenantId: 'tenant-b',
  actorUserId: '00000000-0000-4000-8000-000000000001',
  actorRole: 'standard_user',
  jurisdiction: 'federal',
  tool: 'send_email',
  channel: 'email',
  recipientType: 'government',
  at: '2026-08-01T12:00:00.000Z',
};

describe('persisted policy-pack tenant rollout', () => {
  const originalMode = process.env.MERI_POLICY_PACK_SOURCE;
  const originalTenants = process.env.MERI_POLICY_PACK_TENANTS;

  // jest.setup.ts sets MERI_POLICY_PACK_TENANTS ??= 'all' so ordinary governed
  // suites run selected. This suite is the dedicated rollout test that must prove
  // fail-closed PRODUCTION semantics, so it owns the environment: an explicit
  // `undefined` argument below falls through to the default parameter, which reads
  // process.env — leaving the Jest-wide 'all' in place would assert 'enforce' and
  // silently invert the invariant this test exists to protect.
  beforeEach(() => {
    delete process.env.MERI_POLICY_PACK_SOURCE;
    delete process.env.MERI_POLICY_PACK_TENANTS;
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.MERI_POLICY_PACK_SOURCE;
    else process.env.MERI_POLICY_PACK_SOURCE = originalMode;
    if (originalTenants === undefined) delete process.env.MERI_POLICY_PACK_TENANTS;
    else process.env.MERI_POLICY_PACK_TENANTS = originalTenants;
  });

  it('stays off when the global ceiling or exact tenant allowlist is absent', () => {
    expect(resolvePersistedPolicyPackModeForTenant('tenant-a', undefined, 'tenant-a')).toBe('off');
    expect(resolvePersistedPolicyPackModeForTenant('tenant-a', 'enforce', undefined)).toBe('off');
    expect(resolvePersistedPolicyPackModeForTenant('tenant-a', 'enforce', '')).toBe('off');
    expect(resolvePersistedPolicyPackModeForTenant('', 'enforce', 'all')).toBe('off');
  });

  it('selects only the exact server-configured tenant or an explicit all-tenant rollout', () => {
    expect(resolvePersistedPolicyPackModeForTenant('Tenant-A', 'shadow', 'tenant-a')).toBe(
      'shadow',
    );
    expect(
      resolvePersistedPolicyPackModeForTenant('tenant-a', 'enforce', 'tenant-b tenant-a'),
    ).toBe('enforce');
    expect(resolvePersistedPolicyPackModeForTenant('tenant-b', 'enforce', 'tenant-a')).toBe('off');
    expect(resolvePersistedPolicyPackModeForTenant('tenant-z', 'enforce', 'all')).toBe('enforce');
    expect(persistedPolicyPacksEnforcedForTenant('tenant-a', 'enforce', 'tenant-a')).toBe(true);
    expect(persistedPolicyPacksEnforcedForTenant('tenant-b', 'enforce', 'tenant-a')).toBe(false);
  });

  it('rejects truthy-looking and near-miss mode/tenant values', () => {
    for (const mode of ['true', 'on', '1', 'yes', 'ENFORCED']) {
      expect(resolvePersistedPolicyPackModeForTenant('tenant-a', mode, 'tenant-a')).toBe('off');
    }
    expect(resolvePersistedPolicyPackModeForTenant('tenant-a', 'enforce', 'tenant-a-extra')).toBe(
      'off',
    );
  });

  it('returns the reviewed static baseline for an unselected tenant without database access', async () => {
    process.env.MERI_POLICY_PACK_SOURCE = 'enforce';
    process.env.MERI_POLICY_PACK_TENANTS = 'tenant-a';
    const prisma = new Proxy(
      {},
      {
        get() {
          throw new Error('unselected tenant must not query persisted policy storage');
        },
      },
    ) as PrismaService;
    const service = new TenantCanariedMeriPolicyPackService(prisma);
    const decision = await service.decide('tenant-b', CONTEXT);
    expect(decision).toEqual(
      expect.objectContaining({
        mode: 'off',
        source: 'static',
        verified: true,
        bindable: true,
        policyPackRowId: null,
        packId: 'capiro-generic-action-approval',
        outcome: 'WARN',
      }),
    );
    expect(decision.context.effectiveUserId).toBe(CONTEXT.actorUserId);
    expect(decision.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a deterministic baseline decision for the same effective context', () => {
    expect(staticBaselineDecision(CONTEXT)).toEqual(staticBaselineDecision(CONTEXT));
  });
});
