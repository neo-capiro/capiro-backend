import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type ExecutionContext,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { MeriMemoryReceivingController } from './meri-memory-receiving.controller.js';
import { MeriMemoryReceivingService } from './meri-memory-receiving.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const openClient = '44444444-4444-4444-8444-444444444444';
const walledClient = '55555555-5555-4555-8555-555555555555';
const candidateId = '66666666-6666-4666-8666-666666666666';
const memoryId = '77777777-7777-4777-8777-777777777777';
const projectionId = '88888888-8888-4888-8888-888888888888';
const versionId = '99999999-9999-4999-8999-999999999999';
const ctx = { tenantId, userId: actorId } as TenantContext;
const SECRET = 'synthetic-service-secret';
const updatedAt = new Date('2026-10-17T00:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'meri.memory-candidate.v1', candidateId, tenantId, proposerActorId: actorId, kind: 'addition',
    scope: 'personal', clientId: null, content: 'Prefers morning briefings', key: 'briefing-time', ttlDays: null,
    corrects: null, reason: null,
    sources: [{ kind: 'conversation_message', reference: 'msg-1', sha256: null, title: null }],
    origin: { kind: 'surface' }, idempotencyKey: 'memory-1', createdAt: '2026-10-18T06:00:00.000Z', ...overrides,
  };
}
const submitBody = (c: Record<string, unknown> = candidate()) => ({ candidate: c, candidateSha256: nativeCanonicalSha256(c) });

function verifiedRequest(verified = true): Request {
  const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
  const guard = new ToolServiceSecretGuard({
    get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false),
  } as never);
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}

interface MemoryFixtureRow {
  id: string; tenantId: string; scope: string; ownerUserId: string | null; clientId: string | null;
  key: string; value: string; expiresAt: Date | null; updatedAt: Date;
}
interface ItemFixtureRow {
  id: string; tenantId: string; clientId: string | null; ownerUserId: string | null; memoryScope: string; title: string;
  sections: unknown; status: string; governedStatus: string; expiresAt: Date | null; updatedAt: Date;
  slug: string; supersedesId: string | null; createdAt: Date;
}

const personal: MemoryFixtureRow = { id: memoryId, tenantId, scope: 'user_private', ownerUserId: actorId, clientId: null, key: 'briefing-time', value: 'Mornings', expiresAt: null, updatedAt };
const projection = (overrides: Partial<ItemFixtureRow> = {}): ItemFixtureRow => ({
  id: projectionId, tenantId, clientId: null, ownerUserId: actorId, memoryScope: 'user_private', title: 'briefing-time',
  sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Mornings' }], status: 'active', governedStatus: 'active',
  expiresAt: null, updatedAt, slug: `clio:${memoryId}`, supersedesId: null, createdAt: new Date('2026-10-17T00:00:00.000Z'), ...overrides,
});
const version = (overrides: Partial<ItemFixtureRow> = {}): ItemFixtureRow => projection({
  id: versionId, slug: `clio:${memoryId}~v${'9'.repeat(32)}`, supersedesId: projectionId,
  sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Evenings' }], createdAt: new Date('2026-10-18T00:00:00.000Z'), ...overrides,
});

function fixture(memories: MemoryFixtureRow[] = [], items: ItemFixtureRow[] = []) {
  const submissions = new Map<string, any>();
  const candidates = new Map<string, any>();
  const inserts: unknown[][] = [];
  const corrections: Array<{ input: any }> = [];
  const sql = (strings: TemplateStringsArray) => strings.join('?');
  const tx: any = {
    clioMeriMemorySubmission: {
      findUnique: jest.fn(async ({ where }: any) => submissions.get(where.tenantId_candidateId.candidateId) ?? null),
      findMany: jest.fn(async ({ where }: any) => [...submissions.values()].filter((row) => where.candidateId.in.includes(row.candidateId))),
      create: jest.fn(async ({ data }: any) => {
        if (submissions.has(data.candidateId)) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        submissions.set(data.candidateId, { ...data });
        return { ...data };
      }),
    },
    memoryCandidate: {
      findMany: jest.fn(async ({ where }: any) => [...candidates.values()].filter((row) => where.id.in.includes(row.id))),
    },
    clioMemory: {
      findFirst: jest.fn(async ({ where }: any) => memories.find((row) => Object.entries(where).every(([k, v]) => (row as any)[k] === v)) ?? null),
    },
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (candidates.has(values[0] as string)) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      inserts.push(values);
      candidates.set(values[0] as string, { id: values[0], status: 'pending', sourceKind: 'explicit_user', decidedAt: null, committedMemoryId: null, committedMemoryItemId: null, duplicateMemoryItemId: null });
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, clientId: string) => [{ allowed: clientId !== walledClient }]),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes('clio_meri_memory_submissions')) {
        const submission = submissions.get(values[1] as string), committed = candidates.get(values[1] as string);
        return submission && committed ? [{ logicalNull: submission.candidate.key === null, committedMemoryId: committed.committedMemoryId }] : [];
      }
      if (text.includes('WITH RECURSIVE')) {
        const lineage: ItemFixtureRow[] = [];
        let frontier = items.filter((row) => row.slug === values[1]);
        while (frontier.length) {
          lineage.push(...frontier);
          frontier = items.filter((row) => frontier.some((parent) => row.supersedesId === parent.id));
        }
        const active = lineage.filter((row) => row.status === 'active' && ['active', 'stale'].includes(row.governedStatus))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return active.slice(0, 1);
      }
      if (text.includes('AND id =')) return items.filter((row) => row.id === values[1]);
      if (text.includes('AND slug =')) return items.filter((row) => row.slug === values[1]);
      throw new Error(`unexpected raw query: ${text}`);
    }),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: unknown) => unknown) => fn(tx)),
    withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
  };
  const versions = {
    proposeReviewOnlyCorrection: jest.fn(async (_ctx: unknown, input: any, hooks: any) => {
      corrections.push({ input });
      const source = items.find((row) => row.id === input.sourceItemId);
      if (!source) throw new Error('not found');
      await hooks.verify?.(tx);
      if (source.status !== 'active' || !['active', 'stale', 'conflicted'].includes(source.governedStatus)) throw new ConflictException('not controlling');
      if (candidates.has(input.candidateId)) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      candidates.set(input.candidateId, { id: input.candidateId, status: 'pending', sourceKind: 'memory_correction', decidedAt: null, committedMemoryId: null, committedMemoryItemId: null, duplicateMemoryItemId: null });
      await hooks.record?.(tx);
      return { candidateId: input.candidateId };
    }),
  };
  return { service: new MeriMemoryReceivingService(prisma as never, versions as never), submissions, candidates, inserts, corrections, versions, tx };
}

describe('MeriMemoryReceivingService.submit (additions)', () => {
  it('stores a personal addition as a pending candidate (never inline-committed) and acknowledges it', async () => {
    const f = fixture();
    const body = submitBody();
    const ack = await f.service.submit(verifiedRequest(), ctx, body);
    expect(ack).toEqual({ candidateId, candidateSha256: body.candidateSha256, reviewId: expect.stringMatching(/^[0-9a-f-]{36}$/), accepted: true });
    expect(f.inserts).toHaveLength(1);
    const [id, tenant, proposer, scope, clientId, payload, provenance] = f.inserts[0]!;
    expect([id, tenant, proposer, scope, clientId]).toEqual([candidateId, tenantId, actorId, 'personal', null]);
    expect(JSON.parse(payload as string)).toMatchObject({ key: 'briefing-time', value: 'Prefers morning briefings', source: 'meri', scope: 'user_private', ownerUserId: actorId });
    expect(JSON.parse(provenance as string)).toMatchObject({ meriCandidateId: candidateId, meriCandidateSha256: body.candidateSha256, idempotencyKey: 'memory-1' });
    expect(f.candidates.get(candidateId)!.status).toBe('pending');
  });

  it('gives an unkeyed addition a stable synthetic key and derives expiry from ttlDays', async () => {
    const f = fixture();
    await f.service.submit(verifiedRequest(), ctx, submitBody(candidate({ key: null, ttlDays: 2 })));
    const payload = JSON.parse(f.inserts[0]![5] as string);
    expect(payload.key).toBe(`meri:${candidateId}`);
    expect(payload.expiresAt).toBe('2026-10-20T06:00:00.000Z');
  });

  it('answers an identical replay with the original acknowledgement and refuses a different hash', async () => {
    const f = fixture();
    const first = await f.service.submit(verifiedRequest(), ctx, submitBody());
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody())).resolves.toEqual(first);
    expect(f.inserts).toHaveLength(1);
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(candidate({ content: 'Changed' })))).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a hash that is not the candidate RFC 8785 SHA-256', async () => {
    const f = fixture();
    await expect(f.service.submit(verifiedRequest(), ctx, { candidate: candidate(), candidateSha256: 'a'.repeat(64) })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.inserts).toHaveLength(0);
  });

  it.each([
    ['unverified service identity', verifiedRequest(false), candidate()],
    ['foreign tenant', verifiedRequest(), candidate({ tenantId: '99999999-9999-4999-8999-999999999990' })],
    ['another proposer', verifiedRequest(), candidate({ proposerActorId: otherActor })],
    ['walled client', verifiedRequest(), candidate({ scope: 'client', clientId: walledClient })],
  ] as Array<[string, Request, Record<string, unknown>]>)('refuses %s', async (_label, req, c) => {
    const f = fixture();
    await expect(f.service.submit(req, ctx, submitBody(c))).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.inserts).toHaveLength(0);
  });

  it('accepts a client addition the actor may see', async () => {
    const f = fixture();
    await f.service.submit(verifiedRequest(), ctx, submitBody(candidate({ scope: 'client', clientId: openClient })));
    expect(f.inserts[0]![3]).toBe('client');
    expect(f.inserts[0]![4]).toBe(openClient);
  });

  it('refuses an addition whose key is already committed in that scope (a correction is required)', async () => {
    const f = fixture([personal]);
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody())).rejects.toBeInstanceOf(ConflictException);
    expect(f.inserts).toHaveLength(0);
  });

  it('refuses the reserved synthetic storage-key form as a logical key', async () => {
    const f = fixture();
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(candidate({ key: `meri:${candidateId}` })))).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['an unknown key', { ...candidate(), extra: true }],
    ['a missing key', (({ reason: _reason, ...rest }) => rest)(candidate())],
    ['untrimmed content', candidate({ content: ' padded' })],
    ['a non-https web source', candidate({ sources: [{ kind: 'web_page', reference: 'http://example.test/a', sha256: null, title: null }] })],
  ] as Array<[string, Record<string, unknown>]>)('refuses a candidate with %s', async (_label, c) => {
    const f = fixture();
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(c))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a concurrent first insert to the winner', async () => {
    const f = fixture();
    const body = submitBody();
    const winner = { tenantId, candidateId, candidateSha256: body.candidateSha256, proposerUserId: actorId, reviewId: '12121212-1212-4121-8121-121212121212' };
    f.tx.clioMeriMemorySubmission.findUnique
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => winner);
    f.candidates.set(candidateId, { id: candidateId, status: 'pending' });
    await expect(f.service.submit(verifiedRequest(), ctx, body)).resolves.toEqual({ candidateId, candidateSha256: body.candidateSha256, reviewId: winner.reviewId, accepted: true });
  });

  it('pins HTTP 200 on every Meri route', () => {
    for (const name of ['submit', 'status', 'readTarget', 'findByKey'] as const) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, MeriMemoryReceivingController.prototype[name])).toBe(200);
    }
  });
});

describe('MeriMemoryReceivingService.submit (corrections)', () => {
  async function pinOf(f: ReturnType<typeof fixture>, id: string) {
    return (await f.service.readTarget(verifiedRequest(), ctx, { memoryId: id })).memory!.memorySha256;
  }
  const correction = (corrects: { memoryId: string; memorySha256: string }, overrides: Record<string, unknown> = {}) =>
    candidate({ kind: 'correction', content: 'Evenings now', corrects, reason: 'Changed schedule', ...overrides });

  it('files a review-only immutable version candidate under the Meri id, pinned to the exact clio target', async () => {
    const f = fixture([personal], [projection()]);
    const pin = { memoryId: `clio:${memoryId}`, memorySha256: await pinOf(f, `clio:${memoryId}`) };
    const body = submitBody(correction(pin));
    const ack = await f.service.submit(verifiedRequest(), ctx, body);
    expect(ack).toMatchObject({ candidateId, candidateSha256: body.candidateSha256, accepted: true });
    expect(f.corrections[0]!.input).toMatchObject({ candidateId, sourceItemId: projectionId, newContent: 'Evenings now',
      provenance: { meriCandidateId: candidateId, corrects: pin, reason: 'Changed schedule' } });
    expect(f.inserts).toHaveLength(0); // never the generic addition owner
    expect(f.submissions.get(candidateId)).toBeDefined();
  });

  it('corrects a published version by its item id', async () => {
    const f = fixture([personal], [projection({ status: 'superseded', governedStatus: 'superseded' }), version()]);
    const pin = { memoryId: `item:${versionId}`, memorySha256: await pinOf(f, `item:${versionId}`) };
    await f.service.submit(verifiedRequest(), ctx, submitBody(correction(pin)));
    expect(f.corrections[0]!.input.sourceItemId).toBe(versionId);
  });

  it.each([
    ['a stale pin', (pin: string) => ({ memoryId: `clio:${memoryId}`, memorySha256: pin.replace(/^./, pin[0] === 'a' ? 'b' : 'a') })],
    ['a bare UUID (namespaces are never interchangeable)', (pin: string) => ({ memoryId, memorySha256: pin })],
    ['a superseded target', (pin: string) => ({ memoryId: `clio:${memoryId}`, memorySha256: pin })],
  ] as Array<[string, (pin: string) => { memoryId: string; memorySha256: string }]>)('refuses %s with 409 and records nothing', async (label, pinFor) => {
    const items = label === 'a superseded target' ? [projection({ status: 'superseded', governedStatus: 'superseded' }), version()] : [projection()];
    const pin = pinFor(await pinOf(fixture([personal], [projection()]), `clio:${memoryId}`));
    const f = fixture([personal], items);
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(correction(pin)))).rejects.toBeInstanceOf(ConflictException);
    expect(f.submissions.size).toBe(0);
  });

  it('refuses a correction whose scope differs from its target', async () => {
    const f = fixture([personal], [projection()]);
    const pin = { memoryId: `clio:${memoryId}`, memorySha256: await pinOf(f, `clio:${memoryId}`) };
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(correction(pin, { scope: 'firm' })))).rejects.toBeInstanceOf(ConflictException);
    expect(f.submissions.size).toBe(0);
  });

  it('refuses a clio target that has no governed version to correct yet', async () => {
    const f = fixture([personal], []);
    const pin = { memoryId: `clio:${memoryId}`, memorySha256: await pinOf(f, `clio:${memoryId}`) };
    await expect(f.service.submit(verifiedRequest(), ctx, submitBody(correction(pin)))).rejects.toBeInstanceOf(ConflictException);
    expect(f.versions.proposeReviewOnlyCorrection).not.toHaveBeenCalled();
  });
});

describe('MeriMemoryReceivingService.status', () => {
  it('answers each requested candidate once, proposer-only, hash-bound', async () => {
    const f = fixture();
    const body = submitBody();
    const { reviewId } = await f.service.submit(verifiedRequest(), ctx, body);
    const unknown = { candidateId: '13131313-1313-4131-8131-131313131313', candidateSha256: 'c'.repeat(64) };
    const page = await f.service.status(verifiedRequest(), ctx, { candidates: [{ candidateId, candidateSha256: body.candidateSha256 }, unknown] });
    expect(page.checkedAt).toMatch(/Z$/);
    expect(page.reviews).toEqual([
      { candidateId, candidateSha256: body.candidateSha256, status: 'pending', reviewId, decidedAt: null, publishedMemoryId: null },
      { ...unknown, status: 'not_found', reviewId: null, decidedAt: null, publishedMemoryId: null },
    ]);
    const mismatch = await f.service.status(verifiedRequest(), ctx, { candidates: [{ candidateId, candidateSha256: 'd'.repeat(64) }] });
    expect(mismatch.reviews[0]!.status).toBe('not_found');
    const other = await f.service.status(verifiedRequest(), { tenantId, userId: otherActor } as TenantContext, { candidates: [{ candidateId, candidateSha256: body.candidateSha256 }] });
    expect(other.reviews[0]!.status).toBe('not_found');
  });

  it('publishes an approved addition as its scoped clio id and reports rejection', async () => {
    const f = fixture();
    const body = submitBody();
    await f.service.submit(verifiedRequest(), ctx, body);
    const decidedAt = new Date('2026-10-18T07:00:00.000Z');
    f.candidates.set(candidateId, { ...f.candidates.get(candidateId), status: 'approved', decidedAt, committedMemoryId: memoryId });
    const approved = await f.service.status(verifiedRequest(), ctx, { candidates: [{ candidateId, candidateSha256: body.candidateSha256 }] });
    expect(approved.reviews[0]).toMatchObject({ status: 'approved', decidedAt: decidedAt.toISOString(), publishedMemoryId: `clio:${memoryId}` });
    f.candidates.set(candidateId, { ...f.candidates.get(candidateId), status: 'rejected', committedMemoryId: null });
    const rejected = await f.service.status(verifiedRequest(), ctx, { candidates: [{ candidateId, candidateSha256: body.candidateSha256 }] });
    expect(rejected.reviews[0]).toMatchObject({ status: 'rejected', decidedAt: decidedAt.toISOString(), publishedMemoryId: null });
  });

  it('publishes an approved correction as the immutable version it activated', async () => {
    const f = fixture([personal], [projection()]);
    const pin = { memoryId: `clio:${memoryId}`, memorySha256: (await f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${memoryId}` })).memory!.memorySha256 };
    const body = submitBody(candidate({ kind: 'correction', content: 'Evenings now', corrects: pin, reason: 'Changed' }));
    await f.service.submit(verifiedRequest(), ctx, body);
    f.candidates.set(candidateId, { ...f.candidates.get(candidateId), status: 'approved', decidedAt: new Date(), committedMemoryItemId: versionId });
    const page = await f.service.status(verifiedRequest(), ctx, { candidates: [{ candidateId, candidateSha256: body.candidateSha256 }] });
    expect(page.reviews[0]).toMatchObject({ status: 'approved', publishedMemoryId: `item:${versionId}` });
  });

  it('refuses duplicate or oversized status requests', async () => {
    const f = fixture();
    const pair = { candidateId, candidateSha256: 'e'.repeat(64) };
    await expect(f.service.status(verifiedRequest(), ctx, { candidates: [pair, pair] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.status(verifiedRequest(), ctx, { candidates: [] })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MeriMemoryReceivingService reads', () => {
  const walled: MemoryFixtureRow = { id: '14141414-1414-4141-8141-141414141414', tenantId, scope: 'client', ownerUserId: null, clientId: walledClient, key: 'contact', value: 'x', expiresAt: null, updatedAt };

  it('returns the exact clio target under its scoped id with a deterministic projection hash', async () => {
    const f = fixture([personal], [projection()]);
    const { memory } = await f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${memoryId}` });
    expect(memory).toEqual({
      tenantId, memoryId: `clio:${memoryId}`, scope: 'personal', clientId: null, ownerActorId: actorId, key: 'briefing-time', state: 'active',
      memorySha256: nativeCanonicalSha256({
        schema: 'capiro.clio-memory.v1', memoryId: `clio:${memoryId}`, scope: 'personal', clientId: null, ownerActorId: actorId,
        key: 'briefing-time', storageKey: 'briefing-time', state: 'active', value: 'Mornings', expiresAt: null, updatedAt: updatedAt.toISOString(),
      }),
    });
  });

  it('hides another actor personal memory, walled client memory, bare UUIDs and over-long keys', async () => {
    const long = { ...personal, id: '15151515-1515-4151-8151-151515151515', key: 'k'.repeat(121) };
    const f = fixture([personal, walled, long]);
    const other = { tenantId, userId: otherActor } as TenantContext;
    await expect(f.service.readTarget(verifiedRequest(), other, { memoryId: `clio:${memoryId}` })).resolves.toEqual({ memory: null });
    await expect(f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${walled.id}` })).resolves.toEqual({ memory: null });
    await expect(f.service.readTarget(verifiedRequest(), ctx, { memoryId })).resolves.toEqual({ memory: null });
    await expect(f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${long.id}` })).resolves.toEqual({ memory: null });
  });

  it('marks an expired memory expired and a corrected clio memory superseded', async () => {
    const expired = fixture([{ ...personal, expiresAt: new Date(Date.now() - 1000) }]);
    expect((await expired.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${memoryId}` })).memory!.state).toBe('expired');
    const corrected = fixture([personal], [projection({ status: 'superseded', governedStatus: 'superseded' }), version()]);
    expect((await corrected.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${memoryId}` })).memory!.state).toBe('superseded');
  });

  it('reads a published version under its item id', async () => {
    const f = fixture([personal], [projection({ status: 'superseded', governedStatus: 'superseded' }), version()]);
    const { memory } = await f.service.readTarget(verifiedRequest(), ctx, { memoryId: `item:${versionId}` });
    expect(memory).toMatchObject({ memoryId: `item:${versionId}`, scope: 'personal', ownerActorId: actorId, key: 'briefing-time', state: 'active' });
    expect(memory!.memorySha256).toBe(nativeCanonicalSha256({
      schema: 'capiro.memory-item.v1', memoryId: `item:${versionId}`, scope: 'personal', clientId: null, ownerActorId: actorId,
      key: 'briefing-time', storageKey: 'briefing-time', state: 'active', value: 'Evenings', expiresAt: null, updatedAt: updatedAt.toISOString(),
    }));
    const other = { tenantId, userId: otherActor } as TenantContext;
    await expect(f.service.readTarget(verifiedRequest(), other, { memoryId: `item:${versionId}` })).resolves.toEqual({ memory: null });
  });

  it('reports a memory committed from an unkeyed Meri addition with its logical null key', async () => {
    const synthetic: MemoryFixtureRow = { ...personal, id: '16161616-1616-4161-8161-161616161616', key: `meri:${candidateId}` };
    const f = fixture([synthetic]);
    await f.service.submit(verifiedRequest(), ctx, submitBody(candidate({ key: null })));
    f.candidates.set(candidateId, { ...f.candidates.get(candidateId), status: 'approved', decidedAt: new Date(), committedMemoryId: synthetic.id });
    const { memory } = await f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${synthetic.id}` });
    expect(memory).toMatchObject({ memoryId: `clio:${synthetic.id}`, key: null });
    await expect(f.service.findByKey(verifiedRequest(), ctx, { scope: 'personal', clientId: null, key: `meri:${candidateId}` }))
      .resolves.toEqual({ memory: null });
    // Without the Meri lineage the same storage key stays the logical key.
    f.candidates.set(candidateId, { ...f.candidates.get(candidateId), committedMemoryId: memoryId });
    expect((await f.service.readTarget(verifiedRequest(), ctx, { memoryId: `clio:${synthetic.id}` })).memory!.key).toBe(`meri:${candidateId}`);
  });

  it('finds by key the clio memory, or the controlling version that corrected it', async () => {
    const plain = fixture([personal, walled], [projection()]);
    expect((await plain.service.findByKey(verifiedRequest(), ctx, { scope: 'personal', clientId: null, key: 'briefing-time' })).memory!.memoryId).toBe(`clio:${memoryId}`);
    await expect(plain.service.findByKey(verifiedRequest(), ctx, { scope: 'client', clientId: walledClient, key: 'contact' })).resolves.toEqual({ memory: null });
    await expect(plain.service.findByKey(verifiedRequest(), ctx, { scope: 'firm', clientId: openClient, key: 'contact' })).rejects.toBeInstanceOf(BadRequestException);
    const corrected = fixture([personal], [projection({ status: 'superseded', governedStatus: 'superseded' }), version()]);
    const found = (await corrected.service.findByKey(verifiedRequest(), ctx, { scope: 'personal', clientId: null, key: 'briefing-time' })).memory;
    expect(found).toMatchObject({ memoryId: `item:${versionId}`, state: 'active' });
  });

  it('refuses reads without the verified service identity', async () => {
    const f = fixture([personal]);
    await expect(f.service.readTarget(verifiedRequest(false), ctx, { memoryId: `clio:${memoryId}` })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.findByKey(verifiedRequest(false), ctx, { scope: 'personal', clientId: null, key: 'briefing-time' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
