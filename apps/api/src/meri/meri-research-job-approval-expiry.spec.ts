import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
  admitDurableResearchCoordinator,
  readDurableResearchCoordinator,
  recordDurableResearchApprovalProposal,
  type DurableResearchCoordinatorStepV1,
  type DurableResearchCoordinatorV1,
} from './meri-research-coordinator';
import type { ResearchPlanV1 } from './meri-research-plan';
import { RESEARCH_PLAN_LIMITS } from './meri-research-plan';
import {
  admitResearchProviderBudget,
  readResearchProviderBudget,
  reserveResearchProviderAttempt,
} from './meri-research-tool-budget';

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

// Clock-relative dates: a proposal one day in the past is always <= `new Date()`
// at predicate time, and one a year ahead is always beyond any test's duration,
// so the real Date predicates never depend on the calendar date of execution.
const CLOCK = Date.now();
const PAST = new Date(CLOCK - 24 * 60 * 60 * 1000);
const FUTURE = new Date(CLOCK + 365 * 24 * 60 * 60 * 1000);

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
  goalRevision = 0,
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
      goalRevision,
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
  actionsEnabled?: boolean;
  /** Result of the real ethical-wall query; true (allowed) by default. */
  clientMemoryAllowedValue?: boolean;
  /**
   * A genuine concurrent writer that mutates the stored sessions before the
   * next metadata compare-and-swap is evaluated, so the CAS predicate really
   * loses. Applied exactly once.
   */
  interveningSessionChange?: (sessions: SessionRow[]) => SessionRow[];
}

function createHarness(options: HarnessOptions = {}) {
  let proposals = options.proposals ?? [];
  let sessions = options.sessions ?? [];
  const conversations = options.conversations ?? [];
  let casLossOnce = options.casLossOnce ?? false;
  let interveningSessionChange = options.interveningSessionChange;

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
      // A concurrent writer that changes the stored metadata between the read
      // and this write makes the compare-and-swap `metadata.equals` predicate
      // genuinely false, so it is evaluated against the fresh row below.
      if (interveningSessionChange) {
        const change = interveningSessionChange;
        interveningSessionChange = undefined;
        sessions = change(sessions);
      }
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
    // The ethical-wall check is a raw query: `{ allowed: false }` is an honest
    // "no grant row", which `clientMemoryAllowed` reads as DENIED.
    $queryRawUnsafe: jest.fn(async () => [{ allowed: options.clientMemoryAllowedValue ?? true }]),
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
      key === 'MERIV2_ACTION_PROPOSALS_ENABLED' ? (options.actionsEnabled ?? true) : undefined,
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

  const RUN_STATE = {
    id: 'run-1',
    leaseEpoch: 1,
    eventSequence: 0,
    phase: 'research',
    status: 'running',
    stage: 'Waiting for approval',
    startedAt: new Date(CLOCK).toISOString(),
    heartbeatAt: new Date(CLOCK).toISOString(),
  };

  /**
   * Seed a current-goal waiting coordinator through the REAL admission and
   * record helpers (not a hand-written coordinator), then optionally retain
   * defensive stale entries. The admitted current plan is always <= maxSteps;
   * stale/foreign cases use separate controls instead of an impossible plan.
   */
  function admittedWaitingMetadata(
    current: Array<{ id: string; proposalId: string }>,
    options: {
      staleSteps?: DurableResearchCoordinatorStepV1[];
      staleHistory?: DurableResearchCoordinatorStepV1[];
    } = {},
  ): Record<string, unknown> {
    const plan: ResearchPlanV1 = {
      version: 1,
      title: 'Approve the prepared items',
      scope: {
        sessionId: 'session-admitted',
        tenantId: TENANT,
        actorId: USER,
        clientId: null,
        conversationId: null,
      },
      budget: { toolCalls: current.length, tokens: current.length * 1_000 },
      steps: current.map((step) => ({
        id: step.id,
        objective: `Approve ${step.id}`,
        dependsOn: [],
        requiredEvidenceDomains: ['client_context'],
        allowedCapabilities: ['send_email'],
        effect: 'approval_required',
        completionCondition: 'A proposal exists; nothing is sent before approval.',
        budget: { toolCalls: 1, tokens: 1_000 },
      })),
      clarifyingQuestions: [],
    };
    expect(plan.steps.length).toBeLessThanOrEqual(RESEARCH_PLAN_LIMITS.maxSteps);
    const admitted = admitDurableResearchCoordinator({
      metadata: { run: RUN_STATE },
      plan,
      objective: 'Approve the prepared items',
      run: { leaseEpoch: RUN_STATE.leaseEpoch, eventSequence: RUN_STATE.eventSequence },
    });
    let metadata: Record<string, unknown> = admitted.metadata;
    for (const step of current) {
      metadata = recordDurableResearchApprovalProposal({
        metadata,
        stepId: step.id,
        proposalId: step.proposalId,
      }).metadata;
    }
    const staleSteps = options.staleSteps ?? [];
    const staleHistory = options.staleHistory ?? [];
    if (!staleSteps.length && !staleHistory.length) return metadata;
    const coordinator = structuredClone(
      (metadata as { durableCoordinator: DurableResearchCoordinatorV1 }).durableCoordinator,
    );
    const goalRevision = coordinator.goalRevision + 1;
    return {
      ...metadata,
      durableCoordinator: {
        ...coordinator,
        goalRevision,
        steps: [...coordinator.steps.map((step) => ({ ...step, goalRevision })), ...staleSteps],
        stepHistory: [...coordinator.stepHistory, ...staleHistory],
      },
    };
  }

  function handoffFixture(conversationId: string) {
    return {
      version: 1,
      capturedAt: new Date(CLOCK).toISOString(),
      conversationId,
      clientId: null,
      reasoningMode: 'standard',
      requestedDeliverable: 'brief',
      summary: null,
      summaryUpToMessageId: null,
      messages: [],
      attachments: [],
    };
  }

  it('settles only exact owned current-goal proposals, excluding a foreign-tenant proposal, another user and a stale-goal entry, and deduplicating repeated references into one batch', async () => {
    const metadata = admittedWaitingMetadata(
      [
        { id: 'step-dup-a', proposalId: 'proposal-dup' },
        { id: 'step-dup-b', proposalId: 'proposal-dup' },
        { id: 'step-tenant-foreign', proposalId: 'proposal-tenant-foreign' },
        { id: 'step-other-user', proposalId: 'proposal-other-user' },
      ],
      {
        staleSteps: [
          coordinatorStep({ id: 'step-oldgoal', proposalId: 'proposal-oldgoal', goalRevision: 0 }),
        ],
        staleHistory: [
          coordinatorStep({
            id: 'step-stale',
            proposalId: 'proposal-stale',
            goalRevision: 0,
            outcome: 'superseded',
          }),
        ],
      },
    );
    const h = createHarness({
      proposals: [
        proposalRow({ id: 'proposal-dup', status: 'approved', expiresAt: PAST }),
        proposalRow({
          id: 'proposal-tenant-foreign',
          status: 'approved',
          expiresAt: PAST,
          tenantId: 'tenant-other',
        }),
        proposalRow({
          id: 'proposal-other-user',
          status: 'approved',
          expiresAt: PAST,
          userId: OTHER_USER,
        }),
        proposalRow({ id: 'proposal-oldgoal', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [sessionRow({ id: 'session-cross-tenant', metadata })],
    });

    await h.research.listSessions(ctx);

    // The maintenance update is one deduplicated exact-ID owner predicate.
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
    const requested = updateWhere.id?.in ?? [];
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested.filter((id) => id === 'proposal-dup')).toHaveLength(1);
    expect(sortedIds(requested)).toEqual(
      sortedIds(['proposal-dup', 'proposal-tenant-foreign', 'proposal-other-user']),
    );
    // The stale-goal proposal is never requested even though its step is in steps.
    expect(requested).not.toContain('proposal-oldgoal');

    // The owner read carries the same exact-ID + owner restriction.
    const readWhere = h.proposalFindMany.mock.calls[0]![0].where as {
      id?: { in?: string[] };
      tenantId?: string;
      userId?: string;
    };
    expect(readWhere.tenantId).toBe(TENANT);
    expect(readWhere.userId).toBe(USER);
    expect(sortedIds(readWhere.id?.in ?? [])).toEqual(
      sortedIds(['proposal-dup', 'proposal-tenant-foreign', 'proposal-other-user']),
    );

    // Only the exact owned current-goal proposal changed; every other row is intact.
    expect(h.proposal('proposal-dup')!.status).toBe('expired');
    expect(h.proposal('proposal-tenant-foreign')!.status).toBe('approved');
    expect(h.proposal('proposal-other-user')!.status).toBe('approved');
    expect(h.proposal('proposal-oldgoal')!.status).toBe('approved');
    for (const row of h.getProposals()) expect(row.attemptCount).toBe(0);

    const coordinator = readDurableResearchCoordinator(h.session('session-cross-tenant')!.metadata)!;
    const byId = new Map(coordinator.steps.map((step) => [step.id, step]));
    // Settlement is truthful for both duplicate references to the same proposal.
    expect(byId.get('step-dup-a')?.outcome).toBe('cancelled');
    expect(byId.get('step-dup-a')?.failureCode).toBe('approval_expired');
    expect(byId.get('step-dup-b')?.outcome).toBe('cancelled');
    expect(byId.get('step-dup-b')?.failureCode).toBe('approval_expired');
    // Foreign-tenant / other-user / stale-goal steps stay unresolved.
    expect(byId.get('step-tenant-foreign')?.outcome).toBe('waiting_for_approval');
    expect(byId.get('step-other-user')?.outcome).toBe('waiting_for_approval');
    expect(byId.get('step-oldgoal')?.goalRevision).toBe(0);
    expect(byId.get('step-oldgoal')?.outcome).toBe('waiting_for_approval');
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('serves an exact owned expired receipt through the public read while new actions are disabled, without enabling create, approve, execute or reconcile', async () => {
    const metadata = coordinatorMetadata([
      coordinatorStep({ id: 'approve-disabled', proposalId: 'proposal-disabled' }),
    ]);
    const h = createHarness({
      actionsEnabled: false,
      proposals: [proposalRow({ id: 'proposal-disabled', status: 'approved', expiresAt: PAST })],
      sessions: [sessionRow({ id: 'session-disabled', metadata })],
    });

    await h.research.getSession(ctx, 'session-disabled');
    expect(h.proposal('proposal-disabled')!.status).toBe('expired');
    expect(storedStep(h.session('session-disabled')!.metadata, 'approve-disabled')?.outcome).toBe(
      'cancelled',
    );
    expect(
      storedStep(h.session('session-disabled')!.metadata, 'approve-disabled')?.failureCode,
    ).toBe('approval_expired');

    await h.research.listSessions(ctx);
    const snapshot = (await h.research.getCoordinatorSnapshot(ctx, 'session-disabled')) as unknown as {
      coordinator: { steps: Array<{ id: string; outcome: string }> };
    };
    expect(snapshot.coordinator.steps.find((step) => step.id === 'approve-disabled')?.outcome).toBe(
      'cancelled',
    );

    // The new-action surface stays disabled: only the historical receipt read is open.
    await expect(h.owner.list(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('a genuine intervening metadata change makes the session compare-and-swap lose, and the next read settles only the new current goal', async () => {
    const goalA = coordinatorMetadata([
      coordinatorStep({ id: 'step-a', proposalId: 'proposal-a' }),
    ]);
    const goalB = coordinatorMetadata(
      [coordinatorStep({ id: 'step-b', proposalId: 'proposal-b', goalRevision: 1 })],
      [
        coordinatorStep({
          id: 'step-a',
          proposalId: 'proposal-a',
          goalRevision: 0,
          outcome: 'superseded',
        }),
      ],
      1,
    );
    const h = createHarness({
      interveningSessionChange: (sessions) =>
        sessions.map((row) =>
          row.id === 'session-intervening' ? { ...row, metadata: structuredClone(goalB) } : row,
        ),
      proposals: [
        proposalRow({
          id: 'proposal-a',
          status: 'approved',
          expiresAt: PAST,
          resultSummary: { receipt: 'old-a', untouched: true },
        }),
        proposalRow({ id: 'proposal-b', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [sessionRow({ id: 'session-intervening', metadata: goalA })],
    });

    await h.research.getSession(ctx, 'session-intervening');

    // The first read did run old-goal maintenance before the CAS was attempted;
    // cross-row serializability is not claimed.
    expect(h.proposal('proposal-a')!.status).toBe('expired');
    expect(h.proposal('proposal-b')!.status).toBe('approved');
    // The CAS could not overwrite the concurrent writer's stored metadata,
    expect(h.session('session-intervening')!.metadata).toEqual(goalB);
    // and the immutable old receipt survived.
    expect(h.proposal('proposal-a')!.resultSummary).toEqual({ receipt: 'old-a', untouched: true });
    const first = readDurableResearchCoordinator(h.session('session-intervening')!.metadata)!;
    expect(first.steps.map((step) => step.id)).toEqual(['step-b']);
    expect(first.steps[0]!.outcome).toBe('waiting_for_approval');
    // The old-goal step was never relinked into current work.
    expect(first.stepHistory.find((step) => step.id === 'step-a')!.outcome).toBe('superseded');

    // A fresh public read settles only the new current goal's proposal.
    await h.research.getSession(ctx, 'session-intervening');
    expect(h.proposal('proposal-b')!.status).toBe('expired');
    const after = readDurableResearchCoordinator(h.session('session-intervening')!.metadata)!;
    expect(after.steps.map((step) => step.id)).toEqual(['step-b']);
    expect(after.steps[0]!.outcome).toBe('cancelled');
    expect(after.steps[0]!.failureCode).toBe('approval_expired');
    expect(after.stepHistory.find((step) => step.id === 'step-a')!.outcome).toBe('superseded');
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('preserves a seeded provider-budget ledger across public waiting and settlement reads without incurring a new charge', async () => {
    const deadline = new Date(CLOCK + 30 * 24 * 60 * 60 * 1000).toISOString();
    const limits = { maxAttempts: 4, maxTokens: 100_000, maxCostMicros: 5_000_000, deadlineAt: deadline };
    const seedBudget = (base: Record<string, unknown>) => {
      const admitted = admitResearchProviderBudget(base, limits).metadata;
      return reserveResearchProviderAttempt({
        metadata: admitted,
        run: { id: RUN_STATE.id, leaseEpoch: RUN_STATE.leaseEpoch },
        limits,
        binding: {
          logicalOperationId: 'op-1',
          attemptId: 'attempt-1',
          retryOfAttemptId: null,
          kind: 'anthropic_messages',
          phase: 'research',
          provider: 'anthropic',
          model: 'claude-sonnet',
          maxInputTokens: 1_000,
          maxOutputTokens: 500,
        },
        price: { inputPerM: 3, outputPerM: 15 },
        now: new Date(CLOCK),
        reservationId: 'res-1',
      }).metadata;
    };
    const waitingMeta = seedBudget(
      coordinatorMetadata([coordinatorStep({ id: 'step-wait', proposalId: 'proposal-future' })]),
    );
    const settleMeta = seedBudget(
      coordinatorMetadata([coordinatorStep({ id: 'step-settle', proposalId: 'proposal-expired' })]),
    );
    const beforeWaiting = structuredClone(readResearchProviderBudget(waitingMeta)!);
    const beforeSettle = structuredClone(readResearchProviderBudget(settleMeta)!);
    expect(beforeWaiting.chargedAttempts).toBe(1);
    expect(beforeWaiting.chargedTokens).toBeGreaterThan(0);
    expect(beforeWaiting.chargedCostMicros).toBeGreaterThan(0);
    expect(beforeWaiting.attempts).toHaveLength(1);

    const h = createHarness({
      proposals: [
        proposalRow({ id: 'proposal-future', status: 'approved', expiresAt: FUTURE }),
        proposalRow({ id: 'proposal-expired', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [
        sessionRow({ id: 'session-budget-wait', metadata: waitingMeta }),
        sessionRow({ id: 'session-budget-settle', metadata: settleMeta }),
      ],
    });

    await h.research.getSession(ctx, 'session-budget-wait');
    await h.research.getSession(ctx, 'session-budget-settle');

    // Waiting leaves the whole ledger and the proposal untouched.
    expect(readResearchProviderBudget(h.session('session-budget-wait')!.metadata)).toEqual(
      beforeWaiting,
    );
    expect(h.proposal('proposal-future')!.status).toBe('approved');
    expect(
      storedStep(h.session('session-budget-wait')!.metadata, 'step-wait')?.outcome,
    ).toBe('waiting_for_approval');

    // Settlement also leaves the ledger untouched.
    expect(readResearchProviderBudget(h.session('session-budget-settle')!.metadata)).toEqual(
      beforeSettle,
    );
    expect(h.proposal('proposal-expired')!.status).toBe('expired');
    expect(h.proposal('proposal-expired')!.attemptCount).toBe(0);
    expect(
      storedStep(h.session('session-budget-settle')!.metadata, 'step-settle')?.outcome,
    ).toBe('cancelled');

    // No model/provider/effect port was invoked to fabricate a reservation.
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });

  it('fails closed before maintenance when the client wall denies the actor or the originating conversation no longer binds', async () => {
    const walledMetadata = coordinatorMetadata([
      coordinatorStep({ id: 'approve-walled', proposalId: 'proposal-walled' }),
    ]);
    const originMetadata = {
      ...coordinatorMetadata([
        coordinatorStep({ id: 'approve-origin-client', proposalId: 'proposal-origin-client' }),
      ]),
      handoff: handoffFixture('conversation-other-client'),
    };
    const h = createHarness({
      clientMemoryAllowedValue: false,
      proposals: [
        proposalRow({ id: 'proposal-walled', status: 'approved', expiresAt: PAST }),
        proposalRow({ id: 'proposal-origin-client', status: 'approved', expiresAt: PAST }),
      ],
      sessions: [
        sessionRow({ id: 'session-walled', clientId: 'client-walled', metadata: walledMetadata }),
        sessionRow({ id: 'session-origin-client', clientId: null, metadata: originMetadata }),
      ],
      conversations: [
        {
          id: 'conversation-other-client',
          tenantId: TENANT,
          userId: USER,
          clientId: 'client-other',
          archivedAt: null,
        },
      ],
    });

    await expect(h.research.getSession(ctx, 'session-walled')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.research.getSession(ctx, 'session-origin-client')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Neither authorization failure ran maintenance first.
    expect(h.proposal('proposal-walled')!.status).toBe('approved');
    expect(h.proposal('proposal-origin-client')!.status).toBe('approved');
    expect(h.proposalUpdateMany).not.toHaveBeenCalled();
    expect(h.failIfCalled).not.toHaveBeenCalled();
  });
});
