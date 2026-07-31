import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import {
  evaluateGovernedMemoryAuthorization,
  type MemoryAuthorizationFacts,
} from './memory-authorization.helpers.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'> = {
  tenantId: TENANT,
  userId: USER,
  role: 'standard_user',
};

const subject = {
  id: 'candidate-1',
  tenantId: TENANT,
  clientId: CLIENT,
  ownerUserId: 'proposer-1',
  proposedByUserId: 'proposer-1',
  memoryClass: 'client_steering' as const,
  scope: 'client' as const,
  status: 'pending_review' as const,
  legalHold: false,
  clientStatus: 'active',
};

function serviceHarness(input: { wallAllowed: boolean; permissions: string[] }) {
  let grantSql = '';
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ allowed: input.wallAllowed }]),
    $queryRaw: jest.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings;
      grantSql = strings?.join('?') ?? String(query);
      return input.permissions.length ? [{ permissions: input.permissions }] : [];
    }),
  };
  const service = new MemoryAuthorizationService({} as PrismaService);
  return { service, tx, grantSql: () => grantSql };
}

const facts = (over: Partial<MemoryAuthorizationFacts> = {}): MemoryAuthorizationFacts => ({
  userId: USER,
  role: 'standard_user',
  operation: 'approve',
  subject,
  ethicalWallAllowed: true,
  clientStatus: 'active',
  grantPermissions: [],
  ...over,
});

describe('Phase 12 client-scoped reviewer authorization', () => {
  it('allows a standard user with an explicit client approve grant', async () => {
    const h = serviceHarness({ wallAllowed: true, permissions: ['approve'] });
    await expect(
      h.service.evaluateInTx(h.tx as never, ctx, subject, 'approve'),
    ).resolves.toEqual({ allowed: true, basis: 'explicit_grant' });
  });

  it('denies the same user without a qualifying grant', async () => {
    const h = serviceHarness({ wallAllowed: true, permissions: [] });
    await expect(
      h.service.evaluateInTx(h.tx as never, ctx, subject, 'approve'),
    ).resolves.toEqual({ allowed: false, reason: 'missing_grant' });
  });

  it('does not let a grant bypass the ethical wall', async () => {
    const h = serviceHarness({ wallAllowed: false, permissions: ['approve'] });
    await expect(
      h.service.evaluateInTx(h.tx as never, ctx, subject, 'approve'),
    ).resolves.toEqual({ allowed: false, reason: 'ethical_wall' });
  });

  it('loads only active, unexpired, reasoned grants', async () => {
    const h = serviceHarness({ wallAllowed: true, permissions: [] });
    await h.service.evaluateInTx(h.tx as never, ctx, subject, 'approve');
    expect(h.grantSql()).toContain("status = 'active'");
    expect(h.grantSql()).toContain('expires_at IS NOT NULL');
    expect(h.grantSql()).toContain('expires_at > now()');
    expect(h.grantSql()).toContain("btrim(reason) <> ''");
  });

  it('never applies a client grant to firm memory', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({
          grantPermissions: ['approve'],
          subject: {
            memoryClass: 'institutional_authoritative',
            scope: 'firm',
            status: 'pending_review',
            proposedByUserId: 'proposer-1',
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'admin_required' });
  });

  it('still denies an administrator who lacks wall access', () => {
    expect(
      evaluateGovernedMemoryAuthorization(
        facts({ role: 'user_admin', ethicalWallAllowed: false, grantPermissions: ['approve'] }),
      ),
    ).toEqual({ allowed: false, reason: 'ethical_wall' });
  });
});
