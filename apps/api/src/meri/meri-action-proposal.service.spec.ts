import { NotFoundException } from '@nestjs/common';
import type { MeriActionProposal } from '@prisma/client';
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
    }),
    policyVersion: CAPIRO_COMPLIANCE_POLICY_VERSION,
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
  if (statusFilter && typeof statusFilter === 'object' && Array.isArray((statusFilter as { in?: unknown }).in)) {
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

function harness(options: {
  row?: MeriActionProposal | null;
  forceClaimLoss?: boolean;
  executeResult?: unknown;
  executeError?: unknown;
} = {}) {
  let row = options.row === undefined ? makeRow() : options.row;
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
    if (where.executionStartedAt && !dateMatches(where.executionStartedAt, row.executionStartedAt)) return false;
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
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where) || !row) return { count: 0 };
        if (options.forceClaimLoss && data.status === 'executing') {
          row = { ...row, status: 'executing', executionStartedAt: new Date() } as MeriActionProposal;
          return { count: 0 };
        }
        const next: Record<string, unknown> = { ...row };
        for (const [key, value] of Object.entries(data)) {
          if (value === undefined) continue;
          if (value && typeof value === 'object' && 'increment' in value) {
            next[key] = Number(next[key] ?? 0) + Number((value as { increment: number }).increment);
          } else {
            next[key] = value;
          }
        }
        next.updatedAt = new Date();
        row = next as unknown as MeriActionProposal;
        return { count: 1 };
      }),
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
  const service = new MeriActionProposalService(prisma, tools, config);
  const setPolicy = (decision: {
    outcome: 'PASS' | 'WARN' | 'BLOCK';
    reasons: string[];
    code?: string;
    tier?: 'low' | 'moderate' | 'high' | 'restricted';
    ruleId?: string;
  }) => {
    (service as unknown as { policy: { evaluate: jest.Mock } }).policy = {
      evaluate: jest.fn().mockResolvedValue(decision),
    };
  };
  return { service, tx, tools: { execute, validate }, getRow: () => row, setPolicy };
}

describe('MeriActionProposalService', () => {
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
    expect(result.proposalId).toBe(PROPOSAL);
    expect(stored.tenantId).toBe(TENANT);
    expect(stored.userId).toBe(USER);
    expect(stored.fingerprint).not.toBe('f'.repeat(64));
    expect(stored.policyVersion).toBe(CAPIRO_COMPLIANCE_POLICY_VERSION);
    expect(stored.status).toBe('proposed');
    expect(h.tx.complianceCheck.create).toHaveBeenCalledTimes(1);
  });

  it('blocks changed stored payloads because the fingerprint no longer matches', async () => {
    const original = makeRow();
    const tampered = { ...original, input: { ...original.input as object, body: 'Changed after review' } } as MeriActionProposal;
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
    h.setPolicy({ outcome: 'BLOCK', reasons: ['Policy now blocks this action'], code: 'new_block' });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('new_block');
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
    const row = makeRow({ tool: 'update_client_profile', input: { clientId: TENANT, name: 'Acme' } });
    const h = harness({ row, executeResult: { ok: true, clientId: TENANT } });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    const result = await h.service.approveAndExecute(ctx, PROPOSAL);
    expect(h.tools.execute).toHaveBeenCalledWith(ctx, 'update_client_profile', row.input);
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

  it('classifies safe internal transient errors as failed_retryable', async () => {
    const row = makeRow({ tool: 'update_client_profile', input: { clientId: TENANT, name: 'Acme' } });
    const h = harness({ row, executeError: new Error('temporarily unavailable') });
    h.setPolicy({ outcome: 'WARN', reasons: ['Requires approval'] });
    expect((await h.service.approveAndExecute(ctx, PROPOSAL)).status).toBe('failed_retryable');
  });

  it('classifies a genuine validation failure as failed_terminal, never succeeded', async () => {
    const row = makeRow({ tool: 'update_client_profile', input: { clientId: TENANT, name: 'Acme' } });
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
      h.service.approveAndExecute({ ...ctx, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, PROPOSAL),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.service.approveAndExecute({ ...ctx, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, PROPOSAL),
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
      withTenant: jest.fn((_tenantId: string, callback: (arg: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const tools = {} as unknown as MeriToolsService;
    const config = {
      get: (key: string) => (key === 'MERIV2_ACTION_PROPOSALS_ENABLED' ? true : undefined),
    } as unknown as ConfigService<AppConfig, true>;
    const service = new MeriActionProposalService(prisma, tools, config);

    const result = await service.list(ctx);

    expect(result).toHaveLength(1);
    expect(result[0]?.proposalId).toBe(PROPOSAL);
    expect(tx.meriActionProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, userId: USER }) }),
    );
  });
});
