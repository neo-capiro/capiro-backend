import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  assertMeriServerReadonlyCaptureCurrentAuthority,
  currentCaptureAuthorityRows,
  meriReadonlyCaptureCatalogSha256,
} from './meri-server-readonly-capture.js';
import {
  assertRateEvidence,
  type ReviewedCaptureProviderRates,
} from './meri-capture-provider-budget-install.js';
import {
  admitSyntheticReadProviderBudget,
  readSyntheticReadProviderBudget,
  reserveSyntheticReadProviderAttempt,
  settleSyntheticReadProviderAttempt,
  syntheticReadBudgetHash,
  validateSyntheticReadBudgetQualification,
  type SyntheticReadProviderBudgetQualification,
  type SyntheticReadProviderSettlement,
} from './meri-synthetic-read-budget.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fail = (reason: string): never => {
  throw new Error(`meri_synthetic_read_budget_${reason}`);
};
const hashText = (v: string) => createHash('sha256').update(v).digest('hex');
const scoped = (tx: Prisma.TransactionClient) =>
  ({
    withTenant: async (_id: string, work: (value: Prisma.TransactionClient) => unknown) => work(tx),
  }) as unknown as PrismaService;

async function lockOwner(tx: Prisma.TransactionClient, ctx: TenantContext, conversationId: string) {
  if (ctx.role !== 'standard_user') fail('ordinary_actor_required');
  await tx.$queryRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
  const members = await tx.$queryRaw<
    Array<{ role: string; status: string }>
  >`SELECT role::text AS role,status::text AS status FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  if (members.length !== 1 || members[0]!.role !== ctx.role || members[0]!.status !== 'active')
    fail('ordinary_actor_required');
  const rows = await tx.$queryRaw<Array<{ metadata: unknown; clientId: string | null }>>`
    SELECT metadata_jsonb AS metadata, client_id AS "clientId" FROM clio_conversations
    WHERE id=${conversationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid
      AND archived_at IS NULL FOR UPDATE`;
  if (rows.length !== 1 || !rows[0]!.clientId) fail('owned_conversation_missing');
  const row = rows[0]!;
  await tx.$queryRaw`SELECT id FROM clients WHERE id=${row.clientId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE client_id=${row.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
  await currentCaptureAuthorityRows(scoped(tx), ctx, conversationId);
  return { metadata: record(row.metadata), clientId: row.clientId };
}
async function write(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  conversationId: string,
  metadata: unknown,
) {
  const json = JSON.stringify(metadata);
  const n = await tx.$executeRaw`UPDATE clio_conversations SET metadata_jsonb=${json}::jsonb
    WHERE id=${conversationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND archived_at IS NULL`;
  if (n !== 1) fail('write_missing');
}
function policyForInstall(
  q: SyntheticReadProviderBudgetQualification,
  ctx: TenantContext,
): MeriServerReadonlyCapturePolicy {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: randomUUID(),
    requestId: randomUUID(),
    traceId: randomUUID(),
    turnId: null,
    caseId: null,
    captureRunId: null,
    fixtureVersion: null,
    physicalMapSha256: null,
    resetReceiptId: null,
    seedReceiptId: null,
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug as 'meri-foundation-20260928-t1',
    actorUserId: ctx.userId,
    conversationId: q.conversationId,
    clientId: q.clientId,
    issuedAt: Date.now(),
    expiresAt: Date.parse(q.deadlineAt),
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
    ],
    syntheticReadBudget: {
      version: 1,
      kind: 'synthetic_read_budget_only',
      caseId: q.caseId as '01',
      captureRunId: q.captureRunId,
      aggregateReservationId: q.aggregateReservationId,
      qualificationSha256: syntheticReadBudgetHash(q),
    },
  };
}

/** Internal operator only, no controller. One empty owned conversation, absent-key
 * CAS, independently reviewed rate sheet. Never edits tenant fixture authority. */
export async function installSyntheticReadBudget(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  qualification: SyntheticReadProviderBudgetQualification;
  rateEvidence: ReviewedCaptureProviderRates;
}) {
  const q = structuredClone(args.qualification),
    policy = policyForInstall(q, args.ctx);
  validateSyntheticReadBudgetQualification(q, policy);
  assertRateEvidence(args.rateEvidence, q);
  if (policy.expiresAt <= Date.now() || policy.expiresAt > Date.now() + 30 * 60_000)
    fail('deadline_invalid');
  return args.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => {
    const row = await lockOwner(tx, args.ctx, q.conversationId);
    if (
      row.clientId !== q.clientId ||
      [
        'syntheticReadBudgetQualification',
        'syntheticReadProviderBudget',
        'serverCaptureProviderBudget',
        'governedArtifactProviderBudget',
        'governedArtifactCaptureBinding',
      ].some((k) => row.metadata[k] !== undefined)
    )
      fail('binding_exists');
    const messages = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM clio_messages WHERE conversation_id=${q.conversationId}::uuid LIMIT 1`;
    if (messages.length) fail('conversation_not_empty');
    await write(tx, args.ctx, q.conversationId, {
      ...row.metadata,
      syntheticReadBudgetQualification: q,
    });
    return {
      kind: 'synthetic_read_budget_installed',
      qualificationSha256: syntheticReadBudgetHash(q),
      conversationId: q.conversationId,
      captureAuthority: false as const,
    };
  });
}

type Operation =
  | { kind: 'admit'; prompt?: string }
  | { kind: 'read' }
  | { kind: 'reserve'; binding: ResearchProviderReservationBinding }
  | { kind: 'settle'; input: SyntheticReadProviderSettlement }
  | { kind: 'finish'; assistantMessageId: string };
export async function syntheticReadBudgetOwner(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  operation: Operation;
}) {
  const { prisma, ctx, policy, operation } = args;
  if (!policy.syntheticReadBudget) fail('binding_missing');
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const row = await lockOwner(tx, ctx, policy.conversationId),
      metadata = row.metadata;
    await assertMeriServerReadonlyCaptureCurrentAuthority({ prisma: scoped(tx), ctx, policy });
    const q = validateSyntheticReadBudgetQualification(
      metadata.syntheticReadBudgetQualification,
      policy,
    );
    if (metadata.syntheticReadBudgetTerminal && operation.kind !== 'read') fail('already_terminal');
    if (policy.turnId) {
      const turns = await tx.$queryRaw<
        Array<{ id: string; body: string }>
      >`SELECT id,body FROM clio_messages
        WHERE id=${policy.turnId}::uuid AND conversation_id=${policy.conversationId}::uuid AND tenant_id=${ctx.tenantId}::uuid
          AND user_id=${ctx.userId}::uuid AND client_id=${policy.clientId}::uuid AND role='user' FOR SHARE`;
      if (turns.length !== 1 || hashText(turns[0]!.body) !== q.promptSha256)
        fail('owned_turn_missing');
    } else if (operation.kind === 'admit') {
      const turns = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM clio_messages WHERE conversation_id=${policy.conversationId}::uuid LIMIT 1`;
      if (
        turns.length ||
        operation.prompt === undefined ||
        hashText(operation.prompt) !== q.promptSha256
      )
        fail('new_turn_required');
      if (metadata.syntheticReadProviderBudget !== undefined) fail('replay_denied');
    }
    if (operation.kind === 'finish') {
      if (!policy.turnId) fail('turn_unbound');
      const assistants = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM clio_messages
        WHERE id=${operation.assistantMessageId}::uuid AND conversation_id=${policy.conversationId}::uuid
          AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND client_id=${policy.clientId}::uuid AND role='assistant' FOR SHARE`;
      if (assistants.length !== 1) fail('assistant_missing');
      const state =
        readSyntheticReadProviderBudget(metadata, policy, q) ?? fail('admission_missing');
      const allSettled =
        state.ledger.attempts.length > 0 &&
        state.ledger.attempts.every((a) => a.status === 'settled' || a.status === 'rejected');
      const terminal = {
        kind: 'synthetic_read_budget_terminal',
        version: 1,
        policySha256: state.policySha256,
        assistantMessageId: operation.assistantMessageId,
        turnId: policy.turnId,
        completedAt: new Date().toISOString(),
        allAttemptsSettled: allSettled,
        ledgerSha256: syntheticReadBudgetHash(state.ledger),
        chargedCostMicros: state.ledger.chargedCostMicros,
        captureAuthority: false,
      };
      await write(tx, ctx, policy.conversationId, {
        ...metadata,
        syntheticReadBudgetTerminal: terminal,
      });
      return { metadata, state, terminal };
    }
    const result =
      operation.kind === 'admit'
        ? admitSyntheticReadProviderBudget(metadata, policy, q)
        : operation.kind === 'reserve'
          ? reserveSyntheticReadProviderAttempt(metadata, policy, q, operation.binding)
          : operation.kind === 'settle'
            ? settleSyntheticReadProviderAttempt(metadata, policy, q, operation.input)
            : { metadata, state: readSyntheticReadProviderBudget(metadata, policy, q) };
    if (!result.state) fail('admission_missing');
    if (
      operation.kind !== 'read' &&
      syntheticReadBudgetHash(metadata) !== syntheticReadBudgetHash(result.metadata)
    )
      await write(tx, ctx, policy.conversationId, result.metadata);
    return { ...result, state: result.state };
  });
}
