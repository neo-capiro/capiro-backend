/** Synthetic transaction/retention SQL boundary; no PostgreSQL or provider effects. */
import { ConfigService } from '@nestjs/config';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { MeriMemoryReceivingService } from '../memory-receiving/meri-memory-receiving.service.js';
import { receiveNativeMemory } from './native-memory-execution.js';
import * as retentionWitness from '../../memory/conversation-serving/witness.js';

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const NOW = Date.parse('2026-10-28T12:00:00.000Z');
export function nativeMemoryExecutionFixture(
  scope = 'personal',
  general = false,
  receiverFactory?: (ports: any) => any,
) {
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
    witness: { sequence: 0, entrySha256: null } as retentionWitness.MemoryRetentionWitness | null,
    witnessReads: 0,
    retentionUsed: false,
    transactionWitness: null as retentionWitness.MemoryRetentionWitness | null,
    databaseWitnessMismatch: false,
    changeAfterInsert: false,
    witnessUnavailableAfterInsert: false,
    suppressCandidate: false,
    retentionEvents: [] as string[],
    transactionKind: null as 'tenant' | 'user' | null,
  };
  jest.spyOn(retentionWitness, 'readMemoryRetentionWitness').mockImplementation(async () => {
    state.witnessReads++;
    return state.witness === null ? null : { ...state.witness };
  });
  const assertRetainedCandidate = () => {
    state.retentionUsed = true;
    if (state.transactionWitness === null) throw Error('MEMORY_RETENTION_WITNESS_REQUIRED');
    if (state.suppressCandidate) throw Error('MEMORY_RETENTION_SUPPRESSED');
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
      if (text.includes("current_setting('app.memory_retention_used'"))
        return [{ used: state.retentionUsed ? 'on' : 'off' }];
      if (text.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (text.includes('SELECT c.id'))
        return state.wall ? values[1].map((id: string) => ({ id })) : [];
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      const text = sql.join('?');
      if (text.includes('memory_conversation_serving_begin')) {
        state.transactionWitness = JSON.parse(values[0]);
        state.retentionUsed = false;
        state.retentionEvents.push('begin');
        return 1;
      }
      if (text.includes('memory_conversation_serving_verify')) {
        state.retentionEvents.push('verify');
        if (state.databaseWitnessMismatch) throw Error('MEMORY_RETENTION_WATERMARK_UNVERIFIED');
        return 1;
      }
      if (!text.includes('INSERT INTO memory_candidate')) throw Error('Unexpected write');
      assertRetainedCandidate();
      state.retentionEvents.push('insert');
      if (state.changeAfterInsert) state.witness = { sequence: 1, entrySha256: 'b'.repeat(64) };
      if (state.witnessUnavailableAfterInsert) state.witness = null;
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
      findUnique: jest.fn(async ({ where }: any) => {
        if (candidates.size) assertRetainedCandidate();
        return candidates.get(where.id) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        if (candidates.size) assertRetainedCandidate();
        return [...candidates.values()].filter((r) => where.id.in.includes(r.id));
      }),
    },
    clioMemory: { findFirst: jest.fn(async () => (state.collision ? { id: id(80) } : null)) },
  };
  const transaction = async (
    _tenant: string,
    fn: (tx: any) => Promise<any>,
    kind: 'tenant' | 'user' = 'tenant',
  ) => {
    state.transactionKind = kind;
    state.transactionWitness = null;
    state.retentionUsed = false;
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
    withTenant: jest.fn(transaction),
    withTenantUser: jest.fn((_t: string, _u: string, fn: any) => transaction(_t, fn, 'user')),
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
  const ports = { prisma, approvals, tenant, memory };
  const service = receiverFactory?.(ports) ?? {
    nativeApproved: (req: any, ctx: any, raw: unknown, mode: 'execute' | 'read') =>
      receiveNativeMemory(ports, req, ctx, raw, mode),
  };
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
    ports,
    req,
    body,
    candidateWriteCount: () =>
      tx.$executeRaw.mock.calls.filter(([sql]: [TemplateStringsArray]) =>
        sql.join('?').includes('INSERT INTO memory_candidate'),
      ).length,
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
