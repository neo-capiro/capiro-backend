import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientObjectivesService } from '../../clients/objectives/objectives.service.js';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import {
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachSessionService } from './outreach-session.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const sessionId = '33333333-3333-4333-8333-333333333333';
const input = {
  clientId: '44444444-4444-4444-8444-444444444444',
  objectiveId: '55555555-5555-4555-8555-555555555555',
  objectiveVersion: 2,
};
const now = new Date('2026-10-12T10:00:00Z');

function harness() {
  const session = {
    id: sessionId,
    tenantId: ctx.tenantId,
    createdByUserId: ctx.userId,
    status: 'active',
    archivedAt: null as Date | null,
    currentStateVersion: 4,
    createdAt: now,
    updatedAt: now,
    title: 'Synthetic',
  };
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = { kind: 'client', clientRefs: [{ clientId: input.clientId }], label: null };
  const version = {
    id: 'version',
    tenantId: ctx.tenantId,
    sessionId,
    version: 4,
    schemaVersion: spec.schemaVersion,
    specJsonb: spec,
    specHash: hashCampaignSpecV1(spec),
    mutationBatchId: null,
    createdByUserId: ctx.userId,
    createdAt: now,
  };
  const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ sql: strings.join('?'), values });
      return values[0] === session.id &&
        values[1] === session.tenantId &&
        values[2] === session.createdByUserId
        ? [session]
        : [];
    }),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenant: string, _actor: string, run: (tx: unknown) => unknown) => run(tx),
    ),
  };
  const repository = new OutreachStateRepository();
  jest.spyOn(repository, 'loadStateVersion').mockResolvedValue(version);
  jest.spyOn(repository, 'countPendingProposals').mockResolvedValue(0);
  const objectives = {
    requireDestinationRevisionWithinTx: jest
      .fn()
      .mockResolvedValue({ ...input, objectiveRevisionId: '66666666-6666-4666-8666-666666666666' }),
  };
  const service = new OutreachSessionService(
    prisma as unknown as PrismaService,
    repository,
    objectives as unknown as ClientObjectivesService,
  );
  const run = (actor = ctx) => service.getObjectiveDestination(actor, sessionId, input);
  return {
    session,
    spec,
    version,
    sqlCalls,
    tx,
    prisma,
    repository,
    objectives,
    run,
    rehash: () => {
      version.specHash = hashCampaignSpecV1(spec);
    },
  };
}

describe('Outreach canonical Objective destination owner (synthetic transactions)', () => {
  it('returns bounded revision/resource binding and the exact authorized current session', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.destination).toEqual({
      kind: 'outreach_session',
      resourceId: sessionId,
      ...input,
      objectiveRevisionId: '66666666-6666-4666-8666-666666666666',
      destinationStateVersion: 4,
    });
    expect(result.specHash).toBe(h.version.specHash);
    expect(result.currentStateVersion).toBe(4);
    expect(h.sqlCalls[0]!.sql).toContain('FOR UPDATE');
    expect(h.sqlCalls[0]!.sql).toContain('created_by_user_id = CAST(');
    expect(h.sqlCalls[0]!.values).toEqual([sessionId, ctx.tenantId, ctx.userId]);
    expect(h.objectives.requireDestinationRevisionWithinTx).toHaveBeenCalledWith(h.tx, ctx, input);
    expect(h.repository.loadStateVersion).toHaveBeenCalledWith(h.tx, ctx, sessionId, 4);
  });

  it.each(['tenantId', 'userId'] as const)(
    'rejects a foreign %s before objective or spec lookup',
    async (field) => {
      const h = harness();
      await expect(
        h.run({ ...ctx, [field]: '77777777-7777-4777-8777-777777777777' }),
      ).rejects.toBeInstanceOf(OutreachCommandError);
      expect(h.objectives.requireDestinationRevisionWithinTx).not.toHaveBeenCalled();
      expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'completed'])('refuses %s sessions', async (status) => {
    const h = harness();
    h.session.status = status;
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
  });

  it('refuses an archive marker even if status disagrees', async () => {
    const h = harness();
    h.session.archivedAt = now;
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['none', 'firm', 'multi_client'] as const)('refuses %s sponsor scope', async (kind) => {
    const h = harness();
    h.spec.sponsor.kind = kind;
    h.spec.sponsor.clientRefs =
      kind === 'multi_client'
        ? [{ clientId: input.clientId }, { clientId: '77777777-7777-4777-8777-777777777777' }]
        : [];
    h.rehash();
    await expect(h.run()).rejects.toThrow();
    expect(h.repository.countPendingProposals).not.toHaveBeenCalled();
  });

  it('rejects a different canonical client, with no metadata returned', async () => {
    const h = harness();
    h.spec.sponsor.clientRefs = [{ clientId: '77777777-7777-4777-8777-777777777777' }];
    h.rehash();
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.countPendingProposals).not.toHaveBeenCalled();
  });

  it('rejects a stale Objective before loading campaign content', async () => {
    const h = harness();
    h.objectives.requireDestinationRevisionWithinTx.mockRejectedValue(new ConflictException());
    await expect(h.run()).rejects.toBeInstanceOf(ConflictException);
    expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
  });

  it('rechecks authority on exact replay and refuses a revoked membership or wall', async () => {
    const h = harness();
    await h.run();
    h.objectives.requireDestinationRevisionWithinTx.mockRejectedValue(new NotFoundException());
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.objectives.requireDestinationRevisionWithinTx).toHaveBeenCalledTimes(2);
    expect(h.repository.loadStateVersion).toHaveBeenCalledTimes(1);
  });

  it('observes sponsor changes on replay instead of trusting a prior binding', async () => {
    const h = harness();
    await h.run();
    h.session.currentStateVersion = 5;
    h.version.version = 5;
    h.spec.sponsor.clientRefs = [{ clientId: '77777777-7777-4777-8777-777777777777' }];
    h.rehash();
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.loadStateVersion).toHaveBeenLastCalledWith(h.tx, ctx, sessionId, 5);
  });

  it('refuses corrupt stored Campaign Spec hashes', async () => {
    const h = harness();
    h.version.specHash = '0'.repeat(64);
    await expect(h.run()).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CORRUPT',
      httpStatus: 500,
    });
  });
});
