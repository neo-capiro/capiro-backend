import { NotFoundException } from '@nestjs/common';
import type { MeriActionProposal } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { CAPIRO_COMPLIANCE_POLICY_VERSION, computeActionFingerprintV2 } from '@capiro/meriv2-core';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { classifyMeriActionLogicalFailure } from './meri-action-logical-outcome.js';
import {
  MeriActionProposalService,
  type MeriActionProposalStatus,
} from './meri-action-proposal.service.js';
import type { MeriToolsService } from './meri-tools.service.js';
import type {
  AuthoritativePolicyDecision,
  MeriPolicyPackService,
} from './meri-policy-pack.service.js';

// This suite exercises action authority with the explicit tool/policy doubles
// below; their unrelated Nest dependency graphs are covered in module tests.
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('./meri-policy-pack.service.js', () => ({ MeriPolicyPackService: class {} }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
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
    return (statusFilter as { in: string[] }).in.includes(status);
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

function harness(
  options: {
    row?: MeriActionProposal | null;
    forceClaimLoss?: boolean;
    executeResult?: unknown;
    executeError?: unknown;
  } = {},
) {
  let row = options.row === undefined ? makeRow() : options.row;
  const complianceCreate = jest.fn().mockResolvedValue({ id: 'audit' });
  const execute = options.executeError
    ? jest.fn().mockRejectedValue(options.executeError)
    : jest.fn().mockResolvedValue(options.executeResult ?? { ok: true, id: 'result-1' });
  const validate = jest.fn(
    (_tool: string, input: unknown) =>
      JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>,
  );

  function matches(where: Record<string, unknown>): boolean {
    if (!row) return false;
    if (where.id && where.id !== row.id) return false;
    if (where.tenantId && where.tenantId !== row.tenantId) return false;
    if (where.userId && where.userId !== row.userId) return false;
    if (where.status && !statusMatches(where.status, row.status)) return false;
    if (where.expiresAt && !dateMatches(where.expiresAt, row.expiresAt)) return false;
    if (
      where.executionStartedAt &&
      !dateMatches(where.executionStartedAt, row.executionStartedAt)
    ) {
      return false;
    }
    return true;
  }

  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue(null) },
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
    withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  const tools = {
    validateSideEffectingInput: validate,
    executeFromAuthenticatedUser: execute,
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
  const service = new MeriActionProposalService(prisma, tools, config, policyPacks);
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
    tools: { execute, validate },
    policyPacks,
    getRow: () => row,
    setPolicy,
  };
}

describe('MeriActionProposalService', () => {
  it('keeps a confirmed client note receipt without exposing its body', async () => {
    const h = harness({
      row: null,
      executeResult: {
        tool: 'save_note',
        status: 'saved',
        note: {
          id: 'note-1',
          clientId: TENANT,
          title: 'Engagement notes',
          body: 'Private note body',
        },
        documentId: 'note-1',
        clientId: TENANT,
        clientName: 'Sightline',
        location: `/clients?clientId=${TENANT}&tab=documents`,
        indexingStatus: 'pending',
      },
    });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, {
      tool: 'save_note',
      input: { body: 'Private note body', clientId: TENANT },
      surface: 'chat',
    });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.resultSummary).toMatchObject({
      tool: 'save_note',
      status: 'saved',
      documentId: 'note-1',
      clientName: 'Sightline',
      note: { id: 'note-1' },
    });
    expect(JSON.stringify(result.proposal.resultSummary)).not.toContain('Private note body');
  });

  it('does not treat a resolved promise without a durable save receipt as success', async () => {
    const h = harness({ row: null, executeResult: { ok: true } });
    h.setPolicy({ outcome: 'PASS', reasons: ['Internal note'] });
    const result = await h.service.create(ctx, {
      tool: 'save_note',
      input: { body: 'Notes' },
      surface: 'chat',
    });
    expect(result.disposition).toBe('failed');
    expect(result.proposal.status).toBe('outcome_unknown');
    expect(result.proposal.error?.code).toBe('client_filing_receipt_missing');
  });

  it.each(['create', 'approve'] as const)(
    'preserves a partial batch and its retry state through %s',
    async (path) => {
      const input = { clientId: TENANT, conversationId: PROPOSAL, attachmentIds: [USER, PROPOSAL] };
      const h = harness({
        row: path === 'approve' ? makeRow({ tool: 'save_chat_attachments', input }) : null,
        executeResult: {
          tool: 'save_chat_attachments',
          status: 'partial',
          clientId: TENANT,
          clientName: 'Sightline',
          savedCount: 1,
          pendingCount: 0,
          failedCount: 1,
          files: [
            { attachmentId: USER, fileName: 'letter.docx', status: 'saved', documentId: 'doc-1' },
            {
              attachmentId: PROPOSAL,
              fileName: 'brief.pdf',
              status: 'failed',
              reason: 'Try again',
            },
          ],
        },
      });
      h.setPolicy({ outcome: path === 'approve' ? 'WARN' : 'PASS', reasons: ['File documents'] });
      const result =
        path === 'approve'
          ? await h.service.approveAndExecute(ctx, PROPOSAL)
          : (await h.service.create(ctx, { tool: 'save_chat_attachments', input, surface: 'chat' }))
              .proposal;
      expect(result.status).toBe('failed_retryable');
      expect(result.resultSummary).toMatchObject({
        status: 'partial',
        savedCount: 1,
        failedCount: 1,
        files: [
          expect.objectContaining({ documentId: 'doc-1', status: 'saved' }),
          expect.objectContaining({ status: 'failed' }),
        ],
      });
    },
  );

  it('retains processing state when all original files are stored but some scans are pending', async () => {
    const h = harness({
      row: null,
      executeResult: {
        tool: 'save_chat_attachments',
        status: 'partial',
        clientId: TENANT,
        files: [
          { attachmentId: USER, status: 'saved', documentId: 'd1' },
          { attachmentId: PROPOSAL, status: 'pending', documentId: 'd2' },
        ],
      },
    });
    h.setPolicy({ outcome: 'PASS', reasons: ['File documents'] });
    const result = await h.service.create(ctx, {
      tool: 'save_chat_attachments',
      input: {},
      surface: 'chat',
    });
    expect(result.disposition).toBe('executed');
    expect(result.proposal.resultSummary).toMatchObject({
      status: 'partial',
      files: [
        expect.objectContaining({ status: 'saved' }),
        expect.objectContaining({ status: 'pending' }),
      ],
    });
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
      logicalOperationId: PROPOSAL,
    });
    expect(result.status).toBe('succeeded');
    expect(result.attemptCount).toBe(1);
  });

  it.each(['PASS', 'WARN'] as const)(
    'keeps ambiguous send_email %s outcome unknown without retry',
    async (outcome) => {
      const h = harness({
        row: outcome === 'WARN' ? makeRow() : null,
        executeError: new Error('socket closed after provider request'),
      });
      h.setPolicy({ outcome, reasons: ['Send policy'] });
      const result =
        outcome === 'WARN'
          ? await h.service.approveAndExecute(ctx, PROPOSAL)
          : (
              await h.service.create(ctx, {
                tool: 'send_email',
                input: makeRow().input,
                surface: 'chat',
              })
            ).proposal;
      const retry = await h.service.approveAndExecute(ctx, PROPOSAL);
      expect(result.status).toBe('outcome_unknown');
      expect(result.error?.code).toBe('external_outcome_unknown');
      expect(retry.status).toBe('outcome_unknown');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an ambiguous schedule acknowledgement non-retryable with the same operation id', async () => {
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
      logicalOperationId: PROPOSAL,
    });
  });

  it.each([
    ['send_email', { error: 'No connected email account found.' }, 'send_email_failed'],
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
  ])(
    'classifies resolved %s handler errors as terminal failures',
    async (tool, executeResult, code) => {
      const input =
        tool === 'reply_email'
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
    },
  );

  it.each([
    [
      'send_email',
      {
        ok: true,
        sentFrom: 'me@example.com',
        to: 'you@example.com',
        subject: 'Hi',
        sendReceipt: {
          ok: true,
          provider: 'gmail',
          providerMessageId: 'message-1',
          correlationId: PROPOSAL,
        },
      },
    ],
    [
      'reply_email',
      { ok: true, sentFrom: 'me@example.com', to: 'you@example.com', subject: 'Re: Hi' },
    ],
    ['schedule_task', { tool: 'schedule_task', scheduled: true, task: { id: 'task-1' } }],
    ['cancel_scheduled_task', { tool: 'cancel_scheduled_task', canceled: true, taskId: 'task-1' }],
  ])('accepts the confirmed %s handler receipt', async (tool, executeResult) => {
    const h = harness({ row: makeRow({ tool }), executeResult });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe('succeeded');
  });

  it.each(['PASS', 'WARN'] as const)(
    'keeps disconnected send_email truthful on the %s path',
    async (outcome) => {
      const h = harness({
        row: outcome === 'WARN' ? makeRow() : null,
        executeResult: { error: 'No connected email account found.' },
      });
      h.setPolicy({ outcome, reasons: ['Send policy'] });
      const result =
        outcome === 'WARN'
          ? await h.service.approveAndExecute(ctx, PROPOSAL)
          : (
              await h.service.create(ctx, {
                tool: 'send_email',
                input: makeRow().input,
                surface: 'chat',
              })
            ).proposal;
      expect(result.status).toBe('failed_terminal');
      expect(result.error?.code).toBe('send_email_failed');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps send_email unknown without authoritative provider identity and does not retry', async () => {
    const executeResult = {
      ok: true,
      sentFrom: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hi',
      sendReceipt: { ok: true, provider: 'gmail', correlationId: PROPOSAL },
    };
    const h = harness({ executeResult });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    const retry = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('outcome_unknown');
    expect(result.error?.code).toBe('send_email_receipt_missing');
    expect(result.resultSummary).toMatchObject({ sendReceipt: executeResult.sendReceipt });
    expect(retry.status).toBe('outcome_unknown');
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['PASS', 'WARN'] as const)(
    'binds accepted send and artifact failure to the exact operation on the %s path',
    async (outcome) => {
      const executeResult = {
        ok: true,
        sentFrom: 'me@example.com',
        to: 'you@example.com',
        subject: 'Hi',
        sendReceipt: {
          ok: true,
          provider: 'gmail',
          providerMessageId: 'message-1',
          correlationId: PROPOSAL,
        },
        artifactPersistence: {
          persisted: false,
          error: 'Artifact persistence failed after acceptance',
        },
      };
      const h = harness({ row: outcome === 'WARN' ? makeRow() : null, executeResult });
      h.setPolicy({ outcome, reasons: ['Send policy'] });
      const result =
        outcome === 'WARN'
          ? await h.service.approveAndExecute(ctx, PROPOSAL)
          : (
              await h.service.create(ctx, {
                tool: 'send_email',
                input: makeRow().input,
                surface: 'chat',
              })
            ).proposal;
      const retry = await h.service.approveAndExecute(ctx, PROPOSAL);
      expect(result.status).toBe('succeeded');
      expect(result.resultSummary).toMatchObject({
        sendReceipt: executeResult.sendReceipt,
        artifactPersistence: executeResult.artifactPersistence,
      });
      expect(retry.status).toBe('succeeded');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);

      const wrongOperationResult = {
        ...executeResult,
        sendReceipt: {
          ...executeResult.sendReceipt,
          correlationId: '44444444-4444-4444-8444-444444444444',
        },
      };
      expect(classifyMeriActionLogicalFailure('send_email', executeResult, PROPOSAL)).toBeNull();
      expect(
        classifyMeriActionLogicalFailure('send_email', wrongOperationResult, PROPOSAL),
      ).toMatchObject({
        status: 'outcome_unknown',
        errorCode: 'send_email_receipt_missing',
      });

      const wrong = harness({
        row: outcome === 'WARN' ? makeRow() : null,
        executeResult: wrongOperationResult,
      });
      wrong.setPolicy({ outcome, reasons: ['Send policy'] });
      const mismatched =
        outcome === 'WARN'
          ? await wrong.service.approveAndExecute(ctx, PROPOSAL)
          : (
              await wrong.service.create(ctx, {
                tool: 'send_email',
                input: makeRow().input,
                surface: 'chat',
              })
            ).proposal;
      const mismatchedRetry = await wrong.service.approveAndExecute(ctx, PROPOSAL);
      expect(mismatched.status).toBe('outcome_unknown');
      expect(mismatched.error?.code).toBe('send_email_receipt_missing');
      expect(mismatched.resultSummary).toMatchObject({
        sendReceipt: wrongOperationResult.sendReceipt,
        artifactPersistence: wrongOperationResult.artifactPersistence,
      });
      expect(mismatchedRetry.status).toBe('outcome_unknown');
      expect(wrong.tools.execute).toHaveBeenCalledTimes(1);
    },
  );

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
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe('failed_retryable');
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

  it.each<MeriActionProposalStatus>(['succeeded', 'failed_terminal', 'dismissed', 'expired'])(
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
      h.service.dismiss({ ...ctx, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, PROPOSAL),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.dismiss({ ...ctx, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, PROPOSAL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.getRow()?.status).toBe('proposed');
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
      logicalOperationId: PROPOSAL,
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
  it("never returns another tenant or user's proposals", async () => {
    const own = makeRow({ id: PROPOSAL });
    const foreign = makeRow({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const rows = [own, foreign];
    const tx = {
      meriActionProposal: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((r) => r.tenantId === where.tenantId && r.userId === where.userId),
        ),
      },
    };
    const prisma = {
      withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const tools = {} as unknown as MeriToolsService;
    const config = {
      get: (key: string) => (key === 'MERIV2_ACTION_PROPOSALS_ENABLED' ? true : undefined),
    } as unknown as ConfigService<AppConfig, true>;
    const service = new MeriActionProposalService(
      prisma,
      tools,
      config,
      {} as unknown as MeriPolicyPackService,
    );

    const result = await service.list(ctx);

    expect(result).toHaveLength(1);
    expect(result[0]?.proposalId).toBe(PROPOSAL);
    expect(tx.meriActionProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, userId: USER }),
      }),
    );
  });
});
