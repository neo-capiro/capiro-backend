import 'reflect-metadata';
import { ConflictException, NotFoundException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { ClientObjectivesService } from '../../../../apps/api/src/clients/objectives/objectives.service.js';
import { OutreachSessionService } from '../../../../apps/api/src/outreach-v3/services/outreach-session.service.js';
import { OutreachStateRepository } from '../../../../apps/api/src/outreach-v3/persistence/outreach-state.repository.js';
import { OutreachV3StateController } from '../../../../apps/api/src/outreach-v3/api/outreach-v3-state.controller.js';
import { OutreachV3StateGuard } from '../../../../apps/api/src/outreach-v3/api/outreach-v3-state.guard.js';
import { OutreachCommandEngineService } from '../../../../apps/api/src/outreach-v3/services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../../../../apps/api/src/outreach-v3/services/outreach-command-proposal.service.js';
import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from '../../../../apps/api/src/outreach-v3/state/outreach-campaign-spec.v1.js';
import type { PrismaService } from '../../../../apps/api/src/prisma/prisma.service.js';

const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_review', role: 'standard_user' };
const sessionId = '33333333-3333-4333-8333-333333333333';
const input = { clientId: 'ABCDEFAB-4444-4444-8444-444444444444',
  objectiveId: 'BCDEFABC-5555-4555-8555-555555555555', objectiveVersion: 3 };
const normalized = { ...input, clientId: input.clientId.toLowerCase(), objectiveId: input.objectiveId.toLowerCase() };
const revisionId = '66666666-6666-4666-8666-666666666666';
const otherId = '77777777-7777-4777-8777-777777777777';

/** Canned SQL-boundary rows only. This never opens a database or models MVCC/RLS. */
function fixture() {
  const state = { tenantActive: true, memberActive: true, role: 'standard_user', actorMapped: true,
    clientAvailable: true, wall: true, grant: true, objective: true, version: 3, revision: true };
  const calls: Array<{ kind: string; sql: string; values: unknown[] }> = [];
  const session = { id: sessionId, tenantId: ctx.tenantId, createdByUserId: ctx.userId,
    status: 'active', archivedAt: null as Date | null, currentStateVersion: 4,
    title: null, createdAt: new Date('2026-10-12T00:00:00Z'), updatedAt: new Date('2026-10-12T00:00:00Z') };
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = { kind: 'client', clientRefs: [{ clientId: input.clientId }], label: null };
  const version = { id: 'version', tenantId: ctx.tenantId, sessionId, version: 4,
    schemaVersion: spec.schemaVersion, specJsonb: spec as unknown, specHash: hashCampaignSpecV1(spec),
    mutationBatchId: null, createdByUserId: ctx.userId, createdAt: session.createdAt };
  let sessionGate: Promise<void> | undefined;
  let grantGate: Promise<void> | undefined;
  const tx = { $executeRaw: jest.fn(() => { throw Error('Read resolver attempted a mutation'); }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const kind = sql.includes('FROM outreach_sessions') ? 'session' : sql.includes('FROM tenants') ? 'scope'
        : sql.includes('FROM client_memory_access') ? 'grant' : sql.includes('FROM client_objectives') ? 'objective'
          : sql.includes('FROM client_objective_revisions') ? 'revision' : 'unexpected';
      calls.push({ kind, sql, values });
      if (kind === 'session') {
        await sessionGate;
        return values[0] === session.id && values[1] === session.tenantId && values[2] === session.createdByUserId ? [session] : [];
      }
      if (kind === 'scope') return state.tenantActive && state.memberActive && state.actorMapped && state.clientAvailable
        && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.role) ? [{ memoryWall: state.wall }] : [];
      if (kind === 'grant') { await grantGate; return state.grant ? [{ id: 'grant' }] : []; }
      if (kind === 'objective') return state.objective ? [{ version: state.version }] : [];
      if (kind === 'revision') return state.revision ? [{ id: revisionId }] : [];
      throw Error(`Unexpected SQL: ${sql}`);
    }) };
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _actor: string, run: (tx: Prisma.TransactionClient) => unknown) =>
    run(tx as unknown as Prisma.TransactionClient)) };
  const repository = new OutreachStateRepository();
  jest.spyOn(repository, 'loadStateVersion').mockImplementation(async () => version as never);
  jest.spyOn(repository, 'countPendingProposals').mockResolvedValue(0);
  const objectives = new ClientObjectivesService({} as PrismaService);
  const service = new OutreachSessionService(prisma as unknown as PrismaService, repository, objectives);
  return { state, calls, session, spec, version, tx, prisma, repository, service,
    run: (actor = ctx) => service.getObjectiveDestination(actor, sessionId, input),
    rehash: () => { version.specHash = hashCampaignSpecV1(spec); },
    gateSession: (gate: Promise<void>) => { sessionGate = gate; },
    gateGrant: (gate: Promise<void>) => { grantGate = gate; } };
}

describe('Independent integrated Objective/Outreach destination boundary', () => {
  it('normalizes UUIDs and returns only canonical owner identities without mutation', async () => {
    const h = fixture(); const result = await h.run();
    expect(result.destination).toEqual({ kind: 'outreach_session', resourceId: sessionId, ...normalized,
      objectiveRevisionId: revisionId, destinationStateVersion: 4 });
    expect(h.calls.map(c => c.kind)).toEqual(['session', 'scope', 'grant', 'objective', 'revision']);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
    const scope = h.calls[1]!;
    expect(scope.values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId, normalized.clientId]);
    for (const predicate of ["t.status::text='active'", "m.status::text='active'", "m.role::text IN ('standard_user','user_admin','capiro_admin')",
      'u.clerk_user_id=?', "c.status::text<>'archived'", 'FOR SHARE OF t,m,u,c']) expect(scope.sql).toContain(predicate);
    expect(h.calls[2]!.values).toEqual([ctx.tenantId, normalized.clientId, ctx.userId]);
    expect(h.calls[3]!.values).toEqual([ctx.tenantId, normalized.clientId, normalized.objectiveId]);
    expect(h.calls[4]!.values).toEqual([ctx.tenantId, normalized.clientId, normalized.objectiveId, 3]);
  });

  it.each(['tenantActive', 'memberActive', 'actorMapped', 'clientAvailable', 'grant', 'objective', 'revision'] as const)(
    'rechecks current %s on identical replay', async (field) => {
      const h = fixture(); await h.run(); h.state[field] = false;
      await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
      expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(2);
      expect(h.repository.loadStateVersion).toHaveBeenCalledTimes(1);
    });

  it.each(['client_portal_user', 'unknown_role'])('rejects currently downgraded membership %s despite stale administrator context', async (role) => {
    const h = fixture(); h.state.role = role;
    await expect(h.run({ ...ctx, role: 'capiro_admin' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.map(c => c.kind)).toEqual(['session', 'scope']);
  });

  it.each(['tenantId', 'userId'] as const)('refuses changed request %s before Objective authority lookup', async (field) => {
    const h = fixture(); await expect(h.run({ ...ctx, [field]: otherId })).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.calls.map(c => c.kind)).toEqual(['session']);
  });

  it('refuses the historical revision after a current Objective edit, without reading content', async () => {
    const h = fixture(); await h.run(); h.state.version = 4;
    await expect(h.run()).rejects.toBeInstanceOf(ConflictException);
    expect(h.repository.loadStateVersion).toHaveBeenCalledTimes(1);
    expect(h.calls.filter(c => c.kind === 'revision')).toHaveLength(1);
  });

  it('rejects a deleted Objective before reporting its stale version', async () => {
    const h = fixture(); h.state.objective = false; h.state.version = 4;
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
  });

  it('waits for the owned session lock before starting any client/Objective lookup', async () => {
    const h = fixture(); let release!: () => void;
    h.gateSession(new Promise<void>(r => { release = r; }));
    const result = h.run(); await Promise.resolve(); await Promise.resolve();
    expect(h.calls.map(c => c.kind)).toEqual(['session']);
    expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
    release(); await result;
  });

  it('waits for wall authorization before loading revision/content or returning a binding', async () => {
    const h = fixture(); let release!: () => void;
    h.gateGrant(new Promise<void>(r => { release = r; }));
    const result = h.run();
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    expect(h.calls.map(c => c.kind)).toEqual(['session', 'scope', 'grant']);
    expect(h.repository.loadStateVersion).not.toHaveBeenCalled();
    h.state.grant = false; release(); await expect(result).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['archived', 'completed'])('rejects %s on replay before Objective lookup', async (status) => {
    const h = fixture(); await h.run(); h.session.status = status;
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.filter(c => c.kind === 'scope')).toHaveLength(1);
  });

  it('rejects archival marker inconsistency', async () => {
    const h = fixture(); h.session.archivedAt = new Date();
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.map(c => c.kind)).toEqual(['session']);
  });

  it('rechecks the exact newer state version and refuses sponsor transfer', async () => {
    const h = fixture(); await h.run(); h.session.currentStateVersion = 5; h.version.version = 5;
    h.spec.sponsor.clientRefs = [{ clientId: otherId }]; h.rehash();
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.loadStateVersion).toHaveBeenLastCalledWith(h.tx, ctx, sessionId, 5);
    expect(h.repository.countPendingProposals).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'firm', 'multi_client', 'coalition'] as const)('does not derive authority from %s text or client references', async (kind) => {
    const h = fixture(); h.spec.sponsor.kind = kind; h.spec.goal.objective = input.objectiveId;
    h.spec.sponsor.clientRefs = kind === 'multi_client' ? [{ clientId: input.clientId }, { clientId: otherId }] : [];
    h.spec.sponsor.label = kind === 'coalition' ? 'Synthetic coalition' : null;
    h.rehash(); await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repository.countPendingProposals).not.toHaveBeenCalled();
  });

  it.each([{ refs: [] }, { refs: [{ clientId: input.clientId }, { clientId: otherId }] }])('rejects corrupt client sponsor references %j', async ({ refs }) => {
    const h = fixture(); h.spec.sponsor.clientRefs = refs;
    await expect(h.run()).rejects.toMatchObject({ code: 'OUTREACH_STATE_CORRUPT', httpStatus: 500 });
  });

  it.each([null, {}, { schemaVersion: 'unknown' }])('refuses corrupt stored shape %j before metadata', async (shape) => {
    const h = fixture(); h.version.specJsonb = shape;
    await expect(h.run()).rejects.toMatchObject({ code: 'OUTREACH_STATE_CORRUPT', httpStatus: 500 });
    expect(h.repository.countPendingProposals).not.toHaveBeenCalled();
  });

  it('fails closed for a digest mismatch without returning an Objective binding', async () => {
    const h = fixture(); h.version.specHash = 'f'.repeat(64);
    await expect(h.run()).rejects.toMatchObject({ code: 'OUTREACH_STATE_CORRUPT', httpStatus: 500 });
  });
});

describe('Independent duplicate/nested Objective destination HTTP parameters', () => {
  let app: INestApplication;
  const resolver = jest.fn().mockResolvedValue({ destination: { kind: 'outreach_session' } });
  const path = `/engagement/outreach-v3/sessions/${sessionId}/objective-destination`;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [OutreachV3StateController], providers: [
      { provide: OutreachSessionService, useValue: { getObjectiveDestination: resolver } },
      { provide: OutreachCommandEngineService, useValue: {} }, { provide: OutreachCommandProposalService, useValue: {} },
    ] }).overrideGuard(OutreachV3StateGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.use((req: Request & { tenantContext?: TenantContext }, _res: Response, next: NextFunction) => { req.tenantContext = ctx; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  beforeEach(() => resolver.mockClear());
  afterAll(async () => app?.close());

  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('rejects duplicated scalar %s', async (key) => {
    const qs = new URLSearchParams({ ...input, objectiveVersion: String(input.objectiveVersion) });
    qs.append(key, key === 'objectiveVersion' ? '4' : otherId);
    await request(app.getHttpServer()).get(`${path}?${qs.toString()}`).expect(400);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('rejects bracket-array %s', async (key) => {
    const qs = new URLSearchParams({ ...input, objectiveVersion: String(input.objectiveVersion) });
    qs.delete(key); qs.set(`${key}[]`, key === 'objectiveVersion' ? '3' : otherId);
    await request(app.getHttpServer()).get(`${path}?${qs.toString()}`).expect(400);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('rejects nested-object %s', async (key) => {
    const qs = new URLSearchParams({ ...input, objectiveVersion: String(input.objectiveVersion) });
    qs.delete(key); qs.set(`${key}[value]`, key === 'objectiveVersion' ? '3' : otherId);
    await request(app.getHttpServer()).get(`${path}?${qs.toString()}`).expect(400);
    expect(resolver).not.toHaveBeenCalled();
  });
});
