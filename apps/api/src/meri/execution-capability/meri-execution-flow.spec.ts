import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
import { readMeriExecutionIdentity, type CoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import { isMeriExecutionCapabilityPost } from '../../auth/meri-execution-request.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import { NativeExecutionService } from '../native-approvals/native-execution.service.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import type { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import {
  MERI_EXECUTION_TASK_SOURCE,
  MeriExecutionReceiverService,
  assertOrdinaryToolPathAllowed,
} from './meri-execution-receiver.service.js';
import { meriExecutionTrust } from './meri-execution-authority.js';
import { meriExecutionRequestId, taskCreateSourceBody, verifyMeriExecutionCapability } from './meri-execution-capability.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherActor = '33333333-3333-4333-8333-333333333333';
const clientId = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const proposalId = '99999999-9999-4999-8999-999999999999';
const ADMITTED_GRANT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const binding = {
  tenantId, actorId,
  conversationId: '44444444-4444-4444-8444-444444444444', runId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666', workerId: '77777777-7777-4777-8777-777777777777', writerFence: 3,
};
const budgets = { maxTurns: 20, maxRuntimeSeconds: 900, maxCostMicrousd: 2_000_000, maxOutputBytes: 1_048_576 };
const WORKER_ARN = 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/0123456789abcdef0123456789abcdef';
const POLICY = 'policy-r1';
const qualification = { runId: binding.runId, attempt: 2, workerArn: WORKER_ARN, fence: binding.writerFence, policyRevision: POLICY };
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
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const MAXIMA = ['MERI_EXECUTION_MAX_TURNS', 'MERI_EXECUTION_MAX_RUNTIME_SECONDS', 'MERI_EXECUTION_MAX_COST_MICROUSD', 'MERI_EXECUTION_MAX_OUTPUT_BYTES'];
afterEach(() => { for (const name of MAXIMA) delete process.env[name]; });

const clientScope = { tenantId, kind: 'client', resourceId: clientId, policyRevision: POLICY };
const tenantScope = { tenantId, kind: 'tenant', resourceId: tenantId, policyRevision: POLICY };
function makeProposal(args: Record<string, unknown> = { title: 'Call the delegation', clientId, dueDate: null }, scopes: unknown[] = [clientScope]) {
  const now = Date.now();
  const command = {
    contractVersion: '0.1.0', commandId: '88888888-8888-4888-8888-888888888888', binding,
    action: 'task.create', arguments: args, attachments: [], scopes, idempotencyKey: 'intent-1',
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

interface GrantState { grantId: string; capabilitySha256: string; expiresAt: Date; state: string; attemptId?: string }

function world(options: { proposal?: ReturnType<typeof makeProposal> } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const sign = jest.fn<(m: Buffer) => Promise<Buffer>>();
  const inner = createInProcessEd25519Signer({ issuer: ISSUER, kid: KID, privateKey });
  sign.mockImplementation((m) => inner.sign(m, {}));
  const signer = { issuer: ISSUER, kid: KID, sign: (m: Buffer) => sign(m) };
  const config: CoreEd25519KeyConfig = {
    issuer: ISSUER, kid: KID, publicKey, region: 'us-east-1',
    keyArn: 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000',
  };
  const proposal = options.proposal ?? makeProposal();
  const now = Date.now();
  const state = {
    decision: {
      tenantId, proposalId, commandSha256: proposal.commandSha256, decision: 'approved',
      decidedAt: new Date(now - 30_000), expiresAt: new Date(now + 300_000),
      approverUserId: actorId, policyRevision: POLICY, bindingActorUserId: actorId,
      conversationId: binding.conversationId, runId: binding.runId,
    } as Record<string, any> | null,
    revocation: null as Record<string, any> | null,
    issuances: [] as Array<Record<string, any>>,
    consumptions: new Map<string, Record<string, any>>(),
    membership: { tenantId, userId: actorId, status: 'active', role: 'standard_user', tenant: { status: 'active', slug: 't' } } as Record<string, any> | null,
    visible: true,
    locks: 0,
    budgetLocks: 0,
    quarantined: false,
    allocation: makeAllocation() as Record<string, any>,
    run: { run_id: binding.runId, attempt: 2, worker_arn: WORKER_ARN, fence: binding.writerFence, policy_revision: POLICY } as Record<string, any> | null,
    runStartedAt: new Date(now - 60_000),
    admitted: { grantId: ADMITTED_GRANT, capabilitySha256: 'f'.repeat(64), expiresAt: new Date(now + 3_600_000), state: 'ACTIVE' } as GrantState,
    executionGrants: [] as GrantState[],
    /** Grants on the run that neither Meri's record declares nor Core issued. */
    foreignGrants: [] as GrantState[],
    /** Declared in Meri's ADMITTED record but with no grant row. */
    extraDeclared: [] as Array<Record<string, unknown>>,
    admittedRecord: 'ADMITTED' as string | null,
    ownerUnavailable: false,
    /** Database clock shifts: under the budget lock, and at the effect boundary. */
    lockClockShiftMs: 0,
    effectClockShiftMs: 0,
    tasks: [] as Array<Record<string, any>>,
    failTask: false,
  };
  const grantRow = (g: GrantState) => {
    const b = { ...binding, attemptId: g.attemptId ?? binding.attemptId, writerFence: state.run?.fence };
    return {
      grant_id: g.grantId, run_id: binding.runId, attempt: state.run?.attempt, worker_arn: state.run?.worker_arn, fence: state.run?.fence,
      policy_revision: state.run?.policy_revision, capability_sha256: g.capabilitySha256, expires_at: g.expiresAt, state: g.state,
      bound_grant_id: g.grantId, bound_run_id: binding.runId,
      facts: { grantId: g.grantId, binding: b, qualificationBinding: { ...qualification, attempt: state.run?.attempt, fence: state.run?.fence, workerArn: state.run?.worker_arn },
        capabilitySha256: g.capabilitySha256, allocationSha256: nativeCanonicalSha256(state.allocation) },
    };
  };
  const ckey = (w: any) => `${w.tenantId}:${w.proposalId}:${w.idempotencyKey}`;
  const byIat = (a: any, b: any) => Number(b.iatSeconds - a.iatSeconds) || b.recordedAt - a.recordedAt;
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) { state.locks++; return [{ locked: '' }]; }
      if (sql.includes('FROM clients')) return state.visible ? (values[1] as string[]).map((id) => ({ id })) : [];
      // Meri's SECURITY DEFINER admission snapshot (docs/integration/CORE-ADMISSION-SNAPSHOT-FUNCTION-20261018.sql):
      // budget FOR SHARE first, then the clock, then the rows, as one JSON value.
      if (sql.includes('meri_core_authority.current_admission_v1')) {
        if (state.ownerUnavailable) throw new Error('permission denied for function current_admission_v1');
        expect(values).toEqual([binding.tenantId, binding.conversationId, binding.runId]);
        state.budgetLocks++;
        const r = state.run;
        const admittedFacts = grantRow(state.admitted).facts;
        return [{ snapshot: clone({
          contract: 'capiro.meri-core-admission-snapshot.v1', budgetPresent: true, quarantined: state.quarantined,
          dbNowMs: Date.now() + state.lockClockShiftMs,
          admitted: state.admittedRecord === null ? null : {
            state: state.admittedRecord, binding: admittedFacts.binding, allocationSha256: nativeCanonicalSha256(state.allocation),
            grantFactsJsons: [JSON.stringify(admittedFacts), ...state.extraDeclared.map((f) => JSON.stringify(f))],
          },
          run: r ? { runId: r.run_id, attempt: r.attempt, workerArn: r.worker_arn, fence: r.fence, policyRevision: r.policy_revision } : null,
          allocation: r ? { allocation: state.allocation, allocationSha256: nativeCanonicalSha256(state.allocation), startedAtMs: state.runStartedAt.getTime() } : null,
          grants: [state.admitted, ...state.executionGrants, ...state.foreignGrants].map(grantRow).sort((a, b) => a.grant_id.localeCompare(b.grant_id)).map((g) => ({
            grantId: g.grant_id, runId: g.run_id, attempt: g.attempt, workerArn: g.worker_arn, fence: g.fence, policyRevision: g.policy_revision,
            capabilitySha256: g.capability_sha256, expiresAtMs: g.expires_at.getTime(), state: g.state, boundGrantId: g.bound_grant_id,
            boundRunId: g.bound_run_id, facts: g.facts,
          })),
        }) }];
      }
      if (sql.includes('clock_timestamp() AS db_now')) return [{ db_now: new Date(Date.now() + state.effectClockShiftMs) }];
      throw new Error(`unexpected SQL ${sql}`);
    }),
    clioMeriApprovalDecision: { findUnique: jest.fn(async () => (state.decision ? { ...state.decision } : null)) },
    clioMeriApprovalRevocation: {
      findUnique: jest.fn(async () => (state.revocation ? { ...state.revocation } : null)),
      createMany: jest.fn(async ({ data }: any) => { if (!state.revocation) state.revocation = { ...data[0] }; return { count: 1 }; }),
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
  const approvals = new NativeApprovalService(prisma as never, metadata);
  const receiver = new MeriExecutionReceiverService(prisma as never, engagement as never, config);
  const ctx = { tenantId, userId: actorId } as TenantContext;
  /** Meri's admission deadline: min(started + 900 s, schedule expiry, admitted grant expiry). */
  const deadline = () => Math.min(state.runStartedAt.getTime() + 900_000, Date.parse(state.allocation.schedule.expiresAt), state.admitted.expiresAt.getTime());
  const request = (overrides: Record<string, unknown> = {}) => ({
    proposal: clone(proposal), executorBinding: clone(binding),
    requestId: meriExecutionRequestId({ proposalId, commandSha256: proposal.commandSha256, executorBinding: binding }),
    allocation: clone(state.allocation), allocationSha256: nativeCanonicalSha256(state.allocation),
    qualification: { ...qualification, attempt: state.run?.attempt, fence: state.run?.fence }, runDeadlineMs: deadline(), ...overrides,
  });
  /** Meri's lane X installer: the capability's own ACTIVE execution grant, expiring at the token exp. */
  const install = (credential: string, expiresAtMs: number) =>
    state.executionGrants.push({ grantId: readMeriExecutionIdentity(credential, config, Date.now())!.jti, capabilitySha256: sha(credential),
      expiresAt: new Date(expiresAtMs), state: 'ACTIVE' });
  return { state, tx, sign, signer, config, proposal, issuer, approvals, receiver, ctx, request, metadata, createTask, install, deadline };
}

const issue = (w: ReturnType<typeof world>, overrides: Record<string, unknown> = {}, req = verifiedRequest(), ctx = w.ctx) =>
  w.issuer.issue(req, ctx, w.request(overrides));
/** Issue and let Meri install the execution grant, as its issuance owner does before the receipt. */
async function issueInstalled(w: ReturnType<typeof world>) {
  const receipt = await issue(w);
  w.install(receipt.credential, receipt.expiresAtMs);
  return receipt;
}

function receive(w: ReturnType<typeof world>, credential: string, body: unknown) {
  const identity = readMeriExecutionIdentity(credential, w.config, Date.now());
  if (!identity) throw new Error('identity');
  return w.receiver.receive(verifiedRequest(), w.ctx, 'create_task', body, { token: credential, ...identity });
}

describe('Meri execution issuance (POST /api/clio/approvals/native/execution)', () => {
  it("issues from Meri's rev 3 body against Meri's canonical admission, ledger first, under the budget lock", async () => {
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
      allocationSha256: nativeCanonicalSha256(w.state.allocation), qualification,
    });
    expect(verified.execution.qualification).toEqual(qualification);
    expect(receipt.expiresAtMs).toBeLessThanOrEqual(w.deadline());
    expect(w.metadata.verify).toHaveBeenCalledTimes(1);
    expect({ locks: w.state.locks, budgetLocks: w.state.budgetLocks }).toEqual({ locks: 1, budgetLocks: 1 });
  });

  it('answers a replay of the same attempt with the same capability after re-running every precondition', async () => {
    const w = world();
    const first = await issue(w);
    const second = await issue(w);
    expect(second.credential).toBe(first.credential);
    expect(second.execution).toEqual(first.execution);
    expect(w.state.issuances).toHaveLength(1);
    expect(w.metadata.verify).toHaveBeenCalledTimes(2);
    w.state.admitted.state = 'REVOKED';
    await expect(issue(w)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses another attempt while a capability is live, an older fence, and a changed replay', async () => {
    const w = world();
    await issue(w);
    const attempt2 = { ...binding, attemptId: 'abababab-abab-4bab-8bab-abababababab', writerFence: 4 };
    const id2 = meriExecutionRequestId({ proposalId, commandSha256: w.proposal.commandSha256, executorBinding: attempt2 });
    // Meri moved its run to the next attempt (admitted facts now carry it); the first capability is still live.
    w.state.run!.fence = 4;
    w.state.admitted.attemptId = attempt2.attemptId;
    const asAttempt = (b: typeof binding, id: string) => issue(w, {
      executorBinding: b, requestId: id, qualification: { ...qualification, fence: b.writerFence },
    });
    await expect(asAttempt(attempt2, id2)).rejects.toThrow('Another execution attempt holds a live capability');
    const older = { ...binding, attemptId: attempt2.attemptId, writerFence: 2 };
    const id3 = meriExecutionRequestId({ proposalId, commandSha256: w.proposal.commandSha256, executorBinding: older });
    w.state.run!.fence = 2;
    await expect(asAttempt(older, id3)).rejects.toThrow('Execution attempt is fenced');
    w.state.run!.fence = binding.writerFence;
    w.state.admitted.attemptId = undefined;
    await expect(issue(w, { allocationSha256: 'b'.repeat(64) })).rejects.toThrow('Execution request differs from the admitted run');
    // Meri replaced the run's allocation: the live capability no longer matches the owner.
    w.state.allocation = makeAllocation({ schedule: { ...w.state.allocation.schedule, revision: 'e'.repeat(64) } });
    await expect(issue(w)).rejects.toThrow('Execution request differs from its live capability');
  });

  it('refuses before any ledger write when a precondition fails', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => Promise<unknown>, unknown]> = [
      ['no service identity', (w) => issue(w, {}, verifiedRequest(false)), ForbiddenException],
      ['caller is not the approver', (w) => issue(w, {}, verifiedRequest(), { tenantId, userId: otherActor } as TenantContext), ForbiddenException],
      ['request id not deterministic', (w) => issue(w, { requestId: '12121212-1212-4212-8212-121212121212' }), ConflictException],
      ['an allocation other than the owner', (w) => issue(w, { allocation: makeAllocation({ schedule: { revision: 'e'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z', operations: [] } }) }), ConflictException],
      ['an allocation hash other than the owner', (w) => issue(w, { allocationSha256: 'a'.repeat(64) }), ConflictException],
      ['a qualification other than the owner', (w) => issue(w, { qualification: { ...qualification, attempt: 3 } }), ConflictException],
      ['a run deadline other than the owner', (w) => issue(w, { runDeadlineMs: w.deadline() + 1 }), ConflictException],
      ['old budgets member (rev 2 body)', (w) => issue(w, { budgets }), Error],
      ['executor attempt other than the admitted binding', (w) => {
        const b = { ...binding, attemptId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc' };
        return issue(w, { executorBinding: b, requestId: meriExecutionRequestId({ proposalId, commandSha256: w.proposal.commandSha256, executorBinding: b }) });
      }, ConflictException],
      ['admitted grant revoked at Meri', (w) => { w.state.admitted.state = 'REVOKED'; return issue(w); }, ConflictException],
      ['admitted grant expired', (w) => { w.state.admitted.expiresAt = new Date(Date.now() - 1); return issue(w); }, ConflictException],
      ['budget quarantined', (w) => { w.state.quarantined = true; return issue(w); }, ConflictException],
      ['owner run at another fence', (w) => { w.state.run!.fence = binding.writerFence + 1; return issue(w); }, ConflictException],
      ['owner run worker outside the pinned account', (w) => { w.state.run!.worker_arn = WORKER_ARN.replace('967807252336', '111111111111'); return issue(w); }, ConflictException],
      ['owner run past its deadline', (w) => { w.state.runStartedAt = new Date(Date.now() - 901_000); return issue(w); }, ConflictException],
      ['no admitted run', (w) => { w.state.run = null; return issue(w); }, ConflictException],
      ['owner tables unreadable (fails closed)', (w) => { w.state.ownerUnavailable = true; return issue(w); }, ServiceUnavailableException],
      ['executor run differs', (w) => issue(w, { executorBinding: { ...binding, runId: otherActor } }), ConflictException],
      ['decision rejected', (w) => { w.state.decision!.decision = 'rejected'; return issue(w); }, ConflictException],
      ['decision expired on the database clock', (w) => { w.state.lockClockShiftMs = 300_001; return issue(w); }, ConflictException],
      ['decision revoked', (w) => { w.state.revocation = { tenantId, proposalId }; return issue(w); }, ConflictException],
      ['no decision', (w) => { w.state.decision = null; return issue(w); }, ConflictException],
      ['client not visible', (w) => { w.state.visible = false; return issue(w); }, ForbiddenException],
      ['allocation above a configured platform maximum', (w) => { process.env.MERI_EXECUTION_MAX_COST_MICROUSD = '1999999'; return issue(w); }, ConflictException],
      ['a malformed platform maximum (fails closed)', (w) => { process.env.MERI_EXECUTION_MAX_TURNS = '20x'; return issue(w); }, ServiceUnavailableException],
    ];
    for (const [name, run, type] of cases) {
      const w = world();
      await expect(run(w)).rejects.toBeInstanceOf(type as never);
      expect({ name, rows: w.state.issuances.length, signed: w.sign.mock.calls.length }).toEqual({ name, rows: 0, signed: 0 });
      for (const env of MAXIMA) delete process.env[env];
    }
  });

  it('bounds budgets only by configured platform maxima, never a hard-coded profile', async () => {
    process.env.MERI_EXECUTION_MAX_COST_MICROUSD = '2000000';
    process.env.MERI_EXECUTION_MAX_RUNTIME_SECONDS = '900';
    await expect(issue(world())).resolves.toBeDefined();
    process.env.MERI_EXECUTION_MAX_COST_MICROUSD = '5000000';
    const big = world();
    big.state.allocation = makeAllocation({ budgets: { ...big.state.allocation.budgets, maxCostMicroUSD: 4_000_000 } });
    const verified = verifyMeriExecutionCapability((await issue(big)).credential, meriExecutionTrust(big.config, Date.now()));
    expect(verified.claims.budgets.maxCostMicrousd).toBe(4_000_000);
  });

  it("keeps a task inside the approved client scope; a null client follows the tenant-level contract", async () => {
    const outside = world({ proposal: makeProposal({ title: 'T', clientId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', dueDate: null }) });
    await expect(issue(outside)).rejects.toThrow('Execution client is outside the approved scope');
    const widened = world({ proposal: makeProposal({ title: 'T', clientId: null, dueDate: null }) });
    await expect(issue(widened)).rejects.toThrow('Execution client is outside the approved scope');
    const tenantTask = world({ proposal: makeProposal({ title: 'T', clientId: null, dueDate: null }, [tenantScope]) });
    const { credential, expiresAtMs } = await issue(tenantTask);
    tenantTask.install(credential, expiresAtMs);
    expect(await receive(tenantTask, credential, { title: 'T' })).toMatchObject({ created: true, task: { clientId: null } });
  });

  it('answers 503 without a configured signer', async () => {
    const w = world();
    const off = new NativeExecutionService({} as never, w.metadata, null);
    await expect(off.issue(verifiedRequest(), w.ctx, w.request())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('approval revocation (POST /api/clio/approvals/native/revoke)', () => {
  it('records an append-only revocation by the approver; decision reads answer revoked; issuance and receipt refuse', async () => {
    const w = world();
    const { credential } = await issueInstalled(w);
    const body = { proposalId, commandSha256: w.proposal.commandSha256, binding };
    const revokeBody = { ...body, approver: { tenantId, actorId } };
    await expect(w.approvals.revoke(verifiedRequest(), { tenantId, userId: otherActor } as TenantContext, revokeBody)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.approvals.revoke(verifiedRequest(false), w.ctx, revokeBody)).rejects.toBeInstanceOf(ForbiddenException);
    const revoked = await w.approvals.revoke(verifiedRequest(), w.ctx, revokeBody);
    expect(revoked).toMatchObject({ revoked: true, decision: { proposalId, decision: 'approved' } });
    expect(await w.approvals.revoke(verifiedRequest(), w.ctx, revokeBody)).toMatchObject({ revoked: true });
    expect(w.state.revocation).toMatchObject({ tenantId, proposalId, revokedByUserId: actorId, reason: 'approver_revoked' });
    expect(await w.approvals.decision(verifiedRequest(), w.ctx, body)).toMatchObject({ revoked: true });
    expect(w.state.locks).toBeGreaterThanOrEqual(2);
    await expect(receive(w, credential, taskCreateSourceBody(w.proposal.command.arguments))).rejects.toThrow('Approval decision is revoked');
    await expect(issue(w)).rejects.toThrow('Approval decision is revoked');
    expect(w.createTask).not.toHaveBeenCalled();
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

  it('never lets Meri fall back to the ordinary bearer create_task in the preview profile', () => {
    expect(() => assertOrdinaryToolPathAllowed('create_task', 'first-chat-preview')).toThrow(ForbiddenException);
    expect(() => assertOrdinaryToolPathAllowed('get_bill_status', 'first-chat-preview')).not.toThrow();
    expect(() => assertOrdinaryToolPathAllowed('create_task', 'standard')).not.toThrow();
    expect(() => assertOrdinaryToolPathAllowed('create_task', undefined)).not.toThrow();
  });

  it('writes the task, its effect identity and the result in one transaction and replays the stored result', async () => {
    const w = world();
    const { credential } = await issueInstalled(w);
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

  it('regression (dot 6247803584, 1): after Meri revokes the run grants, neither a new effect nor a completed replay passes', async () => {
    const fresh = world();
    const a = await issueInstalled(fresh);
    fresh.state.admitted.state = 'REVOKED';
    fresh.state.executionGrants.forEach((g) => { g.state = 'REVOKED'; });
    await expect(receive(fresh, a.credential, body(fresh))).rejects.toThrow('Execution run is not admitted');
    expect(fresh.createTask).not.toHaveBeenCalled();
    const done = world();
    const b = await issueInstalled(done);
    await receive(done, b.credential, body(done));
    done.state.admitted.state = 'REVOKED';
    await expect(receive(done, b.credential, body(done))).rejects.toThrow('Execution run is not admitted');
    // Only this capability's execution grant revoked (execution-grant-admission.revoke): refused too.
    const single = world();
    const c = await issueInstalled(single);
    single.state.executionGrants[0]!.state = 'REVOKED';
    await expect(receive(single, c.credential, body(single))).rejects.toThrow('Execution run is not admitted');
    const missing = world();
    const d = await issue(missing);
    await expect(receive(missing, d.credential, body(missing))).rejects.toThrow('Execution run is not admitted');
  });

  it('regression (dot 6247803584, 2): expiry is checked on the database clock under the locks, before release and at the effect', async () => {
    // The clock passes exp between the locked checks and the effect: the claim rolls back, nothing is written.
    const boundary = world();
    const a = await issueInstalled(boundary);
    boundary.state.effectClockShiftMs = a.expiresAtMs - Date.now() + 1;
    await expect(receive(boundary, a.credential, body(boundary))).rejects.toBeInstanceOf(UnauthorizedException);
    expect({ claims: boundary.state.consumptions.size, tasks: boundary.state.tasks.length }).toEqual({ claims: 0, tasks: 0 });
    // A completed result is not released once the database clock passes the capability expiry
    // (the process clock still accepts the token).
    const release = world();
    const b = await issueInstalled(release);
    await receive(release, b.credential, body(release));
    release.state.lockClockShiftMs = b.expiresAtMs - Date.now() + 1;
    // Refused on the database clock: the capability's own execution grant (expiring at exp) is no longer current.
    await expect(receive(release, b.credential, body(release))).rejects.toThrow('Execution run is not admitted');
    expect(release.createTask).toHaveBeenCalledTimes(1);
    // The run deadline on the database clock.
    const run = world();
    const c = await issueInstalled(run);
    run.state.lockClockShiftMs = run.deadline() - Date.now() + 1;
    await expect(receive(run, c.credential, body(run))).rejects.toThrow();
    expect(run.createTask).not.toHaveBeenCalled();
  });

  it("regression (dot 6248171459, 2): verifies Meri's exact declared grant set and bounds the effect by the capability's own grant", async () => {
    const missing = world();
    const a = await issueInstalled(missing);
    missing.state.extraDeclared.push({ grantId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', binding, qualificationBinding: qualification,
      capabilitySha256: 'e'.repeat(64), allocationSha256: nativeCanonicalSha256(missing.state.allocation) });
    await expect(receive(missing, a.credential, body(missing))).rejects.toThrow('Execution run is not admitted');
    const foreign = world();
    const b = await issueInstalled(foreign);
    foreign.state.foreignGrants.push({ grantId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', capabilitySha256: 'd'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000), state: 'ACTIVE' });
    await expect(receive(foreign, b.credential, body(foreign))).rejects.toThrow('Execution run is not admitted');
    const retired = world();
    const c = await issueInstalled(retired);
    retired.state.admittedRecord = 'RETIRED';
    await expect(receive(retired, c.credential, body(retired))).rejects.toThrow('Execution run is not admitted');
    // The capability's own execution grant expires before the token: the effect boundary refuses after it.
    const own = world();
    const d = await issueInstalled(own);
    own.state.executionGrants[0]!.expiresAt = new Date(Date.now() + 2_000);
    own.state.effectClockShiftMs = 2_001;
    await expect(receive(own, d.credential, body(own))).rejects.toThrow('Execution authority expired');
    for (const w of [missing, foreign, retired, own]) expect(w.createTask).not.toHaveBeenCalled();
  });

  it('regression (dot 6248171459, 1): a completed result is released only after a fresh database clock check', async () => {
    const w = world();
    const a = await issueInstalled(w);
    const result = await receive(w, a.credential, body(w));
    expect(await receive(w, a.credential, body(w))).toEqual(result);
    w.state.effectClockShiftMs = a.expiresAtMs - Date.now() + 1;
    await expect(receive(w, a.credential, body(w))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(w.createTask).toHaveBeenCalledTimes(1);
  });

  it('rolls the claim back with a failed task write, so a retry creates the task exactly once', async () => {
    const w = world();
    const { credential } = await issueInstalled(w);
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
    const { credential } = await issueInstalled(w);
    w.state.consumptions.set(`${tenantId}:${proposalId}:intent-1`, {
      tenantId, proposalId, idempotencyKey: 'intent-1', commandSha256: w.proposal.commandSha256,
      argumentsSha256: nativeCanonicalSha256(w.proposal.command.arguments), jti: w.state.issuances[0]!.jti, state: 'CLAIMED', result: null,
    });
    await expect(receive(w, credential, body(w))).rejects.toThrow('Execution outcome unknown');
    expect(w.createTask).not.toHaveBeenCalled();
  });

  it('refuses before any claim when the body, ledger, decision, membership, clients, admission or attempt differ', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, unknown, unknown?]> = [
      ['changed title', () => undefined, ConflictException, { title: 'Something else', clientId }],
      ['null member present', () => undefined, ConflictException, { title: 'Call the delegation', clientId, dueDate: null }],
      ['not in Core ledger', (w) => { w.state.issuances = []; }, ForbiddenException],
      ['decision policy changed', (w) => { w.state.decision!.policyRevision = 'policy-r2'; }, ConflictException],
      ['decision expired', (w) => { w.state.decision!.expiresAt = new Date(Date.now() - 1); }, ConflictException],
      ['decision revoked', (w) => { w.state.revocation = { tenantId, proposalId }; }, ConflictException],
      ['membership inactive', (w) => { w.state.membership = null; }, ForbiddenException],
      ['membership below standard_user', (w) => { w.state.membership!.role = 'viewer'; }, ForbiddenException],
      ['client wall', (w) => { w.state.visible = false; }, ForbiddenException],
      ['budget quarantined', (w) => { w.state.quarantined = true; }, ConflictException],
      ['run fence moved at Meri', (w) => { w.state.run!.fence = binding.writerFence + 1; }, ConflictException],
      ['run attempt changed at Meri', (w) => { w.state.run!.attempt = 3; }, ConflictException],
      ['admitted attempt id changed at Meri', (w) => { w.state.admitted.attemptId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc'; }, ConflictException],
      ['allocation replaced at Meri', (w) => { w.state.allocation = makeAllocation({ schedule: { ...w.state.allocation.schedule, revision: 'e'.repeat(64) } }); }, ConflictException],
      ['execution grant digest differs', (w) => { w.state.executionGrants[0]!.capabilitySha256 = 'e'.repeat(64); }, ConflictException],
      ['owner tables unreadable', (w) => { w.state.ownerUnavailable = true; }, ServiceUnavailableException],
      ['superseded attempt', (w) => {
        w.state.issuances.push({ ...w.state.issuances[0]!, jti: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', iatSeconds: w.state.issuances[0]!.iatSeconds + 1n });
      }, ConflictException],
    ];
    for (const [name, mutate, type, alt] of cases) {
      const w = world();
      const { credential } = await issueInstalled(w);
      mutate(w);
      await expect(receive(w, credential, alt ?? body(w))).rejects.toBeInstanceOf(type as never);
      expect({ name, claims: w.state.consumptions.size, effects: w.createTask.mock.calls.length }).toEqual({ name, claims: 0, effects: 0 });
    }
  });

  it('refuses another tool, another actor and a token that is not the request identity', async () => {
    const w = world();
    const { credential } = await issueInstalled(w);
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
