import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import {
  BROWSER_RECEIPT_SCHEMA,
  BROWSER_STATUS_SCHEMA,
  assertBrowserReadback,
  browserConsumptionId,
  browserConsumptionKey,
  browserProposalId,
  nativeCanonicalSha256,
} from './native-approval.contract.js';
import { NativeApprovalService } from './native-approval.service.js';

/**
 * SCRUM-222 browser consequential-action approvals — the Core seam only.
 *
 * INERT FIXTURES: no database, network, browser, MCP call, provider or human.
 * The readback fixture is shaped exactly like Meri Parent10's
 * `createApprovalMetadataReadback` answer (da3013631f) and the admission
 * snapshot exactly like `meri_core_authority.current_admission_v1`. They prove
 * Core's parsing, four independent digests, authorization, one-time claim and
 * settlement — NOT a live joined, attended or deployed journey.
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const conversationId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const attemptId = '77777777-7777-4777-8777-777777777777';
const workerId = '88888888-8888-4888-8888-888888888888';
const WORKER_ARN = 'arn:aws:ecs:us-east-1:967807252336:task/capiro-meri/0123456789abcdef0123456789abcdef';
const POLICY_REVISION = 'policy-rev-2026-10-30';
const BROWSER_POLICY = 'b'.repeat(64);
const TOOL_USE_ID = 'toolu_01ABC';
const INPUT = { selector: '#approve-order', text: 'Place order 4821' };
const binding = { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 3 };
const ctx = { tenantId, userId: actorId } as TenantContext;
const scopes = [{ tenantId, kind: 'client', resourceId: clientId, policyRevision: POLICY_REVISION }];
const SECRET = 'synthetic-service-secret';

function verifiedRequest(verified = true): Request {
  const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
  const guard = new ToolServiceSecretGuard({
    get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false),
  } as never);
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}

function subject(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'meri-browser-action/1', binding,
    server: 'capiro-browser', tool: 'browser_click', toolUseId: TOOL_USE_ID,
    inputSha256: nativeCanonicalSha256(INPUT), pageOrigin: 'https://client.example.com',
    policySha256: BROWSER_POLICY, ...overrides,
  };
}

function preparation(overrides: Record<string, unknown> = {}, subjectOverrides: Record<string, unknown> = {}, now = Date.now()) {
  const s = subject(subjectOverrides);
  return {
    schema: 'meri-browser-approval-preparation/1', subject: s, subjectSha256: nativeCanonicalSha256(s),
    input: INPUT, requestedAtMs: now - 1_000, expiresAtMs: now + 60_000, ...overrides,
  };
}

const proposalId = () => browserProposalId(binding, TOOL_USE_ID);
const subjectSha256 = () => nativeCanonicalSha256(subject());
const expectedReadback = () => ({ proposalId: proposalId(), binding, subjectSha256: subjectSha256() });

/** Exactly Meri Parent10's readback answer for one browser preparation. */
function readback(options: { preparation?: Record<string, unknown>; scopes?: unknown[]; policyRevision?: string; state?: string } = {}) {
  const request = options.preparation ?? preparation();
  const s = (request as any).subject;
  const recordScopes = options.scopes ?? scopes;
  const command = {
    contractVersion: '0.1.0',
    commandId: '99999999-9999-4999-8999-999999999999',
    binding,
    action: 'browser.action',
    arguments: {
      subject: s, subjectSha256: (request as any).subjectSha256, input: (request as any).input,
      requestedAtMs: (request as any).requestedAtMs, expiresAtMs: (request as any).expiresAtMs,
    },
    attachments: [],
    scopes: recordScopes,
    idempotencyKey: 'browser-1',
  };
  const commandSha256 = nativeCanonicalSha256(command);
  return {
    schemaVersion: 1,
    commandSha256,
    metadata: {
      record: {
        operation: { id: 'browser_action', version: '0.2.0' },
        action: 'browser.action',
        binding,
        request,
        inputSha256: nativeCanonicalSha256({ arguments: command.arguments, attachments: [] }),
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        proposalId: browserProposalId(binding, s.toolUseId),
        scopes: recordScopes,
        createdAt: new Date((request as any).requestedAtMs).toISOString(),
        expiresAt: new Date((request as any).expiresAtMs + 60_000).toISOString(),
        requiredApprover: { tenantId, actorId },
      },
      commandContext: { binding, scopes: recordScopes, requiredApprover: { tenantId, actorId } },
      commandSha256,
    },
    // Meri validates the frozen FULL Run and returns it unchanged: the required
    // envelope includes createdAt and versions (schema, additionalProperties false).
    run: {
      binding,
      state: options.state ?? 'waiting-for-approval',
      scopes: recordScopes,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      policyRevision: options.policyRevision ?? POLICY_REVISION,
      versions: {
        imageDigest: `sha256:${'a'.repeat(64)}`, sdk: '0.1.0', cli: '0.1.0',
        contracts: '0.1.0', skillsDigest: 'b'.repeat(64), checkpointFormat: '0.1.0',
      },
    },
  };
}

/** Exactly `meri_core_authority.current_admission_v1`'s snapshot for this run. */
function admissionSnapshot(runOverrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const allocation = {
    run: { tenantId, actorId, conversationId, runId },
    schedule: { revision: POLICY_REVISION, operations: [], expiresAt: new Date(now + 3_600_000).toISOString() },
    budgets: { maxTurns: 20, maxToolCalls: 30, maxRecoveryAttempts: 2, maxRuntimeSeconds: 900, maxCostMicroUSD: 2_000_000, maxOutputBytes: 1_000_000 },
  };
  const allocationSha256 = nativeCanonicalSha256(allocation);
  const grantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facts = {
    grantId, binding, allocationSha256, capabilitySha256: 'c'.repeat(64),
    qualificationBinding: { runId, attempt: 1, workerArn: WORKER_ARN, fence: binding.writerFence, policyRevision: POLICY_REVISION },
  };
  return {
    contract: 'capiro.meri-core-admission-snapshot.v1',
    budgetPresent: true,
    quarantined: false,
    dbNowMs: now,
    admitted: { state: 'ADMITTED', binding, allocationSha256, grantFactsJsons: [JSON.stringify(facts)] },
    run: { runId, attempt: 1, workerArn: WORKER_ARN, fence: binding.writerFence, policyRevision: POLICY_REVISION, ...runOverrides },
    allocation: { allocation, allocationSha256, startedAtMs: now - 5_000 },
    grants: [{
      grantId, runId, attempt: 1, workerArn: WORKER_ARN, fence: binding.writerFence, policyRevision: POLICY_REVISION,
      capabilitySha256: 'c'.repeat(64), expiresAtMs: now + 600_000, state: 'ACTIVE',
      boundGrantId: grantId, boundRunId: runId, facts,
    }],
  };
}

function fixture(options: { readback?: unknown; readbackFails?: boolean; snapshot?: unknown; clockSkewMs?: number } = {}) {
  let lastPrepared: ReturnType<typeof assertBrowserReadback> | null = null;
  const decisions = new Map<string, any>();
  const revocations = new Map<string, any>();
  const consumptions = new Map<string, any>();
  const decisionKey = (where: any) => `${where.tenantId_proposalId.tenantId}:${where.tenantId_proposalId.proposalId}`;
  const consumptionKey = (where: any) => {
    const k = where.tenantId_proposalId_idempotencyKey;
    return `${k.tenantId}:${k.proposalId}:${k.idempotencyKey}`;
  };
  const createDecision = jest.fn(async ({ data }: any) => {
    decisions.set(`${data.tenantId}:${data.proposalId}`, { ...data });
    return { ...data };
  });
  const createConsumption = jest.fn(async ({ data }: any) => {
    const row = { ...data, claimedAt: data.claimedAt ?? new Date(), state: 'CLAIMED', result: null, completedAt: null };
    consumptions.set(`${data.tenantId}:${data.proposalId}:${data.idempotencyKey}`, row);
    return row;
  });
  // The settlement update spreads the flat key, exactly as the service writes it.
  const updateMany = jest.fn(async ({ where, data }: any) => {
    const row = consumptions.get(`${where.tenantId}:${where.proposalId}:${where.idempotencyKey}`);
    if (!row || row.state !== where.state) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const tx = {
    clioMeriApprovalDecision: { findUnique: jest.fn(async ({ where }: any) => decisions.get(decisionKey(where)) ?? null), create: createDecision },
    clioMeriApprovalRevocation: { findUnique: jest.fn(async ({ where }: any) => revocations.get(decisionKey(where)) ?? null) },
    // The canonical admission reader checks that undeclared grants are Core-issued
    // execution capabilities; this run has none beyond the declared grant.
    clioMeriExecutionIssuance: { findMany: jest.fn(async () => []) },
    clioMeriExecutionConsumption: {
      findUnique: jest.fn(async ({ where }: any) => consumptions.get(consumptionKey(where)) ?? null),
      create: createConsumption, updateMany,
    },
    $queryRaw: jest.fn(async (strings: any) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings?.raw?.join('?') ?? strings);
      if (sql.includes('current_admission_v1')) return [{ snapshot: options.snapshot ?? admissionSnapshot() }];
      if (sql.includes('clock_timestamp')) return [{ db_now: new Date(Date.now() + (options.clockSkewMs ?? 0)) }];
      return [{ locked: '' }];
    }),
  };
  const prisma = { withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const metadata = {
    verify: jest.fn(async () => undefined),
    // Mirrors NativeApprovalMetadataVerifier.verifyBrowser: a malformed or
    // substituted preparation is a Conflict, an unavailable owner a 503.
    verifyBrowser: jest.fn(async (request: any) => {
      if (options.readbackFails) throw new ServiceUnavailableException('Approval metadata unavailable');
      try {
        lastPrepared = assertBrowserReadback(options.readback ?? readback(), request);
        return lastPrepared;
      } catch {
        throw new ConflictException('Approval proposal does not match its prepared record');
      }
    }),
  };
  const current = {
    read: jest.fn(async (_ctx: unknown, _req: unknown, input: any) => ({
      principal: { tenantId, actorId }, conversationId: input.conversationId,
      selectedClientId: input.clientId, expiresAtMs: Date.now() + 60_000,
    })),
  };
  const service = new NativeApprovalService(prisma as never, metadata as never, current as never);
  return {
    service, decisions, revocations, consumptions, createDecision, createConsumption, updateMany, tx, metadata,
    // The preparation the service actually verified on the last call.
    prepared: () => lastPrepared!,
    record: (body: Record<string, unknown> = {}, req = verifiedRequest()) => service.recordBrowser(req, ctx,
      { proposalId: proposalId(), subjectSha256: subjectSha256(), decision: 'approved', approver: { tenantId, actorId }, binding, ...body }),
    consume: (req = verifiedRequest()) => service.consumeBrowser(req, ctx, { proposalId: proposalId(), subjectSha256: subjectSha256(), binding }),
    status: () => service.statusBrowser(verifiedRequest(), ctx, { proposalId: proposalId(), subjectSha256: subjectSha256(), binding }),
    settle: (outcome: 'ok' | 'error' = 'ok', result: Record<string, unknown> = { action: 'click', atMs: 7 }) =>
      service.resultBrowser(verifiedRequest(), ctx, { proposalId: proposalId(), subjectSha256: subjectSha256(), binding, outcome, result }),
  };
}

describe('SCRUM-222 readback contract (Parent10 fixture, four independent digests)', () => {
  it('accepts the exact Parent10 answer and keeps C, A, S and I distinct', () => {
    const raw = readback();
    const prepared = assertBrowserReadback(raw, expectedReadback());
    const four = new Set([
      raw.commandSha256,
      (raw.metadata.record as any).inputSha256,
      prepared.preparation.subjectSha256,
      (raw.metadata.record as any).request.subject.inputSha256,
    ]);
    expect(four.size).toBe(4);
    expect(prepared.record.proposalId).toBe(proposalId());
    expect(prepared.run.policyRevision).toBe(POLICY_REVISION);
    expect(prepared.preparation.subject.binding).toEqual(binding);
  });

  it('refuses a substituted subject, input, window, origin or policy', () => {
    const cases = [
      readback({ preparation: preparation({}, { server: 'other-browser' }) }),
      readback({ preparation: preparation({}, { pageOrigin: 'https://client.example.com/orders' }) }),
      readback({ preparation: preparation({}, { pageOrigin: 'file:///tmp/x' }) }),
      readback({ preparation: preparation({}, { policySha256: 'd'.repeat(64) }) }),
      readback({ preparation: preparation({ input: { ...INPUT, text: 'changed after approval' } }) }),
      readback({ preparation: preparation({ requestedAtMs: Date.now() + 5_000, expiresAtMs: Date.now() + 1_000 }) }),
    ];
    for (const raw of cases) expect(() => assertBrowserReadback(raw, expectedReadback())).toThrow();
  });

  it('refuses a substituted envelope identity, operation version, action, run facts or context', () => {
    const mutate = (fn: (raw: any) => void) => { const copy = JSON.parse(JSON.stringify(readback())); fn(copy); return copy; };
    const bad = [
      mutate((r) => { r.metadata.record.commandSha256 = 'e'.repeat(64); }),
      mutate((r) => { r.metadata.record.inputSha256 = 'e'.repeat(64); }),
      mutate((r) => { r.commandSha256 = 'e'.repeat(64); }),
      mutate((r) => { r.metadata.commandSha256 = 'e'.repeat(64); }),
      mutate((r) => { r.metadata.record.operation.version = '0.1.0'; }),
      mutate((r) => { r.metadata.record.operation.id = 'browser-action'; }),
      mutate((r) => { r.metadata.record.action = 'task.create'; }),
      mutate((r) => { r.run.binding = { ...binding, attemptId: otherActor }; }),
      mutate((r) => { r.run.binding = { ...binding, workerId: otherActor }; }),
      mutate((r) => { r.run.binding = { ...binding, writerFence: 4 }; }),
      mutate((r) => { r.run.policyRevision = 'other-revision'; }),
      mutate((r) => { r.run.state = 'failed'; }),
      mutate((r) => { r.metadata.record.requiredApprover = { tenantId, actorId: otherActor }; }),
      mutate((r) => { r.metadata.commandContext.scopes = []; }),
      mutate((r) => { r.metadata.record.scopes = [{ ...scopes[0], kind: 'tenant' }]; }),
      mutate((r) => { delete r.run; }),
      mutate((r) => { r.extra = 1; }),
      mutate((r) => { r.metadata.record.request.schema = 'meri-browser-approval-request/3'; }),
    ];
    for (const raw of bad) expect(() => assertBrowserReadback(raw, expectedReadback())).toThrow();
  });

  it('refuses a readback for another proposal, another binding or another subject digest', () => {
    expect(() => assertBrowserReadback(readback(), { ...expectedReadback(), proposalId: otherActor })).toThrow();
    expect(() => assertBrowserReadback(readback(), { ...expectedReadback(), subjectSha256: 'f'.repeat(64) })).toThrow();
    expect(() => assertBrowserReadback(readback(), { ...expectedReadback(), binding: { ...binding, runId: otherActor } })).toThrow();
  });
});

describe('SCRUM-222 browser record', () => {
  it('records one immutable decision whose commandSha256 is ONLY the subject digest', async () => {
    const f = fixture();
    const receipt = await f.record();
    expect(Object.keys(receipt).sort()).toEqual(['checkedAtMs', 'decision', 'revoked']);
    expect(receipt.decision!.commandSha256).toBe(subjectSha256());
    expect(receipt.decision!.commandSha256).not.toBe((readback() as any).commandSha256);
    expect(receipt.decision!.policyRevision).toBe(POLICY_REVISION);
    expect(receipt.decision!.policyRevision).not.toBe(BROWSER_POLICY);
    expect(f.createDecision).toHaveBeenCalledTimes(1);
    expect(f.metadata.verifyBrowser).toHaveBeenCalledWith({ proposalId: proposalId(), binding, subjectSha256: subjectSha256() });
    expect([...f.decisions.values()][0]).toMatchObject({
      commandSha256: subjectSha256(), conversationId, runId, policyRevision: POLICY_REVISION, approverUserId: actorId,
    });
  });

  it('answers a repeat with the stored decision and refuses another subject on the same proposal', async () => {
    const f = fixture();
    await f.record({ decision: 'rejected' });
    expect((await f.record({ decision: 'approved' })).decision!.decision).toBe('rejected');
    expect(f.createDecision).toHaveBeenCalledTimes(1);
    await expect(f.record({ subjectSha256: 'a'.repeat(64) })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses absent, unavailable or substituted preparation BEFORE any decision write', async () => {
    const unavailable = fixture({ readbackFails: true });
    await expect(unavailable.record()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(unavailable.createDecision).not.toHaveBeenCalled();
    const substituted = fixture({ readback: readback({ preparation: preparation({}, { tool: 'browser_type' }) }) });
    await expect(substituted.record()).rejects.toBeInstanceOf(ConflictException);
    expect(substituted.createDecision).not.toHaveBeenCalled();
  });

  it('refuses a foreign approver, a foreign actor, a wrong binding and an unverified service', async () => {
    const f = fixture();
    await expect(f.record({ approver: { tenantId, actorId: otherActor } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.record({}, verifiedRequest(false))).rejects.toBeInstanceOf(ForbiddenException);
    // The retained preparation is bound to the original actor, so the readback
    // identity check refuses a foreign binding before any effect.
    await expect(f.service.recordBrowser(verifiedRequest(), { tenantId, userId: otherActor } as TenantContext,
      { proposalId: proposalId(), subjectSha256: subjectSha256(), decision: 'approved', approver: { tenantId, actorId: otherActor }, binding: { ...binding, actorId: otherActor } }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(f.record({ binding: { ...binding, runId: otherActor } })).rejects.toBeInstanceOf(ConflictException);
    expect(f.createDecision).not.toHaveBeenCalled();
  });

  it('refuses an expired request and a current admission that moved', async () => {
    const past = Date.now() - 120_000;
    const expired = fixture({ readback: readback({ preparation: preparation({ requestedAtMs: past - 60_000, expiresAtMs: past }) }) });
    await expect(expired.record()).rejects.toBeInstanceOf(ConflictException);
    for (const moved of [
      admissionSnapshot({ attempt: 2 }),
      admissionSnapshot({ workerArn: WORKER_ARN.replace('0123456789abcdef', 'fedcba9876543210') }),
      admissionSnapshot({ fence: 4 }),
      admissionSnapshot({ policyRevision: 'moved-revision' }),
    ]) {
      const f = fixture({ snapshot: moved });
      await expect(f.record()).rejects.toBeInstanceOf(ConflictException);
      expect(f.createDecision).not.toHaveBeenCalled();
    }
  });
});

describe('SCRUM-222 browser consume, status and settlement', () => {
  async function approved(options: Parameters<typeof fixture>[0] = {}) {
    const f = fixture(options);
    await f.record();
    return f;
  }

  it('grants exactly ONE permissive receipt, for the fresh CLAIMED insert only', async () => {
    const f = await approved();
    const first = (await f.consume()) as any;
    expect(first.schema).toBe(BROWSER_RECEIPT_SCHEMA);
    expect(Object.keys(first).sort()).toEqual(['consumption', 'decision', 'proposalId', 'schema', 'subjectSha256', 'toolUseId']);
    expect(first.proposalId).toBe(proposalId());
    expect(first.toolUseId).toBe(TOOL_USE_ID);
    expect(first.subjectSha256).toBe(subjectSha256());
    expect(first.decision.commandSha256).toBe(subjectSha256());
    expect(first.consumption).toEqual({
      consumed: true,
      consumptionId: browserConsumptionId(tenantId, proposalId(), TOOL_USE_ID),
      consumedAtMs: expect.any(Number),
    });
    expect(first.consumption.consumptionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.consumption.consumedAtMs).toBeGreaterThanOrEqual(Date.parse(first.decision.decidedAt));
    expect(f.createConsumption).toHaveBeenCalledTimes(1);
    expect([...f.consumptions.values()][0]).toMatchObject({
      tenantId, proposalId: proposalId(), idempotencyKey: browserConsumptionKey(tenantId, proposalId(), TOOL_USE_ID),
      commandSha256: subjectSha256(), argumentsSha256: f.prepared().record.inputSha256, jti: null, state: 'CLAIMED',
    });
  });

  it('answers a repeat, a restart and an UNKNOWN claim with a NON-permissive readback', async () => {
    const f = await approved();
    const first = (await f.consume()) as any;
    for (const repeat of [(await f.consume()) as any, (await f.consume()) as any]) {
      expect(repeat.schema).toBe('meri-browser-approval-status/1');
      expect(repeat.permissive).toBe(false);
      expect(repeat.unknown).toBe(true);
      expect(repeat.consumption.state).toBe('CLAIMED');
      expect(repeat.consumption.consumedAtMs).toBe(first.consumption.consumedAtMs);
      expect(repeat.consumption.consumed).toBeUndefined();
      expect(repeat.decision).toBeUndefined();
    }
    expect(f.createConsumption).toHaveBeenCalledTimes(1);
    expect(f.consumptions.size).toBe(1);
  });

  it('refuses to consume without a current approved decision, when revoked or when expired', async () => {
    const none = fixture();
    await expect(none.consume()).rejects.toBeInstanceOf(ConflictException);
    expect(none.createConsumption).not.toHaveBeenCalled();
    const rejected = fixture();
    await rejected.record({ decision: 'rejected' });
    await expect(rejected.consume()).rejects.toBeInstanceOf(ConflictException);
    const revoked = await approved();
    revoked.revocations.set(`${tenantId}:${proposalId()}`, { tenantId, proposalId: proposalId() });
    await expect(revoked.consume()).rejects.toBeInstanceOf(ConflictException);
    expect(revoked.createConsumption).not.toHaveBeenCalled();
    // The stored decision has since expired.
    const expired = await approved();
    const stored = expired.decisions.get(`${tenantId}:${proposalId()}`);
    stored.expiresAt = new Date(Date.now() - 1_000);
    await expect(expired.consume()).rejects.toBeInstanceOf(ConflictException);
    expect(expired.createConsumption).not.toHaveBeenCalled();
  });

  it('status never grants and reports the retained facts at each phase', async () => {
    const f = await approved();
    const before = await f.status();
    expect(before).toMatchObject({ permissive: false, unknown: false, consumption: null });
    expect(before.decision!.commandSha256).toBe(subjectSha256());
    await f.consume();
    expect(await f.status()).toMatchObject({ permissive: false, unknown: true });
    await f.settle('ok', { action: 'click', atMs: 5 });
    const after = await f.status();
    expect(after).toMatchObject({ permissive: false, unknown: false });
    expect(after.consumption).toMatchObject({ state: 'COMPLETED', result: { outcome: 'ok', result: { action: 'click', atMs: 5 } } });
    // Retained facts stay readable; the answer is still never a grant.
    expect(after.decision!.commandSha256).toBe(subjectSha256());
    expect(after.permissive).toBe(false);
  });

  it('settles once, refuses a conflicting settlement and never re-authorizes execution', async () => {
    const f = await approved();
    await f.consume();
    expect((await f.settle('ok', { action: 'click', atMs: 7 })).consumption).toMatchObject({ state: 'COMPLETED' });
    expect((await f.settle('ok', { action: 'click', atMs: 7 })).consumption).toMatchObject({ state: 'COMPLETED' });
    await expect(f.settle('error', { action: 'click', atMs: 7 })).rejects.toBeInstanceOf(ConflictException);
    expect(f.updateMany).toHaveBeenCalledTimes(1);
    const after = (await f.consume()) as any;
    expect(after.permissive).toBe(false);
    expect(after.unknown).toBe(false);
    expect(after.consumption).toMatchObject({ state: 'COMPLETED' });
    expect(f.createConsumption).toHaveBeenCalledTimes(1);
  });

  it('refuses settlement without a consumption, for another actor or without service identity', async () => {
    const f = await approved();
    await expect(f.settle()).rejects.toBeInstanceOf(ConflictException);
    await f.consume();
    await expect(f.service.resultBrowser(verifiedRequest(), { tenantId, userId: otherActor } as TenantContext,
      { proposalId: proposalId(), subjectSha256: subjectSha256(), binding: { ...binding, actorId: otherActor }, outcome: 'ok', result: {} }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.resultBrowser(verifiedRequest(false), ctx,
      { proposalId: proposalId(), subjectSha256: subjectSha256(), binding, outcome: 'ok', result: {} }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses non-closed bodies on every browser operation', async () => {
    const f = await approved();
    const closed = { proposalId: proposalId(), subjectSha256: subjectSha256(), binding };
    const calls = [
      () => f.service.consumeBrowser(verifiedRequest(), ctx, { ...closed, extra: 1 }),
      () => f.service.statusBrowser(verifiedRequest(), ctx, { ...closed, extra: 1 }),
      () => f.service.resultBrowser(verifiedRequest(), ctx, { ...closed, outcome: 'ok', result: {}, extra: 1 }),
      () => f.service.recordBrowser(verifiedRequest(), ctx, { proposalId: proposalId(), subjectSha256: subjectSha256(), decision: 'approved', approver: { tenantId, actorId }, binding, extra: 1 }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SCRUM-222 correction: real full Run envelope, bounded ledger key, one non-permissive schema', () => {
  it('accepts the real Parent10 full Run envelope and refuses malformed or substituted envelopes', () => {
    // The genuine answer: six required Run fields including createdAt and versions.
    const accepted = assertBrowserReadback(readback(), expectedReadback());
    expect(Object.keys(accepted.run).sort()).toEqual(['binding', 'createdAt', 'policyRevision', 'scopes', 'state', 'versions']);
    expect(accepted.run.versions).toEqual({
      imageDigest: `sha256:${'a'.repeat(64)}`, sdk: '0.1.0', cli: '0.1.0',
      contracts: '0.1.0', skillsDigest: 'b'.repeat(64), checkpointFormat: '0.1.0',
    });
    const mutate = (fn: (raw: any) => void) => { const copy = JSON.parse(JSON.stringify(readback())); fn(copy); return copy; };
    const refused = [
      mutate((r) => { delete r.run.createdAt; }),
      mutate((r) => { delete r.run.versions; }),
      mutate((r) => { delete r.run.versions.imageDigest; }),
      mutate((r) => { r.run.versions.imageDigest = 'sha256:short'; }),
      mutate((r) => { r.run.versions.contracts = '0.2.0'; }),
      mutate((r) => { r.run.versions.checkpointFormat = '0.2.0'; }),
      mutate((r) => { r.run.versions.sdk = 'v1'; }),
      mutate((r) => { r.run.versions.skillsDigest = 'not-a-digest'; }),
      mutate((r) => { r.run.versions.extra = 1; }),
      mutate((r) => { r.run.extra = 'four-field projection'; }),
      mutate((r) => { r.run.state = 'failed'; }),
      mutate((r) => { r.run.state = 'cancelled'; }),
      mutate((r) => { r.run.createdAt = '2026-10-30T00:00:00+00:00'; }),
      mutate((r) => { r.run.policyRevision = ''; }),
    ];
    for (const raw of refused) expect(() => assertBrowserReadback(raw, expectedReadback())).toThrow();
  });

  it('derives a bounded ledger key for the accepted 256-character tool-use id', async () => {
    const longId = 'toolu_' + 'z'.repeat(250);           // 256 characters, the accepted maximum
    expect(longId).toHaveLength(256);
    const key = browserConsumptionKey(tenantId, proposalId(), longId);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^browser:[0-9a-f]{64}$/);
    expect(key).not.toContain(longId);
    // Distinct identities differ; the same identity is stable across calls.
    expect(browserConsumptionKey(tenantId, proposalId(), longId)).toBe(key);
    expect(browserConsumptionKey(tenantId, proposalId(), `${longId.slice(0, -1)}y`)).not.toBe(key);
    expect(browserConsumptionKey(tenantId, otherActor, longId)).not.toBe(key);
    // The service uses that one key for consumption, status and settlement.
    const longProposal = browserProposalId(binding, longId);
    const longSubjectSha256 = nativeCanonicalSha256(subject({ toolUseId: longId }));
    const f = fixture({ readback: readback({ preparation: preparation({}, { toolUseId: longId }) }) });
    await f.service.recordBrowser(verifiedRequest(), ctx, { proposalId: longProposal, subjectSha256: longSubjectSha256,
      decision: 'approved', approver: { tenantId, actorId }, binding });
    const body = { proposalId: longProposal, subjectSha256: longSubjectSha256, binding };
    const consumed = await f.service.consumeBrowser(verifiedRequest(), ctx, body) as any;
    expect(consumed.consumption.consumed).toBe(true);
    expect(consumed.toolUseId).toBe(longId);
    expect([...f.consumptions.keys()]).toEqual([`${tenantId}:${longProposal}:${browserConsumptionKey(tenantId, longProposal, longId)}`]);
    const repeat = await f.service.consumeBrowser(verifiedRequest(), ctx, body) as any;
    expect(repeat.permissive).toBe(false);
    await f.service.resultBrowser(verifiedRequest(), ctx, { ...body, outcome: 'ok', result: { atMs: 1 } });
    expect([...f.consumptions.keys()]).toEqual([`${tenantId}:${longProposal}:${browserConsumptionKey(tenantId, longProposal, longId)}`]);
    expect(f.createConsumption).toHaveBeenCalledTimes(1);
  });

  it('answers ONE canonical non-permissive schema that the host receiptRefusal rejects', async () => {
    const f = fixture();
    await f.record();
    const first = (await f.consume()) as any;
    const repeat = (await f.consume()) as any;
    const status = await f.status();
    for (const answer of [repeat, status]) {
      // Host approval-binding.mjs receiptRefusal first branch: a schema other than
      // 'meri-browser-approval-receipt/1' is DENIED before any field is trusted.
      expect(answer.schema).toBe(BROWSER_STATUS_SCHEMA);
      expect(answer.schema).not.toBe(BROWSER_RECEIPT_SCHEMA);
      expect((answer.consumption as any).consumed).toBeUndefined();
      expect(answer.permissive).toBe(false);
      expect(answer.unknown).toBe(true);
    }
    // The consume-repeat answer carries no decision at all; the status readback may
    // report the retained decision, which still cannot be used as a receipt.
    expect(repeat.decision).toBeUndefined();
    expect(status.decision!.commandSha256).toBe(subjectSha256());
    expect(first.schema).toBe(BROWSER_RECEIPT_SCHEMA);
    expect(first.consumption.consumed).toBe(true);
  });
});
