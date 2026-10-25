import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { nativeCanonicalSha256, parseApprovalDecisionInput, parseApprovalRevokeInput } from './native-approval.contract.js';
import { NativeApprovalService } from './native-approval.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const binding = {
  tenantId, actorId,
  conversationId: '44444444-4444-4444-8444-444444444444', runId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666', workerId: '77777777-7777-4777-8777-777777777777',
  writerFence: 3,
};
const scope = (policyRevision = 'policy-r1') => ({ tenantId, kind: 'client', resourceId: otherActor, policyRevision });
function command(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '0.1.0', commandId: '88888888-8888-4888-8888-888888888888', binding,
    action: 'task.create', arguments: { title: 'Call the delegation', clientId: null, dueDate: null }, attachments: [],
    scopes: [scope()], idempotencyKey: 'intent-1', ...overrides,
  };
}
function proposal(overrides: Record<string, unknown> = {}, commandOverrides: Record<string, unknown> = {}) {
  const c = command(commandOverrides);
  const now = Date.now();
  return {
    proposalId: '99999999-9999-4999-8999-999999999999', command: c, commandSha256: nativeCanonicalSha256(c),
    createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    requiredApprover: { tenantId, actorId }, ...overrides,
  };
}
const ctx = { tenantId, userId: actorId } as TenantContext;
const SECRET = 'synthetic-service-secret';

function verifiedRequest(verified = true): Request {
  const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
  const guard = new ToolServiceSecretGuard({
    get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false),
  } as never);
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}

function fixture(options: { metadata?: 'ok' | 'unavailable' | 'mismatch'; raceOnCreate?: boolean } = {}) {
  const rows = new Map<string, any>();
  const revocations = new Map<string, any>();
  const key = (where: any) => `${where.tenantId_proposalId.tenantId}:${where.tenantId_proposalId.proposalId}`;
  const create = jest.fn(async ({ data }: any) => {
    if (options.raceOnCreate && !rows.has(`${data.tenantId}:${data.proposalId}`)) {
      rows.set(`${data.tenantId}:${data.proposalId}`, { ...data, decision: 'rejected' });
      throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
    }
    rows.set(`${data.tenantId}:${data.proposalId}`, { ...data });
    return { ...data };
  });
  const tx = {
    clioMeriApprovalDecision: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(key(where)) ?? null),
      create,
    },
    clioMeriApprovalRevocation: {
      findUnique: jest.fn(async ({ where }: any) => revocations.get(key(where)) ?? null),
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        expect(skipDuplicates).toBe(true);
        for (const row of data) {
          const id = `${row.tenantId}:${row.proposalId}`;
          if (!revocations.has(id)) revocations.set(id, { ...row });
        }
        return { count: data.length };
      }),
    },
    $queryRaw: jest.fn(async () => [{ locked: '' }]),
  };
  const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const metadata = { verify: jest.fn(async () => {
    if (options.metadata === 'unavailable') throw new ServiceUnavailableException();
    if (options.metadata === 'mismatch') throw new ConflictException();
  }) };
  const current = { read: jest.fn(async (_ctx: unknown, _req: unknown, input: any) => ({
    principal: { tenantId, actorId }, conversationId: binding.conversationId,
    selectedClientId: input.clientId, expiresAtMs: Date.now() + 60_000,
  })) };
  const service = new NativeApprovalService(prisma as never, metadata as never, current as never);
  return {
    service, rows, revocations, create, tx,
    record: (body: { proposal: ReturnType<typeof proposal>; decision: string; approver?: unknown; binding?: unknown }, req = verifiedRequest()) => {
      return service.record(req, ctx, { approver: { tenantId, actorId }, binding, ...body });
    },
  };
}

describe('P-INT-10 approval/record', () => {
  it('records one immutable decision and answers the provider receipt shape', async () => {
    const f = fixture();
    const p = proposal();
    const before = Date.now();
    const receipt = await f.record({ proposal: p, decision: 'approved' });
    expect(Object.keys(receipt).sort()).toEqual(['checkedAtMs', 'decision', 'revoked']);
    expect(receipt.revoked).toBe(false);
    expect(receipt.checkedAtMs).toBeGreaterThanOrEqual(before);
    expect(receipt.decision).toEqual({
      proposalId: p.proposalId, commandSha256: p.commandSha256, decision: 'approved',
      decidedAt: expect.any(String), expiresAt: new Date(Date.parse(p.expiresAt)).toISOString(),
      approver: { tenantId, actorId }, policyRevision: 'policy-r1',
    });
    const decidedAt = Date.parse(receipt.decision!.decidedAt);
    expect(receipt.decision!.decidedAt).toBe(new Date(decidedAt).toISOString());
    expect(decidedAt).toBeGreaterThanOrEqual(Date.parse(p.createdAt));
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('answers a repeat with the stored decision and never flips it', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'rejected' });
    const again = await f.record({ proposal: p, decision: 'approved' });
    expect(again.decision!.decision).toBe('rejected');
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('answers the concurrent winner after a primary-key race', async () => {
    const f = fixture({ raceOnCreate: true });
    const receipt = await f.record({ proposal: proposal(), decision: 'approved' });
    expect(receipt.decision!.decision).toBe('rejected');
  });

  it('refuses a second command under an already decided proposal id', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'approved' });
    const other = proposal({}, { idempotencyKey: 'intent-2' });
    await expect(f.record({ proposal: other, decision: 'approved' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires a verified service identity', async () => {
    const f = fixture();
    await expect(f.record({ proposal: proposal(), decision: 'approved' }, verifiedRequest(false)))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the authenticated user to be the approver, the required approver and the conversation owner', async () => {
    const f = fixture();
    await expect(f.record({ proposal: proposal(), decision: 'approved', approver: { tenantId, actorId: otherActor } }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.record({ proposal: proposal({ requiredApprover: { tenantId, actorId: otherActor } }), decision: 'approved' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    const foreign = { ...binding, actorId: otherActor };
    await expect(f.record({ proposal: proposal({}, { binding: foreign }), decision: 'approved', binding: foreign }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('refuses a binding that differs from the proposal command binding', async () => {
    const f = fixture();
    await expect(f.record({ proposal: proposal(), decision: 'approved', binding: { ...binding, runId: otherActor } }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a tampered command, unsupported action, expiry and split policy revisions', async () => {
    const f = fixture();
    const tampered = proposal();
    (tampered.command.arguments as Record<string, unknown>).title = 'changed after hashing';
    await expect(f.record({ proposal: tampered, decision: 'approved' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.record({ proposal: proposal({}, { action: 'memory.propose' }), decision: 'approved' }))
      .rejects.toBeInstanceOf(ConflictException);
    const expired = proposal({ createdAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(f.record({ proposal: expired, decision: 'approved' })).rejects.toBeInstanceOf(ConflictException);
    await expect(f.record({ proposal: proposal({}, { scopes: [scope('policy-r1'), { ...scope('policy-r2'), resourceId: 'client-2' }] }), decision: 'approved' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('refuses non-canonical shapes', async () => {
    const f = fixture();
    await expect(f.service.record(verifiedRequest(), ctx, { proposal: proposal(), decision: 'approved', approver: { tenantId, actorId }, binding, extra: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(f.record({ proposal: proposal({ proposalId: '99999999-9999-4999-8999-99999999999A' }), decision: 'approved' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(f.record({ proposal: proposal(), decision: 'maybe' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when Meri approval metadata is unavailable or differs', async () => {
    await expect(fixture({ metadata: 'unavailable' }).record({ proposal: proposal(), decision: 'approved' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    const mismatch = fixture({ metadata: 'mismatch' });
    await expect(mismatch.record({ proposal: proposal(), decision: 'approved' })).rejects.toBeInstanceOf(ConflictException);
    expect(mismatch.create).not.toHaveBeenCalled();
  });
});

describe('P-INT-10 approval/decision', () => {
  it('answers the stored decision for the same run and null otherwise', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'approved' });
    const read = (body: Record<string, unknown>) => f.service.decision(verifiedRequest(), ctx, body);
    // A fresh executor attempt/worker/fence on the same run reads the decision.
    const fresh = { ...binding, attemptId: otherActor, workerId: otherActor, writerFence: 9 };
    const found = await read({ proposalId: p.proposalId, commandSha256: p.commandSha256, binding: fresh });
    expect(found.decision?.decision).toBe('approved');
    expect(found.revoked).toBe(false);
    expect((await read({ proposalId: p.proposalId, commandSha256: '0'.repeat(64), binding })).decision).toBeNull();
    expect((await read({ proposalId: p.proposalId, commandSha256: p.commandSha256, binding: { ...binding, runId: otherActor } })).decision).toBeNull();
    expect((await read({ proposalId: otherActor, commandSha256: p.commandSha256, binding })).decision).toBeNull();
  });

  it('requires service identity and the authenticated binding owner', async () => {
    const f = fixture();
    const p = proposal();
    await expect(f.service.decision(verifiedRequest(false), ctx, { proposalId: p.proposalId, commandSha256: p.commandSha256, binding }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.decision(verifiedRequest(), ctx, { proposalId: p.proposalId, commandSha256: p.commandSha256, binding: { ...binding, actorId: otherActor } }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('P-INT-10 approval/revoke', () => {
  const body = (p: ReturnType<typeof proposal>) => ({
    proposalId: p.proposalId, commandSha256: p.commandSha256,
    approver: { tenantId, actorId }, binding,
  });

  it('accepts Meri RD\'s exact four-field revoke body while decision remains three-field', () => {
    const p = proposal();
    const revoke = body(p);
    expect(parseApprovalRevokeInput(revoke)).toEqual(revoke);
    const decision = { proposalId: p.proposalId, commandSha256: p.commandSha256, binding };
    expect(parseApprovalDecisionInput(decision)).toEqual(decision);
    expect(() => parseApprovalDecisionInput(revoke)).toThrow(BadRequestException);
  });

  it('requires the approver and a closed, valid revoke body', () => {
    const revoke = body(proposal());
    expect(() => parseApprovalRevokeInput({ proposalId: revoke.proposalId, commandSha256: revoke.commandSha256, binding }))
      .toThrow(BadRequestException);
    expect(() => parseApprovalRevokeInput({ ...revoke, extra: true })).toThrow(BadRequestException);
    expect(() => parseApprovalRevokeInput({ ...revoke, approver: { ...revoke.approver, actorId: `A${otherActor.slice(1)}` } }))
      .toThrow(BadRequestException);
    expect(() => parseApprovalRevokeInput({ ...revoke, commandSha256: 'not-a-hash' })).toThrow(BadRequestException);
  });

  it('records one append-only revocation by the authenticated approver and answers repeat calls', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'approved' });
    const revoke = body(p);
    const first = await f.service.revoke(verifiedRequest(), ctx, revoke);
    expect(first).toMatchObject({ revoked: true, decision: { proposalId: p.proposalId, decision: 'approved' } });
    expect(await f.service.revoke(verifiedRequest(), ctx, revoke)).toMatchObject({ revoked: true });
    expect(f.revocations.size).toBe(1);
    expect([...f.revocations.values()][0]).toMatchObject({
      tenantId, proposalId: p.proposalId, commandSha256: p.commandSha256,
      revokedByUserId: actorId, reason: 'approver_revoked',
    });
    expect(await f.service.decision(verifiedRequest(), ctx, {
      proposalId: p.proposalId, commandSha256: p.commandSha256, binding,
    })).toMatchObject({ revoked: true });
  });

  it('refuses an unverified service or an approver other than the authenticated actor', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'approved' });
    const revoke = body(p);
    await expect(f.service.revoke(verifiedRequest(false), ctx, revoke)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.revoke(verifiedRequest(), ctx, { ...revoke, approver: { tenantId, actorId: otherActor } }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.revoke(verifiedRequest(), ctx, { ...revoke, binding: { ...binding, actorId: otherActor } }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.revoke(verifiedRequest(), { ...ctx, userId: otherActor }, revoke))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.tx.clioMeriApprovalRevocation.createMany).not.toHaveBeenCalled();
  });

  it('requires the stored decision to match before writing a revocation', async () => {
    const f = fixture();
    const p = proposal();
    await f.record({ proposal: p, decision: 'approved' });
    await expect(f.service.revoke(verifiedRequest(), ctx, { ...body(p), commandSha256: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.clioMeriApprovalRevocation.createMany).not.toHaveBeenCalled();
  });
});
