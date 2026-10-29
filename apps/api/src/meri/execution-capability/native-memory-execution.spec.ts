import { ConfigService } from '@nestjs/config';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { MeriMemoryReceivingService } from '../memory-receiving/meri-memory-receiving.service.js';
import { MeriExecutionReceiverService } from './meri-execution-receiver.service.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
function fixture(scope = 'personal', general = false) {
  const state = {
    now: NOW,
    session: true,
    member: true,
    wall: true,
    conversation: true,
    role: 'standard_user',
    revoked: false,
    complete: true,
    collision: false,
    loseResponse: false,
    reads: 0,
  };
  const ctx: any = { tenantId: id(1), userId: id(2), role: 'standard_user' };
  const binding = {
    tenantId: id(1),
    actorId: id(2),
    conversationId: id(3),
    runId: id(4),
    attemptId: id(5),
    workerId: id(6),
    writerFence: 1,
  };
  const selectedClientId = general ? null : id(7);
  const command: any = {
    contractVersion: '0.1.0',
    commandId: id(8),
    binding,
    action: 'memory.propose',
    arguments: {
      content: 'Exact preference\nSecond line',
      key: null,
      scope,
      clientId: scope === 'client' ? selectedClientId : null,
      ttlDays: 30,
    },
    attachments: [],
    scopes: [
      {
        tenantId: id(1),
        kind: general ? 'private-user' : 'client',
        resourceId: selectedClientId ?? id(2),
        policyRevision: 'policy1',
      },
    ],
    idempotencyKey: 'memory-fixture',
  };
  const proposal = {
    proposalId: id(9),
    command,
    commandSha256: hash(command),
    createdAt: new Date(NOW - 10000).toISOString(),
    expiresAt: new Date(NOW + 900000).toISOString(),
    requiredApprover: { tenantId: id(1), actorId: id(2) },
  };
  const metadata: any = {
    schemaVersion: 1,
    commandSha256: proposal.commandSha256,
    metadata: {
      commandSha256: proposal.commandSha256,
      commandContext: { binding, conversationClientId: selectedClientId },
      record: {
        operation: { id: 'save_memory', version: '0.2.0' },
        action: command.action,
        binding,
        request: { content: '  Exact preference\nSecond line  ', scope, ttlDays: 30 },
        inputSha256: hash({ arguments: command.arguments, attachments: [] }),
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        proposalId: proposal.proposalId,
        scopes: command.scopes,
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
        requiredApprover: proposal.requiredApprover,
      },
    },
    run: { binding, scopes: command.scopes, state: 'completed' },
  };
  const candidates = new Map<string, any>(),
    submissions = new Map<string, any>(),
    receipts = new Map<string, any>(),
    decisions = new Map<string, any>();
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      const text = sql.join('?');
      if (text.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (text.includes('SELECT c.id'))
        return state.wall ? values[1].map((id: string) => ({ id })) : [];
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      if (!sql.join('?').includes('INSERT INTO memory_candidate')) throw Error('Unexpected write');
      candidates.set(values[0], {
        id: values[0],
        status: 'pending',
        sourceKind: 'explicit_user',
        decidedAt: null,
        committedMemoryId: null,
        committedMemoryItemId: null,
        duplicateMemoryItemId: null,
        payload: JSON.parse(values[5]),
        provenance: JSON.parse(values[6]),
      });
      return 1;
    }),
    tenantMembership: {
      findFirst: jest.fn(async () =>
        state.member ? { role: state.role, tenant: { status: 'active' } } : null,
      ),
    },
    clioConversation: {
      findFirst: jest.fn(async () =>
        state.conversation
          ? {
              id: id(3),
              tenantId: id(1),
              userId: id(2),
              clientId: selectedClientId,
              status: 'active',
              metadata: null,
              archivedAt: null,
            }
          : null,
      ),
    },
    clioConversationBootstrapReceipt: { findFirst: jest.fn(async () => ({ requestId: id(99) })) },
    clioMeriApprovalDecision: {
      findUnique: jest.fn(async () => decisions.get('decision') ?? null),
      create: jest.fn(async ({ data }: any) => {
        decisions.set('decision', data);
        return data;
      }),
    },
    clioMeriApprovalRevocation: { findUnique: jest.fn(async () => (state.revoked ? {} : null)) },
    clioMeriExecutionConsumption: {
      findUnique: jest.fn(async () => receipts.get('receipt') ?? null),
      create: jest.fn(async ({ data }: any) => {
        const r = { ...data, state: 'CLAIMED' };
        receipts.set('receipt', r);
        return r;
      }),
      updateMany: jest.fn(async ({ data }: any) => {
        if (!state.complete) return { count: 0 };
        Object.assign(receipts.get('receipt'), data);
        return { count: 1 };
      }),
    },
    clioMeriMemorySubmission: {
      findUnique: jest.fn(
        async ({ where }: any) => submissions.get(where.tenantId_candidateId.candidateId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        [...submissions.values()].filter((r) => where.candidateId.in.includes(r.candidateId)),
      ),
      create: jest.fn(async ({ data }: any) => {
        submissions.set(data.candidateId, data);
        return data;
      }),
    },
    memoryCandidate: {
      findUnique: jest.fn(async ({ where }: any) => candidates.get(where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        [...candidates.values()].filter((r) => where.id.in.includes(r.id)),
      ),
    },
    clioMemory: { findFirst: jest.fn(async () => (state.collision ? { id: id(80) } : null)) },
  };
  const transaction = async (_tenant: string, fn: (tx: any) => Promise<any>) => {
    const maps = [candidates, submissions, receipts, decisions],
      before = maps.map((m) => structuredClone(m));
    try {
      return await fn(tx);
    } catch (e) {
      maps.forEach((m, i) => {
        m.clear();
        before[i]!.forEach((v, k) => m.set(k, v));
      });
      throw e;
    }
  };
  const prisma: any = {
    withTenant: transaction,
    withTenantUser: (_t: string, _u: string, fn: any) => transaction(_t, fn),
  };
  const config: any = {
    get: (key: string) =>
      key === 'NODE_ENV'
        ? 'test'
        : key === 'MERI_CONTROL_ORIGIN'
          ? 'https://control.example.test'
          : 'synthetic-secret',
  };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    state.reads++;
    if (state.loseResponse && receipts.size) throw Error('Response lost');
    return Response.json(metadata);
  });
  const approvals = new NativeApprovalService(
    prisma,
    new NativeApprovalMetadataVerifier(config as ConfigService),
    {
      read: async () => ({
        principal: { tenantId: ctx.tenantId, actorId: ctx.userId },
        conversationId: binding.conversationId,
        selectedClientId,
        expiresAtMs: state.now + 60000,
      }),
    } as any,
  );
  const tenant: any = {
    readApplicationAuthoritySession: async () => ({
      readCurrent: async () => {
        if (!state.session) throw Error('Session revoked');
        return {
          principal: { tenantId: id(1), actorId: id(2) },
          identityRevision: 'a'.repeat(64),
          expiresAtMs: state.now + 60000,
        };
      },
    }),
  };
  const memory = new MeriMemoryReceivingService(prisma, {} as any);
  const service = new MeriExecutionReceiverService(
    prisma,
    {} as any,
    null,
    approvals,
    tenant,
    undefined,
    memory,
  );
  const req: any = {
    headers: { 'x-internal-service-secret': 'synthetic-secret' },
    method: 'POST',
    path: '/api/clio/approvals/native/execute',
  };
  new ToolServiceSecretGuard(config).canActivate({
    switchToHttp: () => ({ getRequest: () => req }),
  } as any);
  const body = { proposal, binding };
  return {
    state,
    ctx,
    proposal,
    command,
    metadata,
    candidates,
    submissions,
    receipts,
    decisions,
    tx,
    approve: () =>
      approvals.record(req, ctx, {
        ...body,
        approver: proposal.requiredApprover,
        decision: 'approved',
      }),
    execute: () => service.nativeApproved(req, ctx, body, 'execute'),
    read: () => service.nativeApproved(req, ctx, body, 'read'),
  };
}

describe('native approved memory submission and exact review readback', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['personal', false],
    ['personal', true],
    ['client', false],
    ['firm', true],
  ] as const)(
    'submits %s General=%s only after approval and never publishes',
    async (scope, general) => {
      const f = fixture(scope, general);
      expect(await f.read()).toBeNull();
      await expect(f.execute()).rejects.toThrow();
      expect(f.candidates.size).toBe(0);
      await f.approve();
      expect(f.candidates.size).toBe(0);
      const first: any = await f.execute();
      expect(first.status).toBe('observed');
      expect(first.outcome.execution.kind).toBe('native-memory');
      expect(first.outcome.result.review.status).toBe('pending');
      expect(first.outcome.result.review.publishedMemoryId).toBeNull();
      expect(f.candidates.get(id(9)).payload.value).toBe(f.command.arguments.content);
      expect(f.candidates.get(id(9)).payload.scope).toBe(
        scope === 'personal' ? 'user_private' : scope,
      );
      expect(f.candidates.get(id(9)).provenance.origin.commandSha256).toBe(
        f.proposal.commandSha256,
      );
      expect(await f.execute()).toEqual(first);
      expect(((await f.read()) as any).outcome).toEqual(first.outcome);
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(f.submissions.size).toBe(1);
      expect(f.receipts.size).toBe(1);
    },
  );
  it('recovers a lost post-commit response with the original outcome, even after expiry/revocation', async () => {
    const f = fixture();
    await f.approve();
    f.state.loseResponse = true;
    await expect(f.execute()).rejects.toThrow();
    expect(f.candidates.size).toBe(1);
    f.state.loseResponse = false;
    f.state.now += 1000000;
    f.state.revoked = true;
    expect(((await f.read()) as any).outcome.result.candidateId).toBe(f.proposal.proposalId);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it.each(['approved', 'rejected', 'withdrawn', 'not_found'])(
    'reports current %s without another submission',
    async (status) => {
      const f = fixture();
      await f.approve();
      await f.execute();
      f.state.now += 1000;
      if (status === 'not_found') f.candidates.clear();
      else
        Object.assign(f.candidates.get(id(9)), {
          status,
          decidedAt: new Date(f.state.now),
          committedMemoryId: status === 'approved' ? id(80) : null,
        });
      const result: any = await f.read();
      expect(result.outcome.result.review.status).toBe(status);
      expect(result.outcome.result.review.publishedMemoryId).toBe(
        status === 'approved' ? `clio:${id(80)}` : null,
      );
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    },
  );
  it('rolls candidate and submission back when the execution receipt cannot commit', async () => {
    const f = fixture();
    await f.approve();
    f.state.complete = false;
    await expect(f.execute()).rejects.toThrow();
    expect(f.candidates.size + f.submissions.size + f.receipts.size).toBe(0);
  });
  it.each(['session', 'member', 'wall', 'conversation'])(
    'withholds execution/readback after current %s loss',
    async (key) => {
      const f = fixture('client');
      await f.approve();
      await f.execute();
      (f.state as any)[key] = false;
      await expect(f.read()).rejects.toThrow();
      await expect(f.execute()).rejects.toThrow();
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['content', 'scope', 'ttlDays', 'clientId'])(
    'rejects altered prepared %s and does not submit',
    async (key) => {
      const f = fixture();
      (f.metadata.metadata.record.request as any)[key] = key === 'ttlDays' ? 29 : 'changed';
      await expect(f.approve()).rejects.toThrow();
      expect(f.candidates.size).toBe(0);
    },
  );
  it('refuses a keyed collision instead of guessing a correction target', async () => {
    const f = fixture();
    f.command.arguments.key = 'existing';
    f.metadata.metadata.record.request.key = 'existing';
    f.proposal.commandSha256 = hash(f.command);
    f.metadata.commandSha256 = f.proposal.commandSha256;
    f.metadata.metadata.commandSha256 = f.proposal.commandSha256;
    f.metadata.metadata.record.inputSha256 = hash({
      arguments: f.command.arguments,
      attachments: [],
    });
    await f.approve();
    f.state.collision = true;
    await expect(f.execute()).rejects.toThrow('correction');
    expect(f.candidates.size + f.receipts.size).toBe(0);
  });
  it('refuses fractional TTL instead of silently changing the reviewed lifetime', async () => {
    const f = fixture();
    f.command.arguments.ttlDays = 1.5;
    f.proposal.commandSha256 = hash(f.command);
    await expect(f.approve()).rejects.toThrow();
    expect(f.candidates.size).toBe(0);
  });
});
