import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, type MeriActionProposal } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  CAPIRO_COMPLIANCE_POLICY_VERSION,
  computeActionFingerprintV2,
} from '@capiro/meriv2-core';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MeriActionProposalService,
  type MeriActionProposalStatus,
} from './meri-action-proposal.service.js';
import type { MeriToolsService } from './meri-tools.service.js';
import type {
  AuthoritativePolicyDecision,
  MeriPolicyPackService,
} from './meri-policy-pack.service.js';
import type { ResearchPortfolioMeriScopeService } from '../research-portfolios/research-portfolio-meri-scope.service.js';
import {
  researchPortfolioProposalFingerprintInput,
  storeResearchPortfolioProposalTurnScope,
} from './meri-rp-proposal-binding.js';

// This suite exercises action authority with the explicit tool/policy doubles
// below; their unrelated Nest dependency graphs are covered in module tests.
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('./meri-policy-pack.service.js', () => ({ MeriPolicyPackService: class {} }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const RP_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const OTHER_RP_CONVERSATION = '55555555-5555-4555-8555-555555555555';
const RP_CLIENT = '66666666-6666-4666-8666-666666666666';
const OTHER_RP_CLIENT = '77777777-7777-4777-8777-777777777777';
const RP_PORTFOLIO = '88888888-8888-4888-8888-888888888888';
const ctx = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user_test',
  role: 'standard_user',
} satisfies TenantContext;

function authoritativeDecision(
  tool: string,
  decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  },
): AuthoritativePolicyDecision {
  const at = new Date('2026-07-27T00:00:00.000Z');
  const channel = /^(?:send_email|reply_email)$/.test(tool) ? 'email' : 'crm';
  return {
    outcome: decision.outcome,
    packId: 'capiro-generic-action-approval',
    packVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    ruleId: decision.ruleId ?? null,
    reason: decision.reasons.join(' ') || 'Policy decision',
    ...(decision.code ? { code: decision.code } : {}),
    ...(decision.tier ? { tier: decision.tier } : {}),
    simulated: false,
    mode: 'off',
    source: 'static',
    verified: true,
    bindable: true,
    policyPackRowId: null,
    binding: 'policy-binding',
    contextHash: 'policy-context-hash',
    decisionHash: 'policy-decision-hash',
    context: {
      tenantId: TENANT,
      actorUserId: USER,
      effectiveUserId: USER,
      actorRole: 'standard_user',
      jurisdiction: 'federal',
      tool,
      channel,
      recipientType: 'unknown',
      at,
      effectiveAt: at,
      contextFlags: { impersonating: false },
    },
  };
}

function makeRow(overrides: Partial<MeriActionProposal> = {}): MeriActionProposal {
  const input = (overrides.input as Record<string, unknown> | undefined) ?? {
    to: 'person@example.com',
    subject: 'Subject',
    body: 'Body',
  };
  const tool = overrides.tool ?? 'send_email';
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    userId: USER,
    actorUserId: null,
    impersonationSessionId: null,
    conversationId: null,
    surface: 'chat',
    tool,
    input,
    fingerprint: computeActionFingerprintV2({
      effectiveTenantId: TENANT,
      userId: USER,
      tool,
      input,
      policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
      policyBinding: 'policy-binding',
      policyDecisionHash: 'policy-decision-hash',
      policyContextHash: 'policy-context-hash',
    }),
    policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    policyPackId: null,
    policyPackKey: 'capiro-generic-action-approval',
    policyPackVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
    policyBinding: 'policy-binding',
    policyDecisionHash: 'policy-decision-hash',
    policyContextHash: 'policy-context-hash',
    policySource: 'static',
    policyMode: 'off',
    policyJurisdiction: 'federal',
    policyChannel: /^(?:send_email|reply_email)$/.test(tool) ? 'email' : 'crm',
    policyRecipientType: 'unknown',
    policyClientId: null,
    policyEffectiveUserId: USER,
    policyEffectiveAt: new Date('2026-07-27T00:00:00.000Z'),
    policyRuleId: 'external_send.requires_approval',
    policyDecision: 'WARN',
    policyCode: 'external_send',
    riskTier: 'restricted',
    preview: {
      label: 'Send email',
      riskTier: 'restricted',
      leavesFirm: true,
      reversible: false,
      fields: { to: 'person@example.com', subject: 'Subject' },
      counts: {},
      reason: 'Approval required',
    },
    status: 'proposed',
    expiresAt: new Date(Date.now() + 60_000),
    approvedAt: null,
    approvedBy: null,
    executionStartedAt: null,
    executedAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    resultSummary: null,
    createdAt: new Date('2026-07-27T00:00:00Z'),
    updatedAt: new Date('2026-07-27T00:00:00Z'),
    ...overrides,
  } as MeriActionProposal;
}

function statusMatches(statusFilter: unknown, status: string): boolean {
  if (typeof statusFilter === 'string') return statusFilter === status;
  if (
    statusFilter &&
    typeof statusFilter === 'object' &&
    Array.isArray((statusFilter as { in?: unknown }).in)
  ) {
    return ((statusFilter as { in: string[] }).in).includes(status);
  }
  return true;
}

function dateMatches(filter: unknown, value: Date | null): boolean {
  if (!filter || typeof filter !== 'object' || !value) return true;
  const range = filter as { gt?: Date; lte?: Date; lt?: Date };
  if (range.gt && !(value > range.gt)) return false;
  if (range.lt && !(value < range.lt)) return false;
  if (range.lte && !(value <= range.lte)) return false;
  return true;
}

function researchPortfolioMetadata() {
  return {
    researchPortfolioScope: {
      kind: 'research_portfolio',
      researchPortfolioId: RP_PORTFOLIO,
      researchPortfolioName: 'Autonomous Systems',
      researchPortfolioRevision: 3,
      scopeVersion: 'a'.repeat(64),
    },
  };
}

function harness(
  options: {
    row?: MeriActionProposal | null;
    forceClaimLoss?: boolean;
    executeResult?: unknown;
    executeError?: unknown;
    scheduleReceipt?: unknown;
    conversation?: {
      id: string;
      tenantId: string;
      userId: string;
      archivedAt: Date | null;
      clientId: string | null;
      metadata: Record<string, unknown>;
    } | null;
    scopeError?: Error;
  } = {},
) {
  let row = options.row === undefined ? makeRow() : options.row;
  let conversation = options.conversation === undefined
    ? {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: null,
        clientId: null,
        metadata: researchPortfolioMetadata(),
      }
    : options.conversation;
  const complianceCreate = jest.fn().mockResolvedValue({ id: 'audit' });
  const execute = options.executeError
    ? jest.fn().mockRejectedValue(options.executeError)
    : jest.fn().mockResolvedValue(options.executeResult ?? { ok: true, id: 'result-1' });
  const validate = jest.fn((_tool: string, input: unknown) =>
    JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>,
  );

  function matches(where: Record<string, unknown>): boolean {
    if (!row) return false;
    if (where.id && where.id !== row.id) return false;
    if (where.tenantId && where.tenantId !== row.tenantId) return false;
    if (where.userId && where.userId !== row.userId) return false;
    if (where.status && !statusMatches(where.status, row.status)) return false;
    if (where.expiresAt && !dateMatches(where.expiresAt, row.expiresAt)) return false;
    if (where.executionStartedAt && !dateMatches(where.executionStartedAt, row.executionStartedAt)) {
      return false;
    }
    return true;
  }

  const tx = {
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      conversation &&
      conversation.id === values[0] &&
      conversation.tenantId === TENANT &&
      conversation.tenantId === values[1] &&
      conversation.userId === USER &&
      conversation.userId === values[2] &&
      conversation.archivedAt === null &&
      conversation.clientId === values[3] &&
      JSON.stringify(conversation.metadata) === values[4]
        ? [{ id: conversation.id }]
        : [],
    ),
    client: { findFirst: jest.fn().mockResolvedValue(null) },
    clioConversation: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        conversation &&
        conversation.id === where.id &&
        conversation.tenantId === where.tenantId &&
        conversation.userId === where.userId &&
        conversation.archivedAt === null
          ? { metadata: conversation.metadata, clientId: conversation.clientId }
          : null,
      ),
    },
    complianceCheck: { create: complianceCreate },
    meriActionProposal: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = makeRow({
          ...(data as Partial<MeriActionProposal>),
          id: PROPOSAL,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? row : null,
      ),
      findFirstOrThrow: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!matches(where) || !row) throw new Error('not found');
        return row;
      }),
      findMany: jest.fn(async () => (row ? [row] : [])),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!matches(where) || !row) return { count: 0 };
          if (options.forceClaimLoss && data.status === 'executing') {
            row = {
              ...row,
              status: 'executing',
              executionStartedAt: new Date(),
            } as MeriActionProposal;
            return { count: 0 };
          }
          const next: Record<string, unknown> = { ...row };
          for (const [key, value] of Object.entries(data)) {
            if (value === undefined) continue;
            if (value && typeof value === 'object' && 'increment' in value) {
              next[key] =
                Number(next[key] ?? 0) + Number((value as { increment: number }).increment);
            } else {
              next[key] = value;
            }
          }
          next.updatedAt = new Date();
          row = next as unknown as MeriActionProposal;
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = {
    withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const tools = {
    validateSideEffectingInput: validate,
    executeFromAuthenticatedUser: execute,
    readScheduleTaskReceipt: jest.fn().mockResolvedValue(options.scheduleReceipt ?? null),
  } as unknown as MeriToolsService;
  const config = {
    get: (key: string) =>
      key === 'MERIV2_ACTION_PROPOSALS_ENABLED'
        ? true
        : key === 'MERIV2_ACTION_PROPOSAL_TTL_MINUTES'
          ? 15
          : undefined,
  } as unknown as ConfigService<AppConfig, true>;
  const defaultPolicy = {
    outcome: 'WARN' as const,
    reasons: ['Requires approval'],
    code: 'external_send',
    tier: 'restricted' as const,
    ruleId: 'external_send.requires_approval',
  };
  const policyPacks = {
    decideForAction: jest.fn(async (_ctx: TenantContext, tool: string) =>
      authoritativeDecision(tool, defaultPolicy),
    ),
    recordDecisionInTx: jest.fn().mockResolvedValue(undefined),
  } as unknown as MeriPolicyPackService;
  const authorizeScope = options.scopeError
    ? jest.fn().mockRejectedValue(options.scopeError)
    : jest.fn().mockResolvedValue({ researchPortfolioId: RP_PORTFOLIO });
  const researchPortfolioScopes = {
    authorize: authorizeScope,
  } as unknown as ResearchPortfolioMeriScopeService;
  const service = new MeriActionProposalService(
    prisma,
    tools,
    config,
    policyPacks,
    researchPortfolioScopes,
  );
  const setPolicy = (decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  }) => {
    (policyPacks.decideForAction as jest.Mock).mockImplementation(
      async (_ctx: TenantContext, tool: string) => authoritativeDecision(tool, decision),
    );
  };
  return {
    service,
    tx,
    tools: {
      execute,
      validate,
      readScheduleTaskReceipt: (tools as unknown as {
        readScheduleTaskReceipt: jest.Mock;
      }).readScheduleTaskReceipt,
    },
    policyPacks,
    authorizeScope,
    getRow: () => row,
    setConversation: (next: typeof conversation) => {
      conversation = next;
    },
    setPolicy,
  };
}

describe('MeriActionProposalService', () => {
  it('keeps a confirmed client note receipt without exposing its body', async () => {
    const h = harness({ row: null, executeResult: { tool: 'save_note', status: 'saved',
      note: { id: 'note-1', clientId: TENANT, title: 'Engagement notes', body: 'Private note body' },
      documentId: 'note-1', clientId: TENANT, clientName: 'Sightline',
      location: `/clients?clientId=${TENANT}&tab=documents`, indexingStatus: 'pending' } });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, { tool: 'save_note', input: { body: 'Private note body', clientId: TENANT }, surface: 'chat' });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.resultSummary).toMatchObject({ tool: 'save_note', status: 'saved',
      documentId: 'note-1', clientName: 'Sightline', note: { id: 'note-1' } });
    expect(JSON.stringify(result.proposal.resultSummary)).not.toContain('Private note body');
  });

  it('does not treat a resolved promise without a durable save receipt as success', async () => {
    const h = harness({ row: null, executeResult: { ok: true } });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, { tool: 'save_note', input: { body: 'Notes' }, surface: 'chat' });
    expect(result.disposition).toBe('failed');
    expect(result.proposal.status).toBe('outcome_unknown');
    expect(result.proposal.error?.code).toBe('client_filing_receipt_missing');
  });

  it.each(['create', 'approve'] as const)('preserves a partial batch and its retry state through %s', async (path) => {
    const input = { clientId: TENANT, conversationId: PROPOSAL, attachmentIds: [USER, PROPOSAL] };
    const h = harness({ row: path === 'approve' ? makeRow({ tool: 'save_chat_attachments', input }) : null,
      executeResult: { tool: 'save_chat_attachments', status: 'partial', clientId: TENANT, clientName: 'Sightline',
        savedCount: 1, pendingCount: 0, failedCount: 1,
        files: [{ attachmentId: USER, fileName: 'letter.docx', status: 'saved', documentId: 'doc-1' },
          { attachmentId: PROPOSAL, fileName: 'brief.pdf', status: 'failed', reason: 'Try again' }] } });
    h.setPolicy({ outcome: path === 'approve' ? 'WARN' : 'PASS', reasons: ['File documents'] });
    const result = path === 'approve' ? await h.service.approveAndExecute(ctx, PROPOSAL)
      : (await h.service.create(ctx, { tool: 'save_chat_attachments', input, surface: 'chat' })).proposal;
    expect(result.status).toBe('failed_retryable');
    expect(result.resultSummary).toMatchObject({ status: 'partial', savedCount: 1, failedCount: 1, files: [
      expect.objectContaining({ documentId: 'doc-1', status: 'saved' }), expect.objectContaining({ status: 'failed' }),
    ] });
  });

  it('retains processing state when all original files are stored but some scans are pending', async () => {
    const h = harness({ row: null, executeResult: { tool: 'save_chat_attachments', status: 'partial', clientId: TENANT,
      files: [{ attachmentId: USER, status: 'saved', documentId: 'd1' }, { attachmentId: PROPOSAL, status: 'pending', documentId: 'd2' }] } });
    h.setPolicy({ outcome: 'PASS', reasons: ['File documents'] });
    const result = await h.service.create(ctx, { tool: 'save_chat_attachments', input: {}, surface: 'chat' });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.resultSummary).toMatchObject({ status: 'partial', files: [
      expect.objectContaining({ status: 'saved' }), expect.objectContaining({ status: 'pending' }),
    ] });
  });

  it('creates the trusted fingerprint, policy, tenant, user, and expiry server-side', async () => {
    const h = harness({ row: null });
    h.setPolicy({
      outcome: 'WARN',
      reasons: ['Requires approval'],
      code: 'external_send',
      tier: 'restricted',
      ruleId: 'external_send.requires_approval',
    });
    const result = await h.service.create(ctx, {
      tool: 'send_email',
      input: { to: 'person@example.com', subject: 'Subject', body: 'Body' },
      surface: 'chat',
      // Runtime attacker properties are ignored by the service and rejected by the DTO at HTTP.
      fingerprint: 'f'.repeat(64),
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as never);
    const stored = h.getRow()!;
    expect(result.disposition).toBe('pending_approval');
    if (result.disposition !== 'pending_approval') {
      throw new Error('expected pending approval');
    }
    expect(result.proposal.proposalId).toBe(PROPOSAL);
    expect(stored.tenantId).toBe(TENANT);
    expect(stored.userId).toBe(USER);
    expect(stored.fingerprint).not.toBe('f'.repeat(64));
    expect(stored.policyVersion).toBe(CAPIRO_COMPLIANCE_POLICY_VERSION);
    expect(stored.status).toBe('proposed');
    expect(h.tx.complianceCheck.create).toHaveBeenCalledTimes(1);
  });

  it('blocks changed stored payloads because the fingerprint no longer matches', async () => {
    const original = makeRow();
    const tampered = {
      ...original,
      input: { ...(original.input as object), body: 'Changed after review' },
    } as MeriActionProposal;
    const h = harness({ row: tampered });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('fingerprint_mismatch');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('blocks a stored tool that no longer matches its fingerprint', async () => {
    const original = makeRow();
    const tamperedTool = { ...original, tool: 'reply_email' } as MeriActionProposal;
    const h = harness({ row: tamperedTool });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('fingerprint_mismatch');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rechecks current policy and blocks a WARN proposal that is now BLOCK', async () => {
    const h = harness();
    h.setPolicy({
      outcome: 'BLOCK',
      reasons: ['Policy now blocks this action'],
      code: 'new_block',
    });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('policy_binding_changed');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('expires without execution', async () => {
    const h = harness({ row: makeRow({ expiresAt: new Date(Date.now() - 1000) }) });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('expired');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  // This simulates ONLY the losing side's outcome (forceClaimLoss hardcodes the
  // mocked updateMany to return count:0) — it does not fire two concurrent
  // requests, so it doesn't itself prove the claim is atomic. That guarantee
  // rests on the real code issuing a single Postgres UPDATE with a
  // status-in-claimable WHERE guard (meri-action-proposal.service.ts's claim
  // step), which is atomic under Postgres row-level locking regardless of
  // this test; what this test proves is that a lost claim correctly reads
  // back the winner's state and skips execution.
  it('loses a double-click claim without executing twice', async () => {
    const h = harness({ forceClaimLoss: true });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('executing');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('executes the exact stored canonical payload and records succeeded separately from approval', async () => {
    const row = makeRow({
      tool: 'update_client_profile',
      input: { clientId: TENANT, name: 'Acme' },
      policyChannel: 'crm',
    });
    const h = harness({ row, executeResult: { ok: true, clientId: TENANT } });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(h.tools.execute).toHaveBeenCalledWith(ctx, 'update_client_profile', row.input, {
      actionProposalId: PROPOSAL,
    });
    expect(result.status).toBe('succeeded');
    expect(result.attemptCount).toBe(1);
  });

  it('classifies an ambiguous external-send error as outcome_unknown and not retryable', async () => {
    const h = harness({ executeError: new Error('socket closed after provider request') });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('outcome_unknown');
    expect(result.error?.code).toBe('external_outcome_unknown');
  });

  it('keeps an ambiguous schedule acknowledgement non-retryable with the same proposal id', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({ tool: 'schedule_task', input }),
      executeError: new Error('connection reset after commit acknowledgement was lost'),
    });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });

    const first = await h.service.approveAndExecute(ctx, PROPOSAL);
    const reconnected = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(first.status).toBe('outcome_unknown');
    expect(first.error?.code).toBe('schedule_task_outcome_unknown');
    expect(reconnected.status).toBe('outcome_unknown');
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    expect(h.tools.execute).toHaveBeenCalledWith(ctx, 'schedule_task', input, {
      actionProposalId: PROPOSAL,
    });
  });

  it('GET/list recovers a stale unknown schedule from read-only durable receipt evidence', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({
        tool: 'schedule_task',
        input,
        status: 'executing',
        executionStartedAt: new Date(Date.now() - 10 * 60_000),
      }),
      scheduleReceipt: {
        id: PROPOSAL,
        name: 'Watch',
        intervalMinutes: 60,
        nextRunAt: new Date('2026-09-29T00:00:00.000Z'),
        enabled: true,
        lastStatus: null,
        active: true,
        creationConfirmed: true,
      },
    });

    const [result] = await h.service.list(ctx);

    expect(result?.status).toBe('succeeded');
    expect(result?.resultSummary).toMatchObject({
      tool: 'schedule_task',
      scheduled: true,
      reconciled: true,
      task: { id: PROPOSAL },
    });
    expect(h.tools.readScheduleTaskReceipt).toHaveBeenCalledWith(ctx, PROPOSAL, input);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('GET/list records canceled receipt evidence as historical creation, not an active task', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({
        tool: 'schedule_task',
        input,
        status: 'outcome_unknown',
      }),
      scheduleReceipt: {
        id: PROPOSAL,
        name: 'Watch',
        intervalMinutes: 60,
        nextRunAt: new Date('2026-09-29T00:00:00.000Z'),
        enabled: false,
        lastStatus: 'canceled',
        active: false,
        creationConfirmed: true,
      },
    });

    const [result] = await h.service.list(ctx);

    expect(result?.status).toBe('succeeded');
    expect(result?.resultSummary).toMatchObject({
      tool: 'schedule_task',
      scheduled: false,
      active: false,
      creationConfirmed: true,
      reconciled: true,
      task: {
        id: PROPOSAL,
        enabled: false,
        lastStatus: 'canceled',
        active: false,
        creationConfirmed: true,
      },
    });
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('GET/list leaves a stale unknown schedule unchanged when receipt evidence is absent', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({
        tool: 'schedule_task',
        input,
        status: 'executing',
        executionStartedAt: new Date(Date.now() - 10 * 60_000),
      }),
    });

    const [result] = await h.service.list(ctx);

    expect(result?.status).toBe('outcome_unknown');
    expect(result?.error?.code).toBe('stale_execution');
    expect(h.tools.readScheduleTaskReceipt).toHaveBeenCalledTimes(1);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('GET/list refuses receipt visibility when the proposal policy-bound fingerprint is invalid', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({
        tool: 'schedule_task',
        input,
        fingerprint: '0'.repeat(64),
        status: 'outcome_unknown',
      }),
      scheduleReceipt: {
        id: PROPOSAL,
        name: 'Watch',
        intervalMinutes: 60,
        nextRunAt: new Date('2026-09-29T00:00:00.000Z'),
      },
    });

    const [result] = await h.service.list(ctx);

    expect(result?.status).toBe('outcome_unknown');
    expect(h.tools.readScheduleTaskReceipt).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['reply_email', { error: 'Thread not found.' }, 'reply_email_failed'],
    [
      'schedule_task',
      { tool: 'schedule_task', scheduled: false, error: 'The interval is invalid.' },
      'schedule_task_rejected',
    ],
    [
      'cancel_scheduled_task',
      { tool: 'cancel_scheduled_task', canceled: false, error: 'Task not found.' },
      'cancel_scheduled_task_rejected',
    ],
  ])('classifies resolved %s handler errors as terminal failures', async (tool, executeResult, code) => {
    const input = tool === 'reply_email'
      ? { threadId: 'thread-1', body: 'Reply' }
      : tool === 'schedule_task'
        ? { name: 'Watch', prompt: 'Check', intervalMinutes: 60 }
        : { taskId: 'task-1' };
    const h = harness({ row: makeRow({ tool, input }), executeResult });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('failed_terminal');
    expect(result.error?.code).toBe(code);
    expect(result.resultSummary).toMatchObject(executeResult);
  });

  it.each([
    ['reply_email', { ok: true, sentFrom: 'me@example.com', to: 'you@example.com', subject: 'Re: Hi' }],
    ['schedule_task', { tool: 'schedule_task', scheduled: true, task: { id: 'task-1' } }],
    ['cancel_scheduled_task', { tool: 'cancel_scheduled_task', canceled: true, taskId: 'task-1' }],
  ])('accepts the confirmed %s handler receipt', async (tool, executeResult) => {
    const h = harness({ row: makeRow({ tool }), executeResult });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe('succeeded');
  });

  it('accepts a historical canceled creation receipt without claiming it remains scheduled', async () => {
    const input = { name: 'Watch', prompt: 'Check', intervalMinutes: 60 };
    const h = harness({
      row: makeRow({ tool: 'schedule_task', input }),
      executeResult: {
        tool: 'schedule_task',
        scheduled: false,
        active: false,
        creationConfirmed: true,
        task: {
          id: PROPOSAL,
          enabled: false,
          lastStatus: 'canceled',
          active: false,
          creationConfirmed: true,
        },
      },
    });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('succeeded');
    expect(result.resultSummary).toMatchObject({
      scheduled: false,
      active: false,
      creationConfirmed: true,
      task: { id: PROPOSAL, enabled: false, lastStatus: 'canceled', active: false },
    });
  });

  it('retains an acknowledged reply receipt when only artifact persistence failed', async () => {
    const executeResult = {
      ok: true,
      sentFrom: 'me@example.com',
      to: 'you@example.com',
      subject: 'Re: Hi',
      sendReceipt: {
        provider: 'gmail',
        providerMessageId: 'message-1',
        providerThreadId: 'thread-1',
        correlationId: 'correlation-1',
      },
      artifactPersistence: {
        persisted: false,
        error: 'Tool clientId does not match the Meri conversation client',
      },
    };
    const h = harness({
      row: makeRow({ tool: 'reply_email', input: { threadId: 'thread-1', body: 'Reply' } }),
      executeResult,
    });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('succeeded');
    expect(result.resultSummary).toMatchObject({
      sendReceipt: {
        provider: 'gmail',
        providerMessageId: 'message-1',
        correlationId: 'correlation-1',
      },
      artifactPersistence: {
        persisted: false,
        error: 'Tool clientId does not match the Meri conversation client',
      },
    });
  });

  it('classifies safe internal transient errors as failed_retryable', async () => {
    const row = makeRow({
      tool: 'update_client_profile',
      input: { clientId: TENANT, name: 'Acme' },
      policyChannel: 'crm',
    });
    const h = harness({ row, executeError: new Error('temporarily unavailable') });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe(
      'failed_retryable',
    );
  });

  it('classifies a genuine validation failure as failed_terminal, never succeeded', async () => {
    const row = makeRow({
      tool: 'update_client_profile',
      input: { clientId: TENANT, name: 'Acme' },
      policyChannel: 'crm',
    });
    const h = harness({ row, executeError: new Error('validation failed: clientId not found') });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('failed_terminal');
    expect(result.status).not.toBe('succeeded');
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });

  it('does not reveal or execute another user or tenant proposal', async () => {
    const h = harness();
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    await expect(
      h.service.approveAndExecute(
        { ...ctx, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        PROPOSAL,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.approveAndExecute(
        { ...ctx, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        PROPOSAL,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each<MeriActionProposalStatus>([
    'succeeded',
    'failed_terminal',
    'outcome_unknown',
    'blocked',
    'dismissed',
    'expired',
  ])('never re-executes terminal status %s', async (status) => {
    const h = harness({ row: makeRow({ status }) });
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe(status);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  // Phase I self-review: dismiss() had zero coverage anywhere in the suite
  // (an HTTP-level test only ever defined a jest.fn() mock for it, never
  // called it). These exercise the real state-machine guard directly.
  it('dismiss: transitions a proposed proposal to dismissed and records a decision', async () => {
    const h = harness();
    const result = await h.service.dismiss(ctx, PROPOSAL);
    expect(result.status).toBe('dismissed');
    expect(h.tx.complianceCheck.create).toHaveBeenCalledTimes(1);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('dismiss: is a no-op against an already-executing proposal (cannot un-execute)', async () => {
    const h = harness({ row: makeRow({ status: 'executing' }) });
    const result = await h.service.dismiss(ctx, PROPOSAL);
    expect(result.status).toBe('executing');
    expect(h.tx.complianceCheck.create).not.toHaveBeenCalled();
  });

  it.each<MeriActionProposalStatus>([
    'succeeded',
    'failed_terminal',
    'dismissed',
    'expired',
  ])(
    'dismiss: is a no-op against terminal status %s (cannot resurrect it)',
    async (status) => {
      const h = harness({ row: makeRow({ status }) });
      const result = await h.service.dismiss(ctx, PROPOSAL);
      expect(result.status).toBe(status);
      expect(h.tx.complianceCheck.create).not.toHaveBeenCalled();
    },
  );

  it('dismiss: does not reveal or affect another user or tenant proposal', async () => {
    const h = harness();
    await expect(
      h.service.dismiss(
        { ...ctx, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        PROPOSAL,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.dismiss(
        { ...ctx, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        PROPOSAL,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.getRow()?.status).toBe('proposed');
  });
});

describe('MeriActionProposalService — Research Portfolio conversation binding', () => {
  const snapshotInput = {
    conversationId: RP_CONVERSATION,
    operationKey: 'snapshot:scope-test',
    name: 'Scope test',
    expectedRevision: 3,
  };

  function rpRow(
    overrides: Partial<MeriActionProposal> = {},
    selectedClientId: string | null = null,
  ) {
    const input = (overrides.input ?? snapshotInput) as Record<string, unknown>;
    const scope = { conversationId: RP_CONVERSATION, selectedClientId };
    const row = makeRow({
      tool: 'create_research_portfolio_snapshot',
      input: input as MeriActionProposal['input'],
      conversationId: RP_CONVERSATION,
      policyChannel: 'crm',
      preview: storeResearchPortfolioProposalTurnScope(
        'create_research_portfolio_snapshot',
        makeRow().preview as Record<string, unknown>,
        scope,
      ) as MeriActionProposal['preview'],
      ...overrides,
    });
    if (!overrides.fingerprint) {
      row.fingerprint = computeActionFingerprintV2({
        effectiveTenantId: TENANT,
        userId: USER,
        tool: row.tool,
        input: researchPortfolioProposalFingerprintInput(row.tool, input, scope),
        policyVersion: row.policyPackVersion,
        policyBinding: row.policyBinding,
        policyDecisionHash: row.policyDecisionHash,
        policyContextHash: row.policyContextHash,
      });
    }
    return row;
  }

  it.each([
    ['PASS', 'executed', 'succeeded', 1],
    ['WARN', 'pending_approval', 'proposed', 0],
    ['BLOCK', 'blocked', 'blocked', 0],
  ] as const)(
    'binds and authorizes an RP %s proposal before its lifecycle disposition',
    async (outcome, disposition, status, executions) => {
      const h = harness({ row: null });
      h.setPolicy({ outcome, reasons: [`${outcome} RP action`] });

      const result = await h.service.create(
        ctx,
        {
          tool: 'create_research_portfolio_snapshot',
          input: {
            operationKey: snapshotInput.operationKey,
            name: snapshotInput.name,
            expectedRevision: snapshotInput.expectedRevision,
          },
          conversationId: RP_CONVERSATION,
          surface: 'chat',
        },
        { conversationId: RP_CONVERSATION, selectedClientId: null },
      );

      expect(result.disposition).toBe(disposition);
      expect(result.proposal.status).toBe(status);
      expect(h.getRow()?.conversationId).toBe(RP_CONVERSATION);
      expect(h.getRow()?.input).toMatchObject({ conversationId: RP_CONVERSATION });
      expect(h.getRow()?.preview).toMatchObject({
        __meriRpCurrentTurnScope: {
          version: 1,
          conversationId: RP_CONVERSATION,
          selectedClientId: null,
        },
      });
      expect(JSON.stringify(result.proposal.preview)).not.toContain('__meriRpCurrentTurnScope');
      expect(h.tools.validate).toHaveBeenCalledWith(
        'create_research_portfolio_snapshot',
        snapshotInput,
      );
      expect(h.authorizeScope).toHaveBeenCalledTimes(2);
      expect(h.tools.execute).toHaveBeenCalledTimes(executions);
    },
  );

  it('accepts an exact inner/outer RP conversation binding', async () => {
    const h = harness({ row: null });
    h.setPolicy({ outcome: 'WARN', reasons: ['Review snapshot'] });

    await h.service.create(
      ctx,
      {
        tool: 'create_research_portfolio_snapshot',
        input: snapshotInput,
        conversationId: RP_CONVERSATION,
        surface: 'chat',
      },
      { conversationId: RP_CONVERSATION, selectedClientId: null },
    );

    expect(h.policyPacks.decideForAction).toHaveBeenCalledWith(
      ctx,
      'create_research_portfolio_snapshot',
      snapshotInput,
    );
  });

  it('rejects a different owned inner conversation before validation, policy, persistence, or execution', async () => {
    const h = harness({ row: null });

    await expect(
      h.service.create(
        ctx,
        {
          tool: 'create_research_portfolio_snapshot',
          input: { ...snapshotInput, conversationId: OTHER_RP_CONVERSATION },
          conversationId: RP_CONVERSATION,
          surface: 'chat',
        },
        { conversationId: RP_CONVERSATION, selectedClientId: null },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(h.tools.validate).not.toHaveBeenCalled();
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tx.meriActionProposal.create).not.toHaveBeenCalled();
    expect(h.tx.clioConversation.findFirst).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the RP proposal has no outer conversation', async () => {
    const h = harness({ row: null });
    await expect(
      h.service.create(
        ctx,
        {
          tool: 'create_research_portfolio_snapshot',
          input: snapshotInput,
          surface: 'chat',
        },
        { conversationId: RP_CONVERSATION, selectedClientId: null },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tools.validate).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects an RP create without trusted transport scope before validation or policy', async () => {
    const h = harness({ row: null });
    await expect(
      h.service.create(ctx, {
        tool: 'create_research_portfolio_snapshot',
        input: snapshotInput,
        conversationId: RP_CONVERSATION,
        surface: 'chat',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tools.validate).not.toHaveBeenCalled();
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tx.meriActionProposal.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['foreign-owned', {
      id: RP_CONVERSATION,
      tenantId: TENANT,
      userId: OTHER_RP_CLIENT,
      archivedAt: null,
      clientId: null,
      metadata: researchPortfolioMetadata(),
    }],
    ['archived', {
      id: RP_CONVERSATION,
      tenantId: TENANT,
      userId: USER,
      archivedAt: new Date(),
      clientId: null,
      metadata: researchPortfolioMetadata(),
    }],
  ] as const)('rejects a %s current RP conversation before policy or execution', async (_label, conversation) => {
    const h = harness({ row: null, conversation: conversation as never });
    await expect(
      h.service.create(
        ctx,
        {
          tool: 'create_research_portfolio_snapshot',
          input: snapshotInput,
          conversationId: RP_CONVERSATION,
          surface: 'chat',
        },
        { conversationId: RP_CONVERSATION, selectedClientId: null },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tx.meriActionProposal.create).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['stale scope', new BadRequestException('Research portfolio scope is stale')],
    ['ethical wall', new NotFoundException('Research portfolio is blocked by an ethical wall')],
  ])('reauthorizes current RP membership at approval/retry and rejects %s', async (_label, error) => {
    const h = harness({
      row: rpRow({ status: 'failed_retryable', attemptCount: 1 }),
      scopeError: error,
    });

    await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBe(error);
    expect(h.getRow()?.status).toBe('failed_retryable');
    expect(h.getRow()?.attemptCount).toBe(1);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rechecks that the stored RP conversation is still owned and unarchived before approval', async () => {
    const h = harness({
      row: rpRow(),
      conversation: {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: new Date(),
        clientId: null,
        metadata: researchPortfolioMetadata(),
      },
    });

    await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.getRow()?.status).toBe('proposed');
    expect(h.getRow()?.attemptCount).toBe(0);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects a changed current conversation client against the stored selected client', async () => {
    const input = {
      conversationId: RP_CONVERSATION,
      outputId: PROPOSAL,
      clientId: RP_CLIENT,
      operationKey: 'save-output:1',
    };
    const h = harness({
      row: rpRow(
        {
          tool: 'save_research_portfolio_output_to_client',
          input,
          conversationId: RP_CONVERSATION,
          policyClientId: RP_CLIENT,
        },
        RP_CLIENT,
      ),
      conversation: {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: null,
        clientId: OTHER_RP_CLIENT,
        metadata: researchPortfolioMetadata(),
      },
    });

    await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.getRow()?.status).toBe('proposed');
    expect(h.getRow()?.attemptCount).toBe(0);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    [null, RP_CLIENT],
    [RP_CLIENT, null],
  ])(
    'rejects selected-client drift from %s to %s before policy or execution',
    async (selectedClientId, currentClientId) => {
      const h = harness({
        row: rpRow({}, selectedClientId),
        conversation: {
          id: RP_CONVERSATION,
          tenantId: TENANT,
          userId: USER,
          archivedAt: null,
          clientId: currentClientId,
          metadata: researchPortfolioMetadata(),
        },
      });

      await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.getRow()?.status).toBe('proposed');
      expect(h.getRow()?.attemptCount).toBe(0);
      expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
      expect(h.tools.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ ...snapshotInput, conversationId: OTHER_RP_CONVERSATION }, RP_CONVERSATION, 'stored_input_invalid'],
    [snapshotInput, OTHER_RP_CONVERSATION, 'stored_scope_invalid'],
    [{ operationKey: 'legacy-without-conversation' }, RP_CONVERSATION, 'stored_input_invalid'],
  ])('blocks an inconsistent stored RP row without retargeting or execution', async (input, conversationId, code) => {
    const h = harness({ row: rpRow({ input, conversationId }) });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe(code);
    expect(result.attemptCount).toBe(0);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('blocks a legacy RP row with no persisted trusted turn scope', async () => {
    const h = harness({ row: rpRow({ preview: makeRow().preview }) });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('stored_scope_invalid');
    expect(result.attemptCount).toBe(0);
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('retains a truthful known unknown-effect receipt without reauthorization or resend', async () => {
    const receipt = { status: 'accepted', operationKey: 'snapshot:unknown' };
    const h = harness({
      row: rpRow({
        input: { ...snapshotInput, conversationId: OTHER_RP_CONVERSATION },
        status: 'outcome_unknown',
        attemptCount: 1,
        resultSummary: receipt,
      }),
    });

    const result = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(result.status).toBe('outcome_unknown');
    expect(result.resultSummary).toEqual(receipt);
    expect(h.authorizeScope).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('does not make the guarded future manage tool executable without canonical support', async () => {
    const h = harness({ row: null });
    h.tools.validate.mockImplementationOnce(() => {
      throw new BadRequestException('Unknown Meri tool: manage_research_portfolio');
    });

    await expect(
      h.service.create(
        ctx,
        {
          tool: 'manage_research_portfolio',
          input: {},
          conversationId: RP_CONVERSATION,
          surface: 'chat',
        },
        { conversationId: RP_CONVERSATION, selectedClientId: null },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.authorizeScope).not.toHaveBeenCalled();
    expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['creation', false],
    ['approval', true],
  ] as const)('rejects RP %s when selected client changes during awaited policy', async (_label, approval) => {
    const conversation = {
      id: RP_CONVERSATION,
      tenantId: TENANT,
      userId: USER,
      archivedAt: null,
      clientId: RP_CLIENT,
      metadata: researchPortfolioMetadata(),
    };
    const h = harness({ row: approval ? rpRow({}, RP_CLIENT) : null, conversation });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.policyPacks.decideForAction = jest.fn(async () => {
      entered();
      await waiting;
      return authoritativeDecision('create_research_portfolio_snapshot', {
        outcome: 'WARN',
        reasons: ['Review snapshot'],
      });
    });
    const action = approval
      ? h.service.approveAndExecute(ctx, PROPOSAL)
      : h.service.create(
          ctx,
          {
            tool: 'create_research_portfolio_snapshot',
            input: snapshotInput,
            conversationId: RP_CONVERSATION,
            surface: 'chat',
          },
          { conversationId: RP_CONVERSATION, selectedClientId: RP_CLIENT },
        );
    await started;
    h.setConversation({ ...conversation, clientId: null });
    release();

    await expect(action).rejects.toBeInstanceOf(BadRequestException);
    expect(h.getRow()?.status ?? null).toBe(approval ? 'proposed' : null);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['grant', new BadRequestException('Research Portfolio grant was revoked')],
    ['ethical wall', new NotFoundException('Research Portfolio is blocked')],
  ])('rejects approval when the late RP %s check fails after policy', async (_label, error) => {
    const h = harness({ row: rpRow() });
    h.authorizeScope.mockResolvedValueOnce({ researchPortfolioId: RP_PORTFOLIO });
    h.authorizeScope.mockRejectedValueOnce(error);

    await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBe(error);
    expect(h.getRow()?.status).toBe('proposed');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects approval when the conversation is archived during the late grant check', async () => {
    const conversation = {
      id: RP_CONVERSATION,
      tenantId: TENANT,
      userId: USER,
      archivedAt: null,
      clientId: null,
      metadata: researchPortfolioMetadata(),
    };
    const h = harness({ row: rpRow(), conversation });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.authorizeScope
      .mockResolvedValueOnce({ researchPortfolioId: RP_PORTFOLIO })
      .mockImplementationOnce(async () => {
        entered();
        await waiting;
        return { researchPortfolioId: RP_PORTFOLIO };
      });

    const approval = h.service.approveAndExecute(ctx, PROPOSAL);
    await started;
    h.setConversation({ ...conversation, archivedAt: new Date() });
    release();

    await expect(approval).rejects.toBeInstanceOf(NotFoundException);
    expect(h.getRow()?.status).toBe('proposed');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('allows exactly one of two concurrent approvals to claim and execute', async () => {
    const h = harness({ row: rpRow() });

    const [first, second] = await Promise.all([
      h.service.approveAndExecute(ctx, PROPOSAL),
      h.service.approveAndExecute(ctx, PROPOSAL),
    ]);

    expect([first.status, second.status]).toContain('succeeded');
    expect([first.status, second.status].every((value) => /^(?:executing|succeeded)$/.test(value)))
      .toBe(true);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    expect(h.getRow()?.attemptCount).toBe(1);
  });

  it('leaves approval retryable when the transaction claim fence loses the exact conversation row', async () => {
    const h = harness({ row: rpRow({ status: 'failed_retryable', attemptCount: 1 }) });
    h.tx.$queryRaw.mockResolvedValueOnce([]);

    await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.getRow()?.status).toBe('failed_retryable');
    expect(h.getRow()?.attemptCount).toBe(1);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('keeps a failed RP PASS execution retryable under the same late-fenced authority', async () => {
    const h = harness({ row: null });
    h.setPolicy({ outcome: 'PASS', reasons: ['RP write allowed'] });
    h.tools.execute.mockRejectedValueOnce(new Error('temporarily unavailable'));
    h.tools.execute.mockResolvedValueOnce({ ok: true, snapshotId: PROPOSAL });

    const created = await h.service.create(
      ctx,
      {
        tool: 'create_research_portfolio_snapshot',
        input: snapshotInput,
        conversationId: RP_CONVERSATION,
        surface: 'chat',
      },
      { conversationId: RP_CONVERSATION, selectedClientId: null },
    );
    expect(created.proposal.status).toBe('failed_retryable');

    const retried = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(retried.status).toBe('succeeded');
    expect(retried.attemptCount).toBe(2);
    expect(h.tools.execute).toHaveBeenCalledTimes(2);
  });

  it('leaves an ordinary non-RP proposal path unaffected', async () => {
    const h = harness({ row: null, executeResult: { ok: true, clientId: RP_CLIENT } });
    h.setPolicy({ outcome: 'PASS', reasons: ['Ordinary write'] });

    const result = await h.service.create(ctx, {
      tool: 'update_client_profile',
      input: { clientId: RP_CLIENT, name: 'Acme' },
      surface: 'chat',
    });

    expect(result.disposition).toBe('executed');
    expect(h.authorizeScope).not.toHaveBeenCalled();
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });
});

describe('MeriActionProposalService — retries retain the original policy authority', () => {
  const input = { clientId: TENANT, conversationId: PROPOSAL, attachmentIds: [USER, PROPOSAL] };
  const partialReceipt = {
    tool: 'save_chat_attachments',
    status: 'partial',
    clientId: TENANT,
    savedCount: 1,
    failedCount: 1,
    pendingCount: 0,
    files: [
      { attachmentId: USER, fileName: 'letter.docx', status: 'saved', documentId: 'doc-1' },
      {
        attachmentId: PROPOSAL,
        fileName: 'brief.pdf',
        status: 'failed',
        reason: 'Temporarily unavailable',
      },
    ],
  };
  const completeReceipt = {
    tool: 'save_chat_attachments',
    status: 'saved',
    clientId: TENANT,
    savedCount: 2,
    failedCount: 0,
    pendingCount: 0,
    files: [
      {
        attachmentId: USER,
        fileName: 'letter.docx',
        status: 'saved',
        documentId: 'doc-1',
        reused: true,
      },
      { attachmentId: PROPOSAL, fileName: 'brief.pdf', status: 'saved', documentId: 'doc-2' },
    ],
  };

  async function failedPassAction() {
    const h = harness({ row: null, executeResult: partialReceipt });
    h.setPolicy({ outcome: 'PASS', reasons: ['Client filing is allowed by the governing policy'] });
    const created = await h.service.create(ctx, {
      tool: 'save_chat_attachments',
      input,
      surface: 'chat',
    });
    expect(created.proposal.status).toBe('failed_retryable');
    expect(created.proposal.attemptCount).toBe(1);
    expect(h.getRow()?.policyDecision).toBe('PASS');
    return h;
  }

  it('re-evaluates and retries a partial PASS execution under the unchanged PASS policy', async () => {
    const h = await failedPassAction();
    h.tools.execute.mockResolvedValueOnce(completeReceipt);

    const retried = await h.service.approveAndExecute(ctx, PROPOSAL);

    expect(retried.status).toBe('succeeded');
    expect(retried.attemptCount).toBe(2);
    expect(retried.resultSummary).toMatchObject({ savedCount: 2, failedCount: 0 });
    expect(h.policyPacks.decideForAction).toHaveBeenCalledTimes(2);
    expect(h.policyPacks.decideForAction).toHaveBeenLastCalledWith(
      ctx,
      'save_chat_attachments',
      input,
    );
    expect(h.tools.execute).toHaveBeenNthCalledWith(2, ctx, 'save_chat_attachments', input, {
      actionProposalId: PROPOSAL,
    });
  });

  it.each(['WARN', 'BLOCK'] as const)(
    'blocks a PASS retry when fresh policy changes to %s',
    async (outcome) => {
      const h = await failedPassAction();
      h.setPolicy({ outcome, reasons: ['Policy changed'] });
      const retried = await h.service.approveAndExecute(ctx, PROPOSAL);
      expect(retried.status).toBe('blocked');
      expect(retried.error?.code).toBe('policy_binding_changed');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['binding', 'decisionHash', 'contextHash', 'packId', 'packVersion'] as const)(
    'blocks a PASS retry when the bound %s changes despite the same outcome',
    async (field) => {
      const h = await failedPassAction();
      const changed = authoritativeDecision('save_chat_attachments', {
        outcome: 'PASS',
        reasons: ['Policy still allows this action'],
      });
      changed[field] = `changed-${field}`;
      (h.policyPacks.decideForAction as jest.Mock).mockResolvedValueOnce(changed);
      const retried = await h.service.approveAndExecute(ctx, PROPOSAL);
      expect(retried.status).toBe('blocked');
      expect(retried.error?.code).toBe('policy_binding_changed');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { status: 'proposed', policyDecision: 'PASS', attemptCount: 0 },
    { status: 'failed_retryable', policyDecision: 'PASS', attemptCount: 0 },
    { status: 'failed_retryable', policyDecision: 'WARN', attemptCount: 1 },
  ])(
    'does not treat $status/$policyDecision with $attemptCount attempts as a prior PASS retry',
    async (state) => {
      const h = harness({
        row: makeRow({ tool: 'save_chat_attachments', input, ...state }),
        executeResult: completeReceipt,
      });
      h.setPolicy({ outcome: 'PASS', reasons: ['Current policy allows this action'] });
      const result = await h.service.approveAndExecute(ctx, PROPOSAL);
      expect(result.status).toBe('blocked');
      expect(result.error?.code).toBe('policy_binding_changed');
      expect(h.tools.execute).not.toHaveBeenCalled();
    },
  );

  it('keeps the immutable input fingerprint check on an otherwise eligible PASS retry', async () => {
    const h = await failedPassAction();
    h.getRow()!.input = { ...input, clientId: USER };
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('fingerprint_mismatch');
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    expect(h.policyPacks.decideForAction).toHaveBeenCalledTimes(1);
  });

  it('still retries an approved WARN action under the unchanged WARN authority', async () => {
    const h = harness({
      row: makeRow({
        tool: 'save_chat_attachments',
        input,
        status: 'failed_retryable',
        attemptCount: 1,
      }),
      executeResult: completeReceipt,
    });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('succeeded');
    expect(result.attemptCount).toBe(2);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });
});

describe('MeriActionProposalService — note storage and readiness', () => {
  it('reports a durably stored note as pending indexing while keeping execution succeeded', async () => {
    const h = harness({
      row: null,
      executeResult: {
        tool: 'save_note',
        status: 'pending',
        clientId: TENANT,
        documentId: 'note-1',
        note: { id: 'note-1', clientId: TENANT, title: 'Engagement notes' },
        indexingStatus: 'pending',
        message: 'Saved. Search indexing is still in progress.',
      },
    });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, {
      tool: 'save_note',
      input: { body: 'Notes', clientId: TENANT },
      surface: 'chat',
    });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.status).toBe('succeeded');
    expect(result.proposal.resultSummary).toMatchObject({
      status: 'pending',
      documentId: 'note-1',
      indexingStatus: 'pending',
    });
  });

  it('preserves the stored ID and failure detail when note preparation requires a retry', async () => {
    const h = harness({
      row: null,
      executeResult: {
        tool: 'save_note',
        status: 'failed',
        clientId: TENANT,
        documentId: 'note-1',
        note: { id: 'note-1', clientId: TENANT },
        indexingStatus: 'failed',
        message: 'Document stored, but text indexing failed. Retry to finish preparing it.',
      },
    });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, {
      tool: 'save_note',
      input: { body: 'Notes', clientId: TENANT },
      surface: 'chat',
    });
    expect(result.disposition).toBe('failed');
    expect(result.proposal.status).toBe('failed_retryable');
    expect(result.proposal.error?.code).toBe('client_filing_incomplete');
    expect(result.proposal.error?.message).toContain('text indexing failed');
    expect(result.proposal.resultSummary).toMatchObject({
      status: 'failed',
      documentId: 'note-1',
      indexingStatus: 'failed',
    });
  });

  it('retains a confirmed personal note receipt when it has no client association', async () => {
    const h = harness({
      row: null,
      executeResult: {
        tool: 'save_note',
        status: 'saved',
        note: { id: 'personal-note-1', clientId: null },
        clientId: null,
        message: 'Saved to your notes.',
      },
    });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, {
      tool: 'save_note',
      input: { body: 'Personal notes' },
      surface: 'chat',
    });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.status).toBe('succeeded');
    expect(result.proposal.resultSummary).toMatchObject({
      tool: 'save_note',
      status: 'saved',
      note: { id: 'personal-note-1', clientId: null },
    });
    expect(result.proposal.preview.client).toBeUndefined();
  });
});

describe('MeriActionProposalService.list', () => {
  const CONVERSATION = '44444444-4444-4444-8444-444444444444';
  const OTHER_CONVERSATION = '55555555-5555-4555-8555-555555555555';

  function listHarness(rows: MeriActionProposal[]) {
    const execute = jest.fn();
    const tx = {
      meriActionProposal: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(
          async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
            rows
              .filter(
                (row) =>
                  row.tenantId === where.tenantId &&
                  row.userId === where.userId &&
                  (!where.conversationId || row.conversationId === where.conversationId) &&
                  (!where.id || row.id === where.id),
              )
              .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
              .slice(0, take),
        ),
      },
    };
    const prisma = {
      withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const tools = { executeFromAuthenticatedUser: execute } as unknown as MeriToolsService;
    const config = {
      get: (key: string) => (key === 'MERIV2_ACTION_PROPOSALS_ENABLED' ? true : undefined),
    } as unknown as ConfigService<AppConfig, true>;
    const service = new MeriActionProposalService(
      prisma,
      tools,
      config,
      {} as unknown as MeriPolicyPackService,
      {} as unknown as ResearchPortfolioMeriScopeService,
    );
    return { service, tx, execute };
  }

  it('keeps tenant, actor, and conversation authorization predicates on an exact read', async () => {
    const own = makeRow({ id: PROPOSAL, conversationId: CONVERSATION });
    const foreign = makeRow({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      conversationId: CONVERSATION,
    });
    const h = listHarness([own, foreign]);

    const result = await h.service.list(ctx, CONVERSATION, PROPOSAL);

    expect(result.map((row) => row.proposalId)).toEqual([PROPOSAL]);
    expect(h.tx.meriActionProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          userId: USER,
          conversationId: CONVERSATION,
          id: PROPOSAL,
        },
      }),
    );
    await expect(
      h.service.list(
        { ...ctx, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        CONVERSATION,
        PROPOSAL,
      ),
    ).resolves.toEqual([]);
    await expect(
      h.service.list(
        { ...ctx, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        CONVERSATION,
        PROPOSAL,
      ),
    ).resolves.toEqual([]);
    await expect(h.service.list(ctx, OTHER_CONVERSATION, PROPOSAL)).resolves.toEqual([]);
    await expect(h.service.list(ctx, undefined, PROPOSAL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('recovers an exact original receipt beyond 100 newer rows without widening the default list', async () => {
    const original = makeRow({
      id: PROPOSAL,
      conversationId: CONVERSATION,
      status: 'succeeded',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = Array.from({ length: 100 }, (_, index) =>
      makeRow({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
        conversationId: CONVERSATION,
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, index)),
      }),
    );
    const h = listHarness([original, ...newer]);

    const defaultRows = await h.service.list(ctx, CONVERSATION);
    const exactRows = await h.service.list(ctx, CONVERSATION, PROPOSAL);

    expect(defaultRows).toHaveLength(100);
    expect(defaultRows.some((row) => row.proposalId === PROPOSAL)).toBe(false);
    expect(exactRows.map((row) => row.proposalId)).toEqual([PROPOSAL]);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

const rpClaimDatabaseUrl = process.env.RP_PROPOSAL_CLAIM_TEST_DATABASE_URL;
const rpClaimPostgresSuite = rpClaimDatabaseUrl ? describe : describe.skip;
rpClaimPostgresSuite('RP proposal conversation claim fence — PostgreSQL', () => {
  const schema = `rp_claim_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const clientId = randomUUID();
  const checkpointMetadata = researchPortfolioMetadata();
  let admin: PrismaClient;
  let db: PrismaClient;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: rpClaimDatabaseUrl! } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(rpClaimDatabaseUrl!);
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '1');
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await db.$executeRawUnsafe(`SET search_path TO "${schema}"`);
    await db.$executeRawUnsafe(`
      CREATE TABLE clio_conversations (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        client_id uuid NULL,
        metadata_jsonb jsonb NOT NULL,
        archived_at timestamptz NULL
      )
    `);
    await db.$executeRawUnsafe(
      `INSERT INTO clio_conversations(id, tenant_id, user_id, client_id, metadata_jsonb)
       VALUES ('${conversationId}', '${tenantId}', '${userId}', NULL, '${JSON.stringify(checkpointMetadata)}'::jsonb)`,
    );
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it('matches exact null/non-null client and metadata and rejects archive/client/metadata drift', async () => {
    const service = new MeriActionProposalService(
      {} as PrismaService,
      {} as MeriToolsService,
      {} as ConfigService<AppConfig, true>,
      {} as MeriPolicyPackService,
      {} as ResearchPortfolioMeriScopeService,
    );
    const lock = (
      service as unknown as {
        lockResearchPortfolioProposalConversation: (
          tx: PrismaClient,
          context: TenantContext,
          id: string,
          checkpoint: { metadata: Record<string, unknown>; clientId: string | null },
        ) => Promise<boolean>;
      }
    ).lockResearchPortfolioProposalConversation.bind(service);
    const context = { ...ctx, tenantId, userId };

    await expect(
      lock(db, context, conversationId, { metadata: checkpointMetadata, clientId: null }),
    ).resolves.toBe(true);
    await db.$executeRawUnsafe(
      `UPDATE clio_conversations SET client_id = '${clientId}' WHERE id = '${conversationId}'`,
    );
    await expect(
      lock(db, context, conversationId, { metadata: checkpointMetadata, clientId }),
    ).resolves.toBe(true);
    await expect(
      lock(db, context, conversationId, { metadata: checkpointMetadata, clientId: null }),
    ).resolves.toBe(false);
    await db.$executeRawUnsafe(
      `UPDATE clio_conversations SET metadata_jsonb = '{"researchPortfolioScope":null}'::jsonb WHERE id = '${conversationId}'`,
    );
    await expect(
      lock(db, context, conversationId, { metadata: checkpointMetadata, clientId }),
    ).resolves.toBe(false);
    await db.$executeRawUnsafe(
      `UPDATE clio_conversations SET metadata_jsonb = '${JSON.stringify(checkpointMetadata)}'::jsonb, archived_at = now() WHERE id = '${conversationId}'`,
    );
    await expect(
      lock(db, context, conversationId, { metadata: checkpointMetadata, clientId }),
    ).resolves.toBe(false);
  });
});
