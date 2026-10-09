import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeriToolsService } from './meri-tools.service.js';
import type { MeriPolicyPackService } from './meri-policy-pack.service.js';
import type { ResearchPortfolioMeriScopeService } from '../research-portfolios/research-portfolio-meri-scope.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service';
import { MeriResearchService } from './meri-research.service';
import {
  readDurableResearchCoordinator,
  type DurableResearchCoordinatorStepV1,
} from './meri-research-coordinator';

// The action-proposal owner only uses MeriPolicyPackService as a DI token here;
// its real Nest dependency graph is covered by module tests, so it is doubled
// to keep this suite provider-free. MeriToolsService is left real because the
// production research service already imports it (see the sibling job-approvals
// spec). No provider/model/effect port is ever stubbed to fake a result.
jest.mock('./meri-policy-pack.service.js', () => ({ MeriPolicyPackService: class {} }));

const TENANT = 'tenant-1';
const USER = 'user-1';
const OTHER_USER = 'user-2';
const ctx = { tenantId: TENANT, userId: USER, tenantSlug: 'tenant' } as unknown as TenantContext;

// 2026-07-01 is before this system clock (2026-10-09); 2027-01-01 is after it.
const PAST = new Date('2026-07-01T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

interface ProposalRow {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  expiresAt: Date;
  attemptCount: number;
  resultSummary: unknown;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

interface SessionRow {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  topic: string;
  title: string;
  status: string;
  kind: string;
  goalRevision: number;
  deliverables: unknown;
  reportArtifactId: string | null;
  sources: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConversationRow {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  archivedAt: Date | null;
}

function matchesId(filter: unknown, value: string): boolean {
  if (typeof filter === 'string') return filter === value;
  if (filter && typeof filter === 'object' && Array.isArray((filter as { in?: unknown }).in)) {
    return (filter as { in: string[] }).in.includes(value);
  }
  return true;
}

function matchesStatus(filter: unknown, value: string): boolean {
  if (typeof filter === 'string') return filter === value;
  if (filter && typeof filter === 'object' && Array.isArray((filter as { in?: unknown }).in)) {
    return (filter as { in: string[] }).in.includes(value);
  }
  return true;
}

function matchesExpiresAtLte(filter: unknown, value: Date | null): boolean {
  if (!filter || typeof filter !== 'object') return true;
  if (!value) return true;
  const lte = (filter as { lte?: Date }).lte;
  return !lte || value.getTime() <= lte.getTime();
}

/** Apply an actual `id`/`id.in`, tenant, user, status.in and expiresAt.lte owner predicate. */
function proposalMatches(row: ProposalRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && !matchesId(where.id, row.id)) return false;
  if (where.tenantId !== undefined && where.tenantId !== row.tenantId) return false;
  if (where.userId !== undefined && where.userId !== row.userId) return false;
  if (where.status !== undefined && !matchesStatus(where.status, row.status)) return false;
  if (where.expiresAt !== undefined && !matchesExpiresAtLte(where.expiresAt, row.expiresAt)) {
    return false;
  }
  return true;
}

/**
 * Session/conversation predicate covering current owner, client scope, archived
 * origin binding and the metadata equals CAS / handoff path filter the real
 * queries use. It never returns an arbitrary session for every where.
 */
function sessionMatches(
  row: { id: string; tenantId: string; userId: string; clientId?: string | null; archivedAt?: Date | null; status?: string; metadata?: unknown },
  where: Record<string, unknown>,
): boolean {
  if (where.id !== undefined && !matchesId(where.id, row.id)) return false;
  if (where.tenantId !== undefined && where.tenantId !== row.tenantId) return false;
  if (where.userId !== undefined && where.userId !== row.userId) return false;
  if ('clientId' in where && (where.clientId ?? null) !== (row.clientId ?? null)) return false;
  if ('archivedAt' in where && (where.archivedAt ?? null) !== (row.archivedAt ?? null)) return false;
  if (where.status !== undefined && !matchesStatus(where.status, row.status ?? '')) return false;
  if (where.metadata !== undefined) {
    const filter = where.metadata as { equals?: unknown; path?: unknown; equalsPath?: unknown };
    if (Array.isArray(filter.path)) {
      let cursor: unknown = row.metadata;
      for (const key of filter.path as string[]) {
        if (!cursor || typeof cursor !== 'object') return false;
        cursor = (cursor as Record<string, unknown>)[key];
      }
      return cursor === (filter as { equals?: unknown }).equals;
    }
    return JSON.stringify(filter.equals) === JSON.stringify(row.metadata ?? {});
  }
  return true;
}

function proposalRow(overrides: Partial<ProposalRow> & { id: string }): ProposalRow {
  return {
    tenantId: TENANT,
    userId: USER,
    status: 'proposed',
    expiresAt: PAST,
    attemptCount: 0,
    resultSummary: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function sessionRow(
  overrides: Partial<SessionRow> & { id: string; metadata: Record<string, unknown> | null },
): SessionRow {
  return {
    tenantId: TENANT,
    userId: USER,
    clientId: null,
    topic: 'Email today’s items',
    title: 'Email today’s items',
    status: 'complete',
    kind: 'deliverable',
    goalRevision: 0,
    deliverables: null,
    reportArtifactId: null,
    sources: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function coordinatorStep(input: {
  id: string;
  proposalId?: string;
  goalRevision?: number;
  effect?: 'safe_read' | 'approval_required';
  outcome?: DurableResearchCoordinatorStepV1['outcome'];
}): DurableResearchCoordinatorStepV1 {
  return {
    id: input.id,
    objective: `Objective for ${input.id}`,
    dependsOn: [],
    goalRevision: input.goalRevision ?? 0,
    effect: input.effect ?? 'approval_required',
    allowedCapabilities: ['send_email'],
    fingerprint: null,
    attempt: 0,
    deadlineAt: null,
    outcome: input.outcome ?? 'waiting_for_approval',
    sourceRefs: [],
    operationRefs: input.proposalId ? [`proposal:${input.proposalId}`] : [],
    resultRef: null,
    leaseEpoch: 1,
    reservationId: null,
    providerCallId: null,
    completedAt: null,
    failureCode: null,
  };
}

/** A valid stored coordinator with a completed read step and caller-supplied approval steps. */
function coordinatorMetadata(
  steps: DurableResearchCoordinatorStepV1[],
  stepHistory: DurableResearchCoordinatorStepV1[] = [],
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    run: {
      id: 'run-1',
      leaseEpoch: 1,
      eventSequence: 0,
      phase: 'research',
      status: 'complete',
      stage: 'Done',
      startedAt: now,
      heartbeatAt: now,
    },
    durableCoordinator: {
      version: 1,
      planVersion: 1,
      planSha256: 'a'.repeat(64),
      goalRevision: 0,
      goal: { objective: 'Email the summary', constraints: [], deliverables: [] },
      deadlineAt: null,
      leaseEpoch: 1,
      aggregateBudgetRef: 'researchToolBudget',
      steps,
      stepHistory,
      inbox: [],
      appliedInboxSequence: 0,
      cancellation: { state: 'none' },
      events: [],
    },
  };
}

function storedStep(metadata: Record<string, unknown> | null, stepId: string) {
  const coordinator = readDurableResearchCoordinator(metadata);
  return coordinator?.steps.find((step) => step.id === stepId) ?? null;
}

interface HarnessOptions {
  proposals?: ProposalRow[];
  sessions?: SessionRow[];
  conversations?: ConversationRow[];
  attachOwner?: boolean;
  casLossOnce?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  let proposals = options.proposals ?? [];
  let sessions = options.sessions ?? [];
  const conversations = options.conversations ?? [];
  let casLossOnce = options.casLossOnce ?? false;

  const proposalFindMany = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
    proposals.filter((row) => proposalMatches(row, where)).map((row) => structuredClone(row)),
  );
  const proposalFindFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const row = proposals.find((candidate) => proposalMatches(candidate, where));
    return row ? structuredClone(row) : null;
  });
  const proposalUpdateMany = jest.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      proposals = proposals.map((row) => {
        if (!proposalMatches(row, where)) return row;
        count += 1;
        return { ...row, ...data } as ProposalRow;
      });
      return { count };
    },
  );
  const sessionUpdateMany = jest.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (casLossOnce) {
        casLossOnce = false;
        return { count: 0 };
      }
      let count = 0;
      sessions = sessions.map((row) => {
        if (!sessionMatches(row, where)) return row;
        count += 1;
        return { ...row, ...data } as SessionRow;
      });
      return { count };
    },
  );

  const tx = {
    meriActionProposal: {
      findMany: proposalFindMany,
      findFirst: proposalFindFirst,
      updateMany: proposalUpdateMany,
    },
    clioResearchSession: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = sessions.find((candidate) => sessionMatches(candidate, where));
        return row ? structuredClone(row) : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        sessions.filter((candidate) => sessionMatches(candidate, where)).map((row) => structuredClone(row)),
      ),
      updateMany: sessionUpdateMany,
    },
    clioConversation: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = conversations.find((candidate) => sessionMatches(candidate, where));
        return row ? { id: row.id } : null;
      }),
    },
    clioArtifact: { findFirst: jest.fn(async () => null) },
    clioMessage: { findFirst: jest.fn(async () => null) },
    $queryRawUnsafe: jest.fn(async () => []),
  };

  const prisma = {
    withTenant: jest.fn(
      async (_tenantId: string, callback: (db: typeof tx) => unknown) => callback(tx),
    ),
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, callback: (db: typeof tx) => unknown) =>
        callback(tx),
    ),
  } as unknown as PrismaService;

  const failIfCalled = jest.fn(() => {
    throw new Error('unexpected effect/provider/policy call in an expiry read');
  });
  const tools = {
    validateSideEffectingInput: failIfCalled,
    executeFromAuthenticatedUser: failIfCalled,
    readScheduleTaskReceipt: failIfCalled,
  } as unknown as MeriToolsService;
  const policyPacks = {
    decideForAction: failIfCalled,
    recordDecisionInTx: failIfCalled,
  } as unknown as MeriPolicyPackService;
  const researchPortfolioScopes = {
    authorize: failIfCalled,
  } as unknown as ResearchPortfolioMeriScopeService;
  const config = {
    get: jest.fn((key: string) =>
      key === 'MERIV2_ACTION_PROPOSALS_ENABLED' ? true : undefined,
    ),
  } as unknown as ConfigService<AppConfig, true>;

  const owner = new MeriActionProposalService(
    prisma,
    tools,
    config,
    policyPacks,
    researchPortfolioScopes,
  );
  const research = new MeriResearchService(
    prisma,
    config,
    tools,
    {} as never,
    {} as never,
  );
  if (options.attachOwner ?? true) research.attachJobApprovalProposals(owner);

  return {
    owner,
    research,
    proposalUpdateMany,
    proposalFindMany,
    failIfCalled,
    getProposals: () => proposals,
    getSessions: () => sessions,
    proposal: (id: string) => proposals.find((row) => row.id === id) ?? null,
    session: (id: string) => sessions.find((row) => row.id === id) ?? null,
  };
}

function sortedIds(values: string[]): string[] {
  return [...values].sort();
}

describe('Exact-ID lazy expiry through the shared proposal lifecycle owner', () => {
  it('getSession expires an exact current-goal approved proposal, settles the job step cancelled/approval_expired, and leaves the job completed', async () => {
    const metadata = coordinatorMetadata([coordinatorStep({ id: 'approve-a', proposalId: 'proposal-a' })]);
    const h = createHarness({
      proposals: [
        proposalRow({
          id: 'proposal-a',
          status: 'approved',
          expiresAt: PAST,
          resultSummary: { receipt: 'old', untouched: true },
        }),
      ],
      sessions: [sessionRow({ id: 'session-expired', metadata })],
    });

    expect(
      storedStep(h.session('session-expired')!.metadata, 'approve-a')?.outcome,
    ).toBe('waiting_for_approval');

    const result = (await h.research.getSession(ctx, 'session-expired')) as unknown as {
      job: { status: string };
    };

    // Stored proposal status is the real proof, not the job label.
    expect(h.proposal('proposal-a')!.status).toBe('expired');
    expect(h.proposal('proposal-a')!.attemptCount).toBe(0);
    expect(h.proposal('proposal-a')!.resultSummary).toEqual({ receipt: 'old', untouched: true });
    const settled = storedStep(h.session('session-expired')!.metadata, 'approve-a');
    expect(settled?.outcome).toBe('cancelled');
    expect(settled?.failureCode).toBe('approval_expired');
    // A completed label here is not an effect-success receipt.
    expect(result.job.status).toBe('completed');
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('listSessions settles only the exact owned current-goal IDs and never expires future, executing, unknown, unrelated, foreign or stale rows', async () => {
    const metadata = coordinatorMetadata(
      [
        coordinatorStep({ id: 'step-approved', proposalId: 'proposal-approved' }),
        coordinatorStep({ id: 'step-failedretry', proposalId: 'proposal-failedretry' }),
        coordinatorStep({ id: 'step-future', proposalId: 'proposal-future' }),
        coordinatorStep({ id: 'step-executing', proposalId: 'proposal-executing' }),
        coordinatorStep({ id: 'step-unknown', proposalId: 'proposal-unknown' }),
        coordinatorStep({ id: 'step-foreign', proposalId: 'proposal-foreign' }),
      ],
      [coordinatorStep({ id: 'step-stale', proposalId: 'proposal-stale', outcome: 'superseded' })],
    );
    const h = createHarness({
      proposals: [
        proposalRow({ id: 'proposal-approved', status: 'approved', expiresAt: PAST }),
        proposalRow({ id: 'proposal-failedretry', status: 'failed_retryable', expiresAt: PAST }),
        proposalRow({ id: 'proposal-future', status: 'proposed', expiresAt: FUTURE }),
        proposalRow({ id: 'proposal-executing', status: 'executing', expiresAt: PAST }),
        proposalRow({ id: 'proposal-unknown', status: 'outcome_unknown', expiresAt: PAST }),
        proposalRow({ id: 'proposal-foreign', status: 'proposed', expiresAt: PAST, userId: OTHER_USER }),
        proposalRow({ id: 'proposal-stale', status: 'proposed', expiresAt: PAST }),
        proposalRow({ id: 'proposal-unrelated', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [sessionRow({ id: 'session-isolation', metadata })],
    });

    await h.research.listSessions(ctx);

    expect(h.proposal('proposal-approved')!.status).toBe('expired');
    expect(h.proposal('proposal-failedretry')!.status).toBe('expired');
    expect(h.proposal('proposal-future')!.status).toBe('proposed');
    expect(h.proposal('proposal-executing')!.status).toBe('executing');
    expect(h.proposal('proposal-unknown')!.status).toBe('outcome_unknown');
    expect(h.proposal('proposal-foreign')!.status).toBe('proposed');
    expect(h.proposal('proposal-stale')!.status).toBe('proposed');
    expect(h.proposal('proposal-unrelated')!.status).toBe('approved');

    // Every proposal row stayed at attemptCount 0 with an immutable receipt.
    for (const row of h.getProposals()) expect(row.attemptCount).toBe(0);

    // The maintenance update was a bounded exact-ID owner predicate.
    const updateWhere = h.proposalUpdateMany.mock.calls.at(-1)![0].where as {
      id?: { in?: string[] };
      tenantId?: string;
      userId?: string;
      status?: { in?: string[] };
      expiresAt?: { lte?: Date };
    };
    expect(updateWhere.tenantId).toBe(TENANT);
    expect(updateWhere.userId).toBe(USER);
    expect(updateWhere.status?.in).toEqual(['proposed', 'approved', 'failed_retryable']);
    expect(updateWhere.expiresAt?.lte).toBeInstanceOf(Date);
    expect(sortedIds(updateWhere.id?.in ?? [])).toEqual(
      sortedIds([
        'proposal-approved',
        'proposal-failedretry',
        'proposal-future',
        'proposal-executing',
        'proposal-unknown',
        'proposal-foreign',
      ]),
    );
    // The unrelated same-actor row is never in the requested set.
    expect(updateWhere.id?.in).not.toContain('proposal-unrelated');

    // The owner read also carried the exact-ID restriction.
    const readWhere = h.proposalFindMany.mock.calls[0]![0].where as { id?: { in?: string[] } };
    expect(readWhere.id?.in).toBeDefined();

    const steps = readDurableResearchCoordinator(h.session('session-isolation')!.metadata)!.steps;
    const byId = new Map(steps.map((step) => [step.id, step]));
    expect(byId.get('step-approved')?.outcome).toBe('cancelled');
    expect(byId.get('step-approved')?.failureCode).toBe('approval_expired');
    expect(byId.get('step-failedretry')?.outcome).toBe('cancelled');
    expect(byId.get('step-failedretry')?.failureCode).toBe('approval_expired');
    expect(byId.get('step-future')?.outcome).toBe('waiting_for_approval');
    expect(byId.get('step-executing')?.outcome).toBe('waiting_for_approval');
    expect(byId.get('step-unknown')?.outcome).toBe('uncertain_effect');
    expect(byId.get('step-unknown')?.failureCode).toBe('approval_outcome_unknown');
    expect(byId.get('step-foreign')?.outcome).toBe('waiting_for_approval');
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('getCoordinatorSnapshot reports the settled cancelled/approval_expired step and leaves executing and future waiting', async () => {
    const metadata = coordinatorMetadata([
      coordinatorStep({ id: 'step-approved', proposalId: 'proposal-approved' }),
      coordinatorStep({ id: 'step-executing', proposalId: 'proposal-executing' }),
      coordinatorStep({ id: 'step-future', proposalId: 'proposal-future' }),
    ]);
    const h = createHarness({
      proposals: [
        proposalRow({ id: 'proposal-approved', status: 'approved', expiresAt: PAST }),
        proposalRow({ id: 'proposal-executing', status: 'executing', expiresAt: PAST }),
        proposalRow({ id: 'proposal-future', status: 'proposed', expiresAt: FUTURE }),
      ],
      sessions: [sessionRow({ id: 'session-snapshot', metadata })],
    });

    const snapshot = (await h.research.getCoordinatorSnapshot(ctx, 'session-snapshot')) as unknown as {
      coordinator: { steps: Array<{ id: string; outcome: string; failureCode: string | null }> };
    };
    const byId = new Map(snapshot.coordinator.steps.map((step) => [step.id, step]));
    expect(byId.get('step-approved')?.outcome).toBe('cancelled');
    expect(byId.get('step-approved')?.failureCode).toBe('approval_expired');
    expect(byId.get('step-executing')?.outcome).toBe('waiting_for_approval');
    expect(byId.get('step-future')?.outcome).toBe('waiting_for_approval');
    expect(h.proposal('proposal-approved')!.status).toBe('expired');
    expect(h.proposal('proposal-executing')!.status).toBe('executing');
    expect(h.proposal('proposal-future')!.status).toBe('proposed');
  });

  it('a lost metadata compare-and-swap leaves the step unresolved, and the next public read settles from fresh state', async () => {
    const metadata = coordinatorMetadata([coordinatorStep({ id: 'approve-a', proposalId: 'proposal-a' })]);
    const h = createHarness({
      casLossOnce: true,
      proposals: [proposalRow({ id: 'proposal-a', status: 'approved', expiresAt: PAST })],
      sessions: [sessionRow({ id: 'session-cas', metadata })],
    });

    // First read: the session CAS loses, so the stored step stays waiting even
    // though the owner already expired the proposal row.
    await h.research.getSession(ctx, 'session-cas');
    expect(h.proposal('proposal-a')!.status).toBe('expired');
    expect(storedStep(h.session('session-cas')!.metadata, 'approve-a')?.outcome).toBe(
      'waiting_for_approval',
    );

    // Second public read re-reads current state and settles.
    await h.research.getSession(ctx, 'session-cas');
    expect(storedStep(h.session('session-cas')!.metadata, 'approve-a')?.outcome).toBe('cancelled');
    expect(storedStep(h.session('session-cas')!.metadata, 'approve-a')?.failureCode).toBe(
      'approval_expired',
    );
  });

  it('repeated public reads are idempotent with no duplicate settlement events', async () => {
    const metadata = coordinatorMetadata([coordinatorStep({ id: 'approve-a', proposalId: 'proposal-a' })]);
    const h = createHarness({
      proposals: [proposalRow({ id: 'proposal-a', status: 'approved', expiresAt: PAST })],
      sessions: [sessionRow({ id: 'session-idem', metadata })],
    });

    await h.research.getSession(ctx, 'session-idem');
    const eventsAfterFirst =
      readDurableResearchCoordinator(h.session('session-idem')!.metadata)!.events.length;
    const runAfterFirst = JSON.stringify(h.session('session-idem')!.metadata.run);

    await h.research.getSession(ctx, 'session-idem');
    expect(readDurableResearchCoordinator(h.session('session-idem')!.metadata)!.events.length).toBe(
      eventsAfterFirst,
    );
    expect(JSON.stringify(h.session('session-idem')!.metadata.run)).toBe(runAfterFirst);
    expect(h.proposal('proposal-a')!.status).toBe('expired');
  });

  it('does no maintenance and no unbounded scan when a session has no current-goal waiting approval step', async () => {
    const metadata = coordinatorMetadata([coordinatorStep({ id: 'read-only', effect: 'safe_read', outcome: 'completed' })]);
    const h = createHarness({
      proposals: [proposalRow({ id: 'proposal-idle', status: 'approved', expiresAt: PAST })],
      sessions: [sessionRow({ id: 'session-idle', metadata })],
    });

    await h.research.getSession(ctx, 'session-idle');
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();
    expect(h.proposalFindMany).not.toHaveBeenCalled();
    expect(h.proposal('proposal-idle')!.status).toBe('approved');

    // The owner's exact-ID seam is a no-op for the empty set too.
    expect(await h.owner.settleExactOwnedApprovals(ctx, [])).toEqual([]);
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();
    expect(h.proposalFindMany).not.toHaveBeenCalled();
  });

  it('without an attached owner the status-only fallback stays readable but performs no expiry maintenance', async () => {
    const waitingApproved = coordinatorMetadata([
      coordinatorStep({ id: 'approve-stale', proposalId: 'proposal-stale' }),
    ]);
    const waitingExpired = coordinatorMetadata([
      coordinatorStep({ id: 'approve-expired', proposalId: 'proposal-expired' }),
    ]);
    const h = createHarness({
      attachOwner: false,
      proposals: [
        proposalRow({ id: 'proposal-stale', status: 'approved', expiresAt: PAST }),
        proposalRow({ id: 'proposal-expired', status: 'expired', expiresAt: PAST }),
      ],
      sessions: [
        sessionRow({ id: 'session-legacy-stale', metadata: waitingApproved }),
        sessionRow({ id: 'session-legacy-expired', metadata: waitingExpired }),
      ],
    });

    // A time-expired proposal that was never transitioned stays unresolved: no
    // fabricated expired status and no maintenance from the research owner.
    await h.research.getSession(ctx, 'session-legacy-stale');
    expect(h.proposal('proposal-stale')!.status).toBe('approved');
    expect(storedStep(h.session('session-legacy-stale')!.metadata, 'approve-stale')?.outcome).toBe(
      'waiting_for_approval',
    );

    // An already-stored terminal status is still readable through the fallback.
    await h.research.getSession(ctx, 'session-legacy-expired');
    expect(h.proposal('proposal-expired')!.status).toBe('expired');
    expect(storedStep(h.session('session-legacy-expired')!.metadata, 'approve-expired')?.outcome).toBe(
      'cancelled',
    );
    expect(
      storedStep(h.session('session-legacy-expired')!.metadata, 'approve-expired')?.failureCode,
    ).toBe('approval_expired');

    // The absent-owner path never runs maintenance.
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();
  });

  it('honors current owner, client scope and origin binding before any maintenance for foreign or changed-origin sessions', async () => {
    const foreignMetadata = coordinatorMetadata([
      coordinatorStep({ id: 'approve-foreign', proposalId: 'proposal-foreign' }),
    ]);
    const originMetadata = {
      ...coordinatorMetadata([
        coordinatorStep({ id: 'approve-origin', proposalId: 'proposal-origin' }),
      ]),
      handoff: {
        version: 1,
        capturedAt: new Date().toISOString(),
        conversationId: 'conversation-archived',
        clientId: null,
        reasoningMode: 'standard',
        requestedDeliverable: 'brief',
        summary: null,
        summaryUpToMessageId: null,
        messages: [],
        attachments: [],
      },
    };
    const h = createHarness({
      proposals: [
        proposalRow({ id: 'proposal-foreign', status: 'approved', expiresAt: PAST }),
        proposalRow({ id: 'proposal-origin', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [
        sessionRow({ id: 'session-foreign', tenantId: 'tenant-other', metadata: foreignMetadata }),
        sessionRow({ id: 'session-origin', metadata: originMetadata }),
      ],
      conversations: [
        {
          id: 'conversation-archived',
          tenantId: TENANT,
          userId: USER,
          clientId: null,
          archivedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    });

    await expect(h.research.getSession(ctx, 'session-foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.research.getSession(ctx, 'session-origin')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // No maintenance ran before authorization failed.
    expect(h.proposal('proposal-foreign')!.status).toBe('approved');
    expect(h.proposal('proposal-origin')!.status).toBe('approved');
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();

    // listSessions drops both and still performs no maintenance.
    const listed = (await h.research.listSessions(ctx)) as unknown[];
    expect(listed).toEqual([]);
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();
  });
});
