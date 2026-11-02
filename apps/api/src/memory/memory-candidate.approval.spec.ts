// PostgreSQL retention is qualified separately with real roles and transactions.
jest.mock('./conversation-serving/transaction.js', () =>
  jest.requireActual('./conversation-serving/unit-boundary.fixture.js'));
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MemoryCandidateService } from './memory-candidate.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

/**
 * Segregation of duties on the live `POST /memory/candidates/:id/approve` route.
 *
 * The route is guarded by `@Roles('user_admin')`, which proves the caller is an
 * admin but says nothing about independence — before this gate, an admin could
 * propose a firm-scope institutional claim and ratify it alone in the next call,
 * because `getPendingOrThrow` never even read `proposed_by`.
 *
 * These tests stop at the gate on purpose: the assertion is that approval is
 * refused *before* any memory write is attempted, which is observable as
 * `withTenant` having been called exactly once (the candidate load).
 */
function makeService(candidate: {
  id: string;
  payload: unknown;
  proposedBy: string;
  scope: string;
}) {
  const queryRaw = jest.fn(async () => [candidate]);
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: queryRaw }),
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  const ingest = {} as unknown as MemoryIngestService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
  const service = new MemoryCandidateService(prisma, ingest, config);
  return { service, withTenantUser };
}

const PAYLOAD = {
  key: 'firm-position:fy27',
  value: 'The firm supports the plus-up.',
  source: 'chat',
  scope: 'firm',
};

describe('MemoryCandidateService.approve — independent reviewer', () => {
  it('refuses a firm-scope proposer approving their own candidate, before any write', async () => {
    const { service, withTenantUser } = makeService({
      id: 'cand-1',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'firm',
    });

    await expect(service.approve('tenant-1', 'cand-1', 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(withTenantUser).toHaveBeenCalledTimes(1); // candidate load only — no commit, no markDecided
  });

  it('refuses a client-scope proposer approving their own candidate', async () => {
    const { service, withTenantUser } = makeService({
      id: 'cand-2',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'client',
    });

    await expect(service.approve('tenant-1', 'cand-2', 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(withTenantUser).toHaveBeenCalledTimes(1);
  });

  it('lets an independent reviewer past the gate on the same firm candidate', async () => {
    const { service } = makeService({
      id: 'cand-3',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'firm',
    });

    // A different approver must NOT be refused by the independence gate. The call
    // still fails further downstream (clio_memory is not stubbed here), so assert
    // specifically that the failure is not the independence refusal.
    await expect(service.approve('tenant-1', 'cand-3', 'admin-2')).rejects.not.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('leaves personal-scope self-approval alone — nobody else can review it', async () => {
    const { service } = makeService({
      id: 'cand-4',
      payload: { ...PAYLOAD, scope: 'user_private', ownerUserId: 'user-1' },
      proposedBy: 'user-1',
      scope: 'personal',
    });

    await expect(service.approve('tenant-1', 'cand-4', 'user-1')).rejects.not.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('MemoryCandidateService.approve — Meri additions are insert-only', () => {
  function makeKeyedService(
    sourceType: string,
    target: { status: string; legalHold: boolean; ownerUserId: string; slug: string; type?: string; governedStatus?: string } | null = {
      status: 'active', legalHold: false, ownerUserId: 'user-1', slug: 'clio:mem-1',
    },
    options: { scope?: 'personal' | 'firm' | 'client'; candidateOwnerUserId?: string; candidateClientId?: string; clientAllowed?: boolean } = {},
  ) {
    const update = jest.fn(async () => ({ id: 'mem-1' }));
    const create = jest.fn(async () => ({ id: 'mem-2' }));
    const tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM clio_memory')) return [{ id: 'mem-1', source: 'chat' }];
        if (sql.includes('FROM memory_items')) {
          return target ? [{ id: 'item-1', type: target.type ?? 'note', slug: target.slug,
            status: target.status, legalHold: target.legalHold,
            ownerUserId: target.ownerUserId, clientId: null,
            governedStatus: target.governedStatus ?? null }] : [];
        }
        return [{
          id: 'cand-9',
          payload: { ...PAYLOAD,
            scope: options.scope === 'firm' ? 'firm' : options.scope === 'client' ? 'client' : 'user_private',
            ownerUserId: options.scope && options.scope !== 'personal' ? null : options.candidateOwnerUserId ?? 'user-1',
            clientId: options.scope === 'client' ? 'client-1' : null,
          },
          proposedBy: 'user-1',
          scope: options.scope ?? 'personal',
          clientId: options.scope === 'client' ? options.candidateClientId ?? 'client-1' : null,
          sourceKind: 'explicit_user',
          sourceType,
        }];
      }),
      $queryRawUnsafe: jest.fn(async () => [{ allowed: options.clientAllowed ?? true }]),
      clioMemory: { findFirst: jest.fn(async () => ({ id: 'mem-1' })), update, create },
    };
    const withTenantUser = jest.fn(
      async (_tenantId: string, _userId: string, fn: (t: unknown) => unknown) => fn(tx),
    );
    const prisma = { withTenantUser } as unknown as PrismaService;
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
    return { service: new MemoryCandidateService(prisma, {} as MemoryIngestService, config), update, create, tx };
  }

  it('refuses a Meri addition whose key is already committed, before any write', async () => {
    const { service, update, create } = makeKeyedService('meri');
    await expect(service.approve('tenant-1', 'cand-9', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the existing upsert for every other source', async () => {
    const { service, update } = makeKeyedService('unknown');
    await service.approve('tenant-1', 'cand-9', 'user-1').catch(() => undefined);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['held', { status: 'active', legalHold: true, ownerUserId: 'user-1', slug: 'clio:mem-1' }],
    ['revoked', { status: 'revoked', legalHold: false, ownerUserId: 'user-1', slug: 'clio:mem-1' }],
    ['foreign owner', { status: 'active', legalHold: false, ownerUserId: 'user-2', slug: 'clio:mem-1' }],
    ['wrong target', { status: 'active', legalHold: false, ownerUserId: 'user-1', slug: 'clio:other' }],
  ] as const)('refuses a stale personal approval targeting a %s item', async (_label, target) => {
    const { service, update, create, tx } = makeKeyedService('unknown', target);
    await expect(service.approve('tenant-1', 'cand-9', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.some(([sql]) => (sql as TemplateStringsArray).join('?').includes('FROM memory_items'))).toBe(true);
  });

  it('refuses a missing personal projection rather than overwriting an unguarded source', async () => {
    const { service, update } = makeKeyedService('unknown', null);
    await expect(service.approve('tenant-1', 'cand-9', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['firm', 'client'] as const)(
    'refuses a pending %s addition when the key was committed before approval',
    async (scope) => {
      const { service, update } = makeKeyedService('unknown', null, { scope });
      await expect(service.approve('tenant-1', 'cand-9', 'reviewer-2')).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('refuses an older personal candidate whose payload names another owner', async () => {
    const { service, update, tx } = makeKeyedService('unknown', null, { candidateOwnerUserId: 'user-2' });
    await expect(service.approve('tenant-1', 'cand-9', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.some(([sql]) => (sql as TemplateStringsArray).join('?').includes('FROM clio_memory'))).toBe(false);
  });

  it('refuses a governed item still pending review before any Clio update', async () => {
    const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    try {
      const { service, update } = makeKeyedService('unknown', {
        status: 'active', legalHold: false, ownerUserId: 'user-1', slug: 'clio:mem-1',
        type: 'user-profile', governedStatus: 'pending_review',
      });
      await expect(service.approve('tenant-1', 'cand-9', 'user-1')).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
      else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
    }
  });

  it('rechecks a client wall before deciding a pending addition', async () => {
    const { service, update, tx } = makeKeyedService('unknown', null, {
      scope: 'client', clientAllowed: false,
    });
    await expect(service.approve('tenant-1', 'cand-9', 'reviewer-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$queryRawUnsafe).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a client payload that differs from the locked review subject', async () => {
    const { service, update, tx } = makeKeyedService('unknown', null, {
      scope: 'client', candidateClientId: 'client-2',
    });
    await expect(service.approve('tenant-1', 'cand-9', 'reviewer-2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('MemoryCandidateService.proposeSaveMemory owner binding', () => {
  it('refuses another owner for a personal auto-commit before inserting a candidate', async () => {
    const withTenantUser = jest.fn();
    const service = new MemoryCandidateService(
      { withTenantUser } as unknown as PrismaService,
      {} as MemoryIngestService,
      { get: jest.fn() } as unknown as ConfigService<AppConfig, true>,
    );
    await expect(service.proposeSaveMemory('tenant-1', 'user-1', {
      scope: 'user_private', ownerUserId: 'user-2', key: 'private', value: 'secret', source: 'chat',
    }, false)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.proposeSaveMemory('tenant-1', 'user-1', {
      scope: 'client', ownerUserId: 'user-1', clientId: 'client-1', key: 'client', value: 'x', source: 'chat',
    }, false)).rejects.toBeInstanceOf(BadRequestException);
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('denies a walled client before candidate insertion', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ allowed: false }]),
      $queryRaw: jest.fn(),
    };
    const withTenantUser = jest.fn(async (_tenant: string, _actor: string, fn: (t: typeof tx) => unknown) => fn(tx));
    const service = new MemoryCandidateService(
      { withTenantUser } as unknown as PrismaService,
      {} as MemoryIngestService,
      { get: jest.fn() } as unknown as ConfigService<AppConfig, true>,
    );
    await expect(service.proposeSaveMemory('tenant-1', 'user-1', {
      scope: 'client', ownerUserId: null, clientId: 'client-1',
      key: 'client-memory', value: 'private client fact', source: 'chat',
    }, false)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$queryRawUnsafe).toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('MemoryCandidateService — W8 Meri personal submissions are owner-only', () => {
  const OWNER = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const CANDIDATE = '66666666-6666-4666-8666-666666666666';
  function makeOwnerService(row: { scope: string; sourceType: string; proposedBy: string; ownerUserId: string | null; sourceKind?: string }) {
    const update = jest.fn(async () => ({ id: 'mem-1' }));
    const findMany = jest.fn(async () => [
      { id: 'a', proposedBy: OWNER, scope: 'personal', sourceType: 'meri', clientId: null },
      { id: 'b', proposedBy: OTHER, scope: 'firm', sourceType: 'meri', clientId: null },
      { id: 'c', proposedBy: OTHER, scope: 'personal', sourceType: 'unknown', clientId: null },
    ]);
    const tx = {
      $queryRaw: jest.fn(async () => [{
        id: CANDIDATE,
        payload: { ...PAYLOAD, scope: 'user_private', ownerUserId: row.ownerUserId },
        proposedBy: row.proposedBy,
        ownerUserId: row.ownerUserId,
        scope: row.scope,
        sourceKind: row.sourceKind ?? 'explicit_user',
        sourceType: row.sourceType,
      }]),
      $executeRaw: jest.fn(async () => 1),
      $queryRawUnsafe: jest.fn(async () => []),
      clioMemory: { findFirst: jest.fn(async () => null), update, create: jest.fn(async () => ({ id: 'mem-2' })) },
      memoryCandidate: { findMany, update: jest.fn(async () => ({ id: CANDIDATE })) },
    };
    const run = async (...args: unknown[]) => (args.at(-1) as (t: unknown) => unknown)(tx);
    const prisma = { withTenantUser: jest.fn(run), withTenant: jest.fn(run) } as unknown as PrismaService;
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
    return { service: new MemoryCandidateService(prisma, {} as MemoryIngestService, config), tx };
  }
  const ctx = (userId: string) => ({ tenantId: 'tenant-1', userId, role: 'user_admin' }) as never;

  it('refuses another user, even an administrator, approving or rejecting it', async () => {
    const { service, tx } = makeOwnerService({ scope: 'personal', sourceType: 'meri', proposedBy: OWNER, ownerUserId: OWNER });
    await expect(service.approve('tenant-1', CANDIDATE, OTHER, ctx(OTHER))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reject('tenant-1', CANDIDATE, OTHER, ctx(OTHER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.clioMemory.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('hides it from every other viewer of the review queue', async () => {
    const { service } = makeOwnerService({ scope: 'personal', sourceType: 'meri', proposedBy: OWNER, ownerUserId: OWNER });
    expect((await service.listPending('tenant-1', OTHER)).map((row) => row.id)).toEqual(['b', 'c']);
    // Legacy personal proposals are private too, regardless of sourceType.
    expect((await service.listPending('tenant-1', OWNER)).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['a non-UUID id', 'not-a-uuid', { scope: 'personal', sourceType: 'meri', proposedBy: OWNER, ownerUserId: OWNER }],
    ['a shared-scope candidate', CANDIDATE, { scope: 'firm', sourceType: 'meri', proposedBy: OWNER, ownerUserId: null }],
    ["another user's candidate", CANDIDATE, { scope: 'personal', sourceType: 'meri', proposedBy: OTHER, ownerUserId: OTHER }],
    ['a candidate owned by someone else', CANDIDATE, { scope: 'personal', sourceType: 'meri', proposedBy: OWNER, ownerUserId: OTHER }],
  ] as Array<[string, string, { scope: string; sourceType: string; proposedBy: string; ownerUserId: string | null }]>)(
    'the owner decision path answers not found for %s', async (_label, id, row) => {
      const { service } = makeOwnerService(row);
      await expect(service.decideOwnPersonalCandidate(ctx(OWNER), id, 'approve')).rejects.toBeInstanceOf(NotFoundException);
    });

  it('sends a version candidate (a Meri correction) to the version routes instead of deciding it', async () => {
    const { service, tx } = makeOwnerService({ scope: 'personal', sourceType: 'user_message', proposedBy: OWNER, ownerUserId: OWNER, sourceKind: 'memory_correction' });
    await expect(service.decideOwnPersonalCandidate(ctx(OWNER), CANDIDATE, 'approve')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clioMemory.create).not.toHaveBeenCalled();
  });

  it('lets the owner reject their own personal submission', async () => {
    const { service, tx } = makeOwnerService({ scope: 'personal', sourceType: 'meri', proposedBy: OWNER, ownerUserId: OWNER });
    await expect(service.decideOwnPersonalCandidate(ctx(OWNER), CANDIDATE, 'reject')).resolves.toEqual({ status: 'rejected' });
    expect(tx.memoryCandidate.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }));
  });
});
