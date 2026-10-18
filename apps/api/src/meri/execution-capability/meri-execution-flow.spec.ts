import { describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { createInProcessEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { readMeriExecutionIdentity, type CoreEd25519KeyConfig } from '../../auth/core-ed25519-kms-config.js';
import { isMeriExecutionCapabilityPost } from '../../auth/meri-execution-request.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { NativeExecutionService } from '../native-approvals/native-execution.service.js';
import type { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import { MERI_EXECUTION_TASK_SOURCE, MeriExecutionReceiverService } from './meri-execution-receiver.service.js';
import { meriExecutionTrust } from './meri-execution-authority.js';
import { meriExecutionRequestId, taskCreateSourceBody, verifyMeriExecutionCapability } from './meri-execution-capability.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clientId = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const proposalId = '99999999-9999-4999-8999-999999999999';
const binding = {
  tenantId, actorId,
  conversationId: '44444444-4444-4444-8444-444444444444', runId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666', workerId: '77777777-7777-4777-8777-777777777777', writerFence: 3,
};
const budgets = { maxTurns: 20, maxRuntimeSeconds: 900, maxCostMicrousd: 2_000_000, maxOutputBytes: 1_048_576 };
const WORKER_ARN = 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/0123456789abcdef0123456789abcdef';
/** The fields of Meri's admitted allocation Core derives from (the full shape is in the admitted-allocation vector). */
const makeAllocation = (overrides: Record<string, unknown> = {}) => ({
  run: { tenantId, actorId, conversationId: binding.conversationId, runId: binding.runId },
  budgets: { maxTurns: 20, maxToolCalls: 20, maxRecoveryAttempts: 0, maxRuntimeSeconds: 900, maxCostMicroUSD: 2_000_000, maxOutputBytes: 1_048_576 },
  schedule: { revision: 'd'.repeat(64), expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), operations: [] },
  ...overrides,
});
const ISSUER = 'capiro-core:meri-execution:v1';
const KID = 'meri-execution-synthetic-1';
const SECRET = 'synthetic-service-secret';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function makeProposal(args: Record<string, unknown> = { title: 'Call the delegation', clientId, dueDate: null }) {
  const now = Date.now();
  const command = {
    contractVersion: '0.1.0', commandId: '88888888-8888-4888-8888-888888888888', binding,
    action: 'task.create', arguments: args, attachments: [],
    scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision: 'policy-r1' }], idempotencyKey: 'intent-1',
  };
  return {
    proposalId, command, commandSha256: nativeCanonicalSha256(command),
    createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    requiredApprover: { tenantId, actorId },
  };
}

function verifiedRequest(verified = true): Request {
  const req = { headers: { 'x-internal-service-secret': verified ? SECRET : 'wrong' }, method: 'POST', path: '/x' } as unknown as Request;
  const guard = new ToolServiceSecretGuard({
    get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false),
  } as never);
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}

function world(options: { decision?: 'approved' | 'rejected'; decisionExpiresInMs?: number; visible?: boolean } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const sign = jest.fn<(m: Buffer) => Promise<Buffer>>();
  const inner = createInProcessEd25519Signer({ issuer: ISSUER, kid: KID, privateKey });
  sign.mockImplementation((m) => inner.sign(m, {}));
  const signer = { issuer: ISSUER, kid: KID, sign: (m: Buffer) => sign(m) };
  const config: CoreEd25519KeyConfig = {
    issuer: ISSUER, kid: KID, publicKey, region: 'us-east-1',
    keyArn: 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000',
  };
  const proposal = makeProposal();
  const now = Date.now();
  const state = {
    decision: {
      tenantId, proposalId, commandSha256: proposal.commandSha256, decision: options.decision ?? 'approved',
      decidedAt: new Date(now - 30_000), expiresAt: new Date(now + (options.decisionExpiresInMs ?? 300_000)),
      approverUserId: actorId, policyRevision: 'policy-r1', bindingActorUserId: actorId,
      conversationId: binding.conversationId, runId: binding.runId,
    } as Record<string, any> | null,
    issuances: [] as Array<Record<string, any>>,
    consumptions: new Map<string, Record<string, any>>(),
    membership: { tenantId, userId: actorId, status: 'active', role: 'standard_user', tenant: { status: 'active', slug: 't' } } as Record<string, any> | null,
    visible: options.visible ?? true,
    locks: 0,
    allocation: makeAllocation() as Record<string, any>,
    run: { run_id: binding.runId, attempt: 2, worker_arn: WORKER_ARN, fence: binding.writerFence, policy_revision: 'policy-r1' } as Record<string, any> | null,
    runStartedAt: new Date(now - 60_000),
    ownerUnavailable: false,
    tasks: [] as Array<Record<string, any>>,
    failTask: false,
  };
  const ckey = (w: any) => `${w.tenantId}:${w.proposalId}:${w.idempotencyKey}`;
  const byIat = (a: any, b: any) => Number(b.iatSeconds - a.iatSeconds) || b.recordedAt - a.recordedAt;
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) { state.locks++; return [{ locked: '' }]; }
      if (sql.includes('FROM clients')) return state.visible ? (values[1] as string[]).map((id) => ({ id })) : [];
      if (sql.includes('meri_product_budget.runs')) {
        if (state.ownerUnavailable) throw new Error('permission denied for schema meri_product_budget');
        expect(values[0]).toBe(binding.runId);
        return state.run ? [{ ...state.run, allocation: clone(state.allocation), allocation_sha256: nativeCanonicalSha256(state.allocation), started_at: state.runStartedAt }] : [];
      }
      throw new Error(`unexpected SQL ${sql}`);
    }),
    clioMeriApprovalDecision: {
      findUnique: jest.fn(async () => (state.decision ? { ...state.decision } : null)),
    },
    clioMeriExecutionIssuance: {
      findMany: jest.fn(async () => [...state.issuances].sort(byIat).map((r) => ({ ...r }))),
      findFirst: jest.fn(async () => { const r = [...state.issuances].sort(byIat)[0]; return r ? { ...r } : null; }),
      findUnique: jest.fn(async ({ where }: any) => { const r = state.issuances.find((i) => i.jti === where.jti); return r ? { ...r } : null; }),
      create: jest.fn(async ({ data }: any) => {
        expect(sign).not.toHaveBeenCalledWith(expect.anything()); // recorded before signing
        const row = { ...clone({ ...data, iatSeconds: 0, expSeconds: 0 }), iatSeconds: data.iatSeconds, expSeconds: data.expSeconds, recordedAt: Date.now() };
        state.issuances.push(row);
        sign.mockClear();
        return row;
      }),
    },
    clioMeriExecutionConsumption: {
      findUnique: jest.fn(async ({ where }: any) => { const r = state.consumptions.get(ckey(where.tenantId_proposalId_idempotencyKey)); return r ? { ...r } : null; }),
      create: jest.fn(async ({ data }: any) => { state.consumptions.set(ckey(data), { ...data, state: 'CLAIMED', result: null }); return data; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = state.consumptions.get(ckey(where));
        if (!r || r.state !== where.state || r.jti !== where.jti) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    tenantMembership: { findFirst: jest.fn(async () => (state.membership ? { ...state.membership } : null)) },
  };
  // One transaction: a throw restores every table (the claim rolls back with the effect).
  const prisma = { withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => {
    const snapshot = { issuances: [...state.issuances], consumptions: new Map([...state.consumptions].map(([k, v]) => [k, { ...v }])), tasks: [...state.tasks] };
    try { return await fn(tx); } catch (error) { Object.assign(state, snapshot); throw error; }
  }) };
  const createTask = jest.fn(async (_ctx: unknown, input: any, internal: any) => {
    expect(internal.tx).toBe(tx);
    if (state.failTask) throw new Error('task write failed');
    if (state.tasks.some((t) => t.sourceType === internal.sourceType && t.sourceId === internal.sourceId)) throw new Error('unique');
    const task = { id: `task-${state.tasks.length + 1}`, title: input.title, status: 'todo', dueDate: input.dueDate ?? null,
      clientId: input.clientId ?? null, createdAt: new Date('2026-10-18T00:00:00.000Z'), sourceType: internal.sourceType, sourceId: internal.sourceId };
    state.tasks.push(task);
    return task;
  });
  const engagement = { createTask };
  const metadata = { verify: jest.fn(async () => undefined) } as unknown as NativeApprovalMetadataVerifier;
  const issuer = new NativeExecutionService(prisma as never, metadata, signer as never);
  const receiver = new MeriExecutionReceiverService(prisma as never, engagement as never, config);
  const ctx = { tenantId, userId: actorId } as TenantContext;
  const request = (overrides: Record<string, unknown> = {}) => ({
    proposal: clone(proposal), executorBinding: clone(binding),
    requestId: meriExecutionRequestId({ proposalId, commandSha256: proposal.commandSha256, executorBinding: binding }),
    budgets: clone(budgets), allocationSha256: nativeCanonicalSha256(state.allocation), ...overrides,
  });
  return { state, tx, sign, signer, config, proposal, issuer, receiver, ctx, request, metadata, createTask };
}

const issue = (w: ReturnType<typeof world>, overrides: Record<string, unknown> = {}, req = verifiedRequest(), ctx = w.ctx) =>
  w.issuer.issue(req, ctx, w.request(overrides));

function receive(w: ReturnType<typeof world>, credential: string, body: unknown) {
  const identity = readMeriExecutionIdentity(credential, w.config, Date.now());
  if (!identity) throw new Error('identity');
  return w.receiver.receive(verifiedRequest(), w.ctx, 'create_task', body, { token: credential, ...identity });
}

describe('Meri execution issuance (POST /api/clio/approvals/native/execution)', () => {
  it('issues a Core capability for the stored approval with Meri\'s request id and exact budgets, ledger first', async () => {
    const w = world();
    const receipt = await issue(w);
    expect(Object.keys(receipt)).toEqual(['execution', 'credential', 'checkedAtMs', 'expiresAtMs']);
    const verified = verifyMeriExecutionCapability(receipt.credential, meriExecutionTrust(w.config, Date.now()));
    expect(verified.claims.budgets).toEqual(budgets);
    expect(receipt.execution).toEqual({
      contractVersion: '0.1.0', requestId: w.request().requestId, capabilityId: verified.claims.capabilityId,
      executorBinding: binding, proposalId, commandSha256: w.proposal.commandSha256, idempotencyKey: 'intent-1',
    });
    expect(receipt.expiresAtMs).toBe(Date.parse(verified.claims.expiresAt));
    expect(w.state.issuances).toHaveLength(1);
    expect(w.state.issuances[0]).toMatchObject({
      jti: verified.claims.capabilityId, requestSha256: verified.execution.requestSha256,
      allocationSha256: nativeCanonicalSha256(w.state.allocation),
      qualification: { runId: binding.runId, attempt: 2, workerArn: WORKER_ARN, fence: binding.writerFence, policyRevision: 'policy-r1' },
    });
    expect(verified.execution.qualification).toEqual(w.state.issuances[0]!.qualification);
    // The run deadline (started_at + 900 s) bounds the capability.
    expect(receipt.expiresAtMs).toBeLessThanOrEqual(w.state.runStartedAt.getTime() + 900_000);
    expect(w.metadata.verify).toHaveBeenCalledTimes(1);
    expect(w.state.locks).toBe(1);
  });

  it('answers a replay of the same attempt with the same capability after re-running every precondition', async () => {
    const w = world();
    const first = await issue(w);
    const second = await issue(w);
    expect(second.credential).toBe(first.credential);
    expect(second.execution).toEqual(first.execution);
    expect(w.state.issuances).toHaveLength(1);
    expect(w.metadata.verify).toHaveBeenCalledTimes(2);
    w.state.decision!.decision = 'rejected';
    await expect(issue(w)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses another attempt while a capability is live, an older fence, and a changed replay', async () => {
    const w = world();
    await issue(w);
    const attempt2 = { ...binding, attemptId: 'abababab-abab-4bab-8bab-abababababab', writerFence: 4 };
    const id2 = meriExecutionRequestId({ proposalId, commandSha256: w.proposal.commandSha256, executorBinding: attempt2 });
    // Meri moved its run to the next attempt; the first capability is still live.
    w.state.run!.fence = 4;
    await expect(issue(w, { executorBinding: attempt2, requestId: id2 })).rejects.toThrow('Another execution attempt holds a live capability');
    const older = { ...binding, attemptId: 'abababab-abab-4bab-8bab-abababababab', writerFence: 2 };
    const id3 = meriExecutionRequestId({ proposalId, commandSha256: w.proposal.commandSha256, executorBinding: older });
    w.state.run!.fence = 2;
    await expect(issue(w, { executorBinding: older, requestId: id3 })).rejects.toThrow('Execution attempt is fenced');
    w.state.run!.fence = binding.writerFence;
    await expect(issue(w, { allocationSha256: 'b'.repeat(64) })).rejects.toThrow('Execution budgets differ from the admitted allocation');
    // Meri replaced the run's allocation: the live capability no longer matches the owner.
    w.state.allocation = makeAllocation({ schedule: { ...w.state.allocation.schedule, revision: 'e'.repeat(64) } });
    await expect(issue(w, { allocationSha256: nativeCanonicalSha256(w.state.allocation) })).rejects.toThrow('Execution request differs from its live capability');
  });

  it('refuses before any ledger write when a precondition fails', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => Promise<unknown>, unknown]> = [
      ['no service identity', (w) => issue(w, {}, verifiedRequest(false)), ForbiddenException],
      ['caller is not the approver', (w) => issue(w, {}, verifiedRequest(), { tenantId, userId: otherActor } as TenantContext), ForbiddenException],
      ['request id not deterministic', (w) => issue(w, { requestId: '12121212-1212-4212-8212-121212121212' }), ConflictException],
      ['budgets other than the owner allocation', (w) => issue(w, { budgets: { ...budgets, maxOutputBytes: 262_144 } }), ConflictException],
      ['an allocation hash other than the owner', (w) => issue(w, { allocationSha256: 'a'.repeat(64) }), ConflictException],
      ['owner allocation above D016 B1', (w) => {
        w.state.allocation = makeAllocation({ budgets: { ...w.state.allocation.budgets, maxCostMicroUSD: 2_000_001 } });
        return issue(w, { budgets: { ...budgets, maxCostMicrousd: 2_000_001 } });
      }, ConflictException],
      ['owner run at another fence', (w) => { w.state.run!.fence = binding.writerFence + 1; return issue(w); }, ConflictException],
      ['owner run worker outside the pinned account', (w) => { w.state.run!.worker_arn = WORKER_ARN.replace('967807252336', '111111111111'); return issue(w); }, ConflictException],
      ['owner run past its deadline', (w) => { w.state.runStartedAt = new Date(Date.now() - 901_000); return issue(w); }, ConflictException],
      ['no admitted run', (w) => { w.state.run = null; return issue(w); }, ConflictException],
      ['owner tables unreadable (fails closed)', (w) => { w.state.ownerUnavailable = true; return issue(w); }, ServiceUnavailableException],
      ['budgets open', (w) => issue(w, { budgets: { ...budgets, extra: 1 } }), Error],
      ['executor run differs', (w) => issue(w, { executorBinding: { ...binding, runId: otherActor } }), ConflictException],
      ['decision rejected', (w) => { w.state.decision!.decision = 'rejected'; return issue(w); }, ConflictException],
      ['decision expired', (w) => { w.state.decision!.expiresAt = new Date(Date.now() - 1); return issue(w); }, ConflictException],
      ['no decision', (w) => { w.state.decision = null; return issue(w); }, ConflictException],
      ['client not visible', (w) => { w.state.visible = false; return issue(w); }, ForbiddenException],
    ];
    for (const [name, run, type] of cases) {
      const w = world();
      await expect(run(w)).rejects.toBeInstanceOf(type as never);
      expect({ name, rows: w.state.issuances.length, signed: w.sign.mock.calls.length }).toEqual({ name, rows: 0, signed: 0 });
    }
  });

  it('answers 503 without a configured signer', async () => {
    const w = world();
    const off = new NativeExecutionService({} as never, w.metadata, null);
    await expect(off.issue(verifiedRequest(), w.ctx, w.request())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('Meri execution receiver (POST /api/clio/tools/create_task)', () => {
  const body = (w: ReturnType<typeof world>) => taskCreateSourceBody(w.proposal.command.arguments);

  it('admits only the execution bearer on the exact receiver path', async () => {
    const w = world();
    const { credential } = await issue(w);
    const req = (path: string, originalUrl = path, method = 'POST') =>
      ({ method, path, originalUrl, headers: { authorization: `Bearer ${credential}` } }) as unknown as Request;
    expect(isMeriExecutionCapabilityPost(req('/api/clio/tools/create_task'))).toBe(true);
    expect(isMeriExecutionCapabilityPost(req('/api/clio/tools/update_task'))).toBe(false);
    expect(isMeriExecutionCapabilityPost(req('/api/clio/tools/create_task', '/api/clio/tools/create_task?x=1'))).toBe(false);
    expect(isMeriExecutionCapabilityPost(req('/api/clio/tools/create_task', undefined, 'GET'))).toBe(false);
    const other = world();
    expect(readMeriExecutionIdentity(credential, other.config, Date.now())).toBeNull();
    expect(readMeriExecutionIdentity(credential, w.config, Date.now())).toMatchObject({ tenantId, actorId });
  });

  it('writes the task, its effect identity and the result in one transaction and replays the stored result', async () => {
    const w = world();
    const { credential } = await issue(w);
    const result = await receive(w, credential, body(w)) as any;
    expect(result).toMatchObject({ tool: 'create_task', created: true,
      task: { id: 'task-1', title: 'Call the delegation', clientId, dueDate: null, status: 'todo', createdAt: '2026-10-18T00:00:00.000Z' } });
    expect(Object.keys(result)).toEqual(['tool', 'generatedAt', 'created', 'task']);
    expect(w.state.tasks).toEqual([expect.objectContaining({ sourceType: MERI_EXECUTION_TASK_SOURCE, sourceId: `${proposalId}|intent-1` })]);
    const stored = [...w.state.consumptions.values()][0]!;
    expect(stored).toMatchObject({ state: 'COMPLETED', commandSha256: w.proposal.commandSha256, jti: w.state.issuances[0]!.jti, result });
    expect(await receive(w, credential, body(w))).toEqual(result);
    expect(w.createTask).toHaveBeenCalledTimes(1);
    expect(w.state.tasks).toHaveLength(1);
  });

  it('rolls the claim back with a failed task write, so a retry creates the task exactly once', async () => {
    const w = world();
    const { credential } = await issue(w);
    w.state.failTask = true;
    await expect(receive(w, credential, body(w))).rejects.toThrow('task write failed');
    expect(w.state.consumptions.size).toBe(0);
    w.state.failTask = false;
    await receive(w, credential, body(w));
    expect(w.state.tasks).toHaveLength(1);
    expect([...w.state.consumptions.values()][0]).toMatchObject({ state: 'COMPLETED' });
  });

  it('never redispatches a claimed identity without a result', async () => {
    const w = world();
    const { credential } = await issue(w);
    w.state.consumptions.set(`${tenantId}:${proposalId}:intent-1`, {
      tenantId, proposalId, idempotencyKey: 'intent-1', commandSha256: w.proposal.commandSha256,
      argumentsSha256: nativeCanonicalSha256(w.proposal.command.arguments), jti: w.state.issuances[0]!.jti, state: 'CLAIMED', result: null,
    });
    await expect(receive(w, credential, body(w))).rejects.toThrow('Execution outcome unknown');
    expect(w.createTask).not.toHaveBeenCalled();
  });

  it('refuses before any claim when the body, ledger, decision, membership, clients or attempt differ', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, unknown, unknown?]> = [
      ['changed title', () => undefined, ConflictException, { title: 'Something else', clientId }],
      ['null member present', () => undefined, ConflictException, { title: 'Call the delegation', clientId, dueDate: null }],
      ['not in Core ledger', (w) => { w.state.issuances = []; }, ForbiddenException],
      ['decision policy changed', (w) => { w.state.decision!.policyRevision = 'policy-r2'; }, ConflictException],
      ['decision expired', (w) => { w.state.decision!.expiresAt = new Date(Date.now() - 1); }, ConflictException],
      ['membership inactive', (w) => { w.state.membership = null; }, ForbiddenException],
      ['membership below standard_user', (w) => { w.state.membership!.role = 'viewer'; }, ForbiddenException],
      ['client wall', (w) => { w.state.visible = false; }, ForbiddenException],
      ['run fence moved at Meri', (w) => { w.state.run!.fence = binding.writerFence + 1; }, ConflictException],
      ['run attempt changed at Meri', (w) => { w.state.run!.attempt = 3; }, ConflictException],
      ['allocation replaced at Meri', (w) => { w.state.allocation = makeAllocation({ schedule: { ...w.state.allocation.schedule, revision: 'e'.repeat(64) } }); }, ConflictException],
      ['owner tables unreadable', (w) => { w.state.ownerUnavailable = true; }, ServiceUnavailableException],
      ['superseded attempt', (w) => {
        w.state.issuances.push({ ...w.state.issuances[0]!, jti: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', iatSeconds: w.state.issuances[0]!.iatSeconds + 1n });
      }, ConflictException],
    ];
    for (const [name, mutate, type, alt] of cases) {
      const w = world();
      const { credential } = await issue(w);
      mutate(w);
      await expect(receive(w, credential, alt ?? body(w))).rejects.toBeInstanceOf(type as never);
      expect({ name, claims: w.state.consumptions.size, effects: w.createTask.mock.calls.length }).toEqual({ name, claims: 0, effects: 0 });
    }
  });

  it('refuses another tool, another actor and a token that is not the request identity', async () => {
    const w = world();
    const { credential } = await issue(w);
    const identity = { token: credential, ...readMeriExecutionIdentity(credential, w.config, Date.now())! };
    await expect(w.receiver.receive(verifiedRequest(), w.ctx, 'update_task', body(w), identity)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.receiver.receive(verifiedRequest(false), w.ctx, 'create_task', body(w), identity)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.receiver.receive(verifiedRequest(), { tenantId, userId: otherActor } as TenantContext, 'create_task', body(w), identity)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.receiver.receive(verifiedRequest(), w.ctx, 'create_task', body(w), { ...identity, token: `${credential}x` })).rejects.toBeInstanceOf(UnauthorizedException);
    const off = new MeriExecutionReceiverService({} as never, {} as never, null);
    await expect(off.receive(verifiedRequest(), w.ctx, 'create_task', body(w), identity)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(w.createTask).not.toHaveBeenCalled();
  });
});
