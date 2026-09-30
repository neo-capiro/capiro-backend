import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, type MeriActionProposal } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { CAPIRO_COMPLIANCE_POLICY_VERSION, computeActionFingerprintV2 } from '@capiro/meriv2-core';
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
  let conversation =
    options.conversation === undefined
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
    withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) => callback(tx)),
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
      readScheduleTaskReceipt: (
        tools as unknown as {
          readScheduleTaskReceipt: jest.Mock;
        }
      ).readScheduleTaskReceipt,
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
    [
      'foreign-owned',
      {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: OTHER_RP_CLIENT,
        archivedAt: null,
        clientId: null,
        metadata: researchPortfolioMetadata(),
      },
    ],
    [
      'archived',
      {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: new Date(),
        clientId: null,
        metadata: researchPortfolioMetadata(),
      },
    ],
  ] as const)(
    'rejects a %s current RP conversation before policy or execution',
    async (_label, conversation) => {
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
    },
  );

  it.each([
    ['stale scope', new BadRequestException('Research portfolio scope is stale')],
    ['ethical wall', new NotFoundException('Research portfolio is blocked by an ethical wall')],
  ])(
    'reauthorizes current RP membership at approval/retry and rejects %s',
    async (_label, error) => {
      const h = harness({
        row: rpRow({ status: 'failed_retryable', attemptCount: 1 }),
        scopeError: error,
      });

      await expect(h.service.approveAndExecute(ctx, PROPOSAL)).rejects.toBe(error);
      expect(h.getRow()?.status).toBe('failed_retryable');
      expect(h.getRow()?.attemptCount).toBe(1);
      expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
      expect(h.tools.execute).not.toHaveBeenCalled();
    },
  );

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
    [
      { ...snapshotInput, conversationId: OTHER_RP_CONVERSATION },
      RP_CONVERSATION,
      'stored_input_invalid',
    ],
    [snapshotInput, OTHER_RP_CONVERSATION, 'stored_scope_invalid'],
    [{ operationKey: 'legacy-without-conversation' }, RP_CONVERSATION, 'stored_input_invalid'],
  ])(
    'blocks an inconsistent stored RP row without retargeting or execution',
    async (input, conversationId, code) => {
      const h = harness({ row: rpRow({ input, conversationId }) });

      const result = await h.service.approveAndExecute(ctx, PROPOSAL);

      expect(result.status).toBe('blocked');
      expect(result.error?.code).toBe(code);
      expect(result.attemptCount).toBe(0);
      expect(h.policyPacks.decideForAction).not.toHaveBeenCalled();
      expect(h.tools.execute).not.toHaveBeenCalled();
    },
  );

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
  ] as const)(
    'rejects RP %s when selected client changes during awaited policy',
    async (_label, approval) => {
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
    },
  );

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
    expect(
      [first.status, second.status].every((value) => /^(?:executing|succeeded)$/.test(value)),
    ).toBe(true);
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
  it.each(['creation', 'approval'] as const)(
    'same-fixture late-policy %s client-to-null race denies before persistence/effect',
    async (lane) => {
      const conversation = {
        id: RP_CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: null,
        clientId: RP_CLIENT as string | null,
        metadata: researchPortfolioMetadata(),
      };
      const h = harness({ row: null, conversation });
      const request = {
        tool: 'create_research_portfolio_snapshot',
        input: snapshotInput,
        conversationId: RP_CONVERSATION,
        surface: 'chat' as const,
      };
      const turn = { conversationId: RP_CONVERSATION, selectedClientId: RP_CLIENT };
      if (lane === 'approval') {
        const created = await h.service.create(ctx, request, turn);
        expect(created.proposal.status).toBe('proposed');
        expect(h.tools.execute).not.toHaveBeenCalled();
      }
      const decision = await h.policyPacks.decideForAction(ctx, request.tool, request.input);
      let release!: () => void, entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const atPolicy = new Promise<void>((resolve) => {
        entered = resolve;
      });
      (h.policyPacks.decideForAction as jest.Mock).mockImplementationOnce(async () => {
        entered();
        await paused;
        return decision;
      });
      const work =
        lane === 'creation'
          ? h.service.create(ctx, request, turn)
          : h.service.approveAndExecute(ctx, PROPOSAL);
      const observation = work.then(
        () => 'resolved',
        () => 'rejected',
      );
      await atPolicy;
      conversation.clientId = null;
      release();
      expect({
        outcome: await observation,
        currentStatus: h.getRow()?.status ?? null,
        persistedRows: h.tx.meriActionProposal.create.mock.calls.length,
        effects: h.tools.execute.mock.calls.length,
      }).toEqual({
        outcome: 'rejected',
        currentStatus: lane === 'creation' ? null : 'proposed',
        persistedRows: lane === 'creation' ? 0 : 1,
        effects: 0,
      });
    },
  );
});
