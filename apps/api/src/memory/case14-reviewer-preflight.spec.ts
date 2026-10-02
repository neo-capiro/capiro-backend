import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { runWithMemoryGovernanceTenant } from './memory-governance-tenant-scope.js';
import { readCase14ReviewerPreflight } from './case14-reviewer-preflight.js';

const tenantId = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const userId = '11111111-1111-4111-8111-111111111111';
const proposerUserId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-5333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const previousEnv = { ...process.env };
beforeEach(() => {
  process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = tenantId;
});
afterEach(() => {
  process.env = { ...previousEnv };
});

function fixture() {
  const ctx = {
    tenantId,
    tenantSlug: 'meri-foundation-20260928-t1',
    userId,
    clerkUserId: 'user_syntheticPriya',
    role: 'user_admin',
  } as TenantContext;
  const member = { role: 'user_admin', clerkUserId: ctx.clerkUserId };
  const candidate = {
    proposedBy: proposerUserId,
    clientId,
    status: 'pending',
    scope: 'client',
    revision: 1,
    rowVersion: '42',
  };
  const subject = {
    id: candidateId,
    tenantId,
    clientId,
    proposedByUserId: proposerUserId,
    legacyCandidateStatus: 'pending',
  };
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      sql.includes('tenant_memberships') ? [member] : [candidate],
    ),
  };
  const authorization = {
    loadCandidateInTx: jest.fn(async () => subject),
    evaluateInTx: jest.fn(async () => ({ allowed: true, basis: 'admin' })),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, work: (t: unknown) => unknown) =>
      work(tx),
    ),
  };
  const args = {
    prisma: prisma as unknown as PrismaService,
    authorization: authorization as unknown as MemoryAuthorizationService,
    ctx,
    candidateId,
    proposerUserId,
    clientId,
  };
  return {
    args,
    ctx,
    member,
    candidate,
    subject,
    tx,
    authorization,
    prisma,
    run: () => runWithMemoryGovernanceTenant(tenantId, () => readCase14ReviewerPreflight(args)),
  };
}

it('uses the actual canonical authorization port in the same transaction without capability issuance', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({
    candidateId,
    clientId,
    proposerUserId,
    reviewerUserId: userId,
    reviewerRole: 'user_admin',
    rowVersion: '42',
    revision: 1,
    basis: 'admin',
  });
  expect(f.prisma.withTenantUser).toHaveBeenCalledWith(tenantId, userId, expect.any(Function));
  expect(f.authorization.loadCandidateInTx).toHaveBeenCalledWith(f.tx, tenantId, candidateId);
  expect(f.authorization.evaluateInTx).toHaveBeenCalledWith(f.tx, f.ctx, f.subject, 'approve', {
    emitDenialMetrics: false,
  });
  expect((f.tx as unknown as Prisma.TransactionClient).$executeRaw).toBeUndefined();
  expect((f.tx as unknown as Prisma.TransactionClient).$executeRawUnsafe).toBeUndefined();
  for (const [sql] of f.tx.$queryRawUnsafe.mock.calls)
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|set_config)\b/u);
});

it('rejects forged identity, inactive/missing membership and existing-role mismatch before owner decisions', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.ctx.role = 'standard_user';
    },
    (f: ReturnType<typeof fixture>) => {
      f.ctx.userId = proposerUserId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.ctx.tenantId = clientId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.role = 'standard_user';
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.clerkUserId = 'user_foreign';
    },
    (f: ReturnType<typeof fixture>) => {
      f.tx.$queryRawUnsafe.mockResolvedValueOnce([]);
    },
  ]) {
    const f = fixture();
    mutate(f);
    await expect(f.run()).rejects.toThrow('CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED');
    expect(f.authorization.evaluateInTx).not.toHaveBeenCalled();
  }
});

it('rejects wrong proposer/client, nonpending state, revision drift, missing row and owner subject mismatch', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.candidate.proposedBy = userId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.candidate.clientId = userId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.candidate.status = 'approved';
    },
    (f: ReturnType<typeof fixture>) => {
      f.candidate.revision = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.candidate.rowVersion = '4294967296';
    },
    (f: ReturnType<typeof fixture>) => {
      f.subject.tenantId = clientId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.subject.legacyCandidateStatus = 'withdrawn';
    },
    (f: ReturnType<typeof fixture>) => {
      f.tx.$queryRawUnsafe.mockResolvedValueOnce([f.member]).mockResolvedValueOnce([]);
    },
  ]) {
    const f = fixture();
    mutate(f);
    await expect(f.run()).rejects.toThrow('CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED');
  }
});

it('preserves real authorization denial and explicit tenant governance selection', async () => {
  const f = fixture();
  f.authorization.evaluateInTx.mockResolvedValue({ allowed: false, basis: 'admin' });
  await expect(f.run()).rejects.toThrow('CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED');
  const outside = fixture();
  await expect(readCase14ReviewerPreflight(outside.args)).rejects.toThrow(
    'CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED',
  );
  process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'foreign';
  await expect(fixture().run()).rejects.toThrow('CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED');
});
