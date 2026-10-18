/** Disposable, non-live fixture. The application/shared authority code is real;
 * SQL responses and database rollback are explicit fixture models, not PostgreSQL qualification. */
import {
  digest,
  pendingReceipt,
  type ObjectiveDraftRequest,
  type ObjectiveAdmission,
} from './objective-generation.types.js';
import type { DraftJobInput } from './draft-job.types.js';
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function objectiveFixture() {
  const request: ObjectiveDraftRequest = {
    requestId: id(1),
    clientId: id(2),
    objective: { objectiveId: id(3), objectiveVersion: 7 },
    type: 'appropriations',
  };
  const source = {
    clientId: id(2),
    objectiveId: id(3),
    objectiveVersion: 7,
    objectiveRevisionId: id(4),
  };
  const actor = {
    tenantId: id(9),
    clerkUserId: 'user_fixture',
    tenantSlug: 'fixture',
    role: 'standard_user',
  } as any;
  const intent = {
    outcome: 'OUTCOME',
    governmentProblem: 'PROBLEM',
    askType: 'funding',
    minimumWin: 'MINIMUM',
    limits: 'LIMITS',
  };
  const snapshot = {
    id: id(3),
    clientId: id(2),
    version: 7,
    status: 'ready',
    deletedAt: null,
    ...intent,
  };
  const sources = {
    government_profile_support: [{ id: id(2), description: 'PROFILE' }],
    government_targets: [
      {
        id: id(20),
        member_id: 'member-1',
        source_directory: 'congress',
        tier: 1,
        committee: 'COMMITTEE',
        staff_kind: null,
      },
      {
        id: id(21),
        member_id: 'staff-2',
        source_directory: 'staff',
        tier: 3,
        committee: null,
        staff_kind: 'committee',
      },
    ],
    represented_facilities: [
      {
        id: id(22),
        name: 'FACILITY',
        employee_count: 9,
        state: 'CA',
        congressional_district: '40',
      },
    ],
    target_recommendations: [
      {
        id: id(23),
        computed_at: '2026-10-15T00:00:00Z',
        recommendations_jsonb: [{ memberId: 'member-1', score: 5, tags: ['TAG'], billCount: 1 }],
      },
    ],
    member_notes: [
      { id: id(24), directory_contact_id: 'member-1', body: 'TENANT_NOTE', scope: 'tenant_shared' },
    ],
    state_directory: [],
    mailbox_authority: [] as any[],
  };
  const receipt = pendingReceipt(request, source);
  receipt.context = {
    reobservedAt: null,
    state: 'complete',
    packetId: id(8),
    compiledAt: '2026-10-15T00:00:00Z',
    sourceDigest: digest({ source, intent }),
    coverageDigest: 'b'.repeat(64),
    inputDigest: 'c'.repeat(64),
    issues: [],
  };
  const input: DraftJobInput = {
    dto: { clientId: id(2), type: request.type, goal: 'OUTCOME' },
    bearer: null,
    objectiveGeneration: {
      request,
      fingerprint: digest(request),
      receipt,
      historyCheckedAt: '2026-10-15T00:00:59Z',
    },
  };
  const job: any = {
    id: id(5),
    tenantId: actor.tenantId,
    ownerUserId: actor.clerkUserId,
    clientId: id(2),
    input: structuredClone(input),
    claimToken: 'worker:claim-1',
    claimedBy: 'worker:claim-1',
    attempt: 2,
    status: 'running',
    strategyId: null,
    deadlineAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const state = {
    job: structuredClone(job),
    sources,
    snapshot,
    authorized: true,
    wall: false,
    grant: true,
    deadline: true,
    rowcount: 1,
    events: [] as string[],
  };
  const admission: ObjectiveAdmission = {
    tenantId: actor.tenantId,
    clerkUserId: actor.clerkUserId,
    requestId: request.requestId,
    type: request.type,
    source,
    intent,
    localDigest: digest(sources),
    externalDigest: 'd'.repeat(64),
    historyDigest: 'e'.repeat(64),
    historyObservedAt: '2026-10-15T00:00:00Z',
    contactIds: ['member-1', 'staff-2'],
    coverage: [],
    context: receipt.context,
  };
  const query = async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join('?');
    state.events.push(sql);
    if (sql.includes('FROM tenants'))
      return state.authorized ? [{ userId: id(10), memoryWall: state.wall }] : [];
    if (sql.includes('FROM client_memory_access')) return state.grant ? [{ id: id(11) }] : [];
    if (sql.includes('SELECT version FROM client_objectives'))
      return [{ version: state.snapshot.version }];
    if (sql.includes('SELECT id FROM client_objective_revisions')) return [{ id: id(4) }];
    if (sql.includes('SELECT snapshot FROM client_objective_revisions'))
      return [{ snapshot: state.snapshot }];
    if (sql.includes('AS sources')) return [{ sources: structuredClone(state.sources) }];
    if (sql.includes('FROM sp_draft_job') && sql.includes('FOR UPDATE'))
      return [
        {
          input: structuredClone(state.job.input),
          ownerUserId: state.job.ownerUserId,
          clientId: state.job.clientId,
          valid:
            state.job.status === 'running' &&
            state.job.claimedBy === values[0] &&
            state.job.attempt === values[1],
        },
      ];
    if (sql.includes('deadline_at > clock_timestamp()')) return [{ valid: state.deadline }];
    if (sql.includes('clock_timestamp() AS'))
      return [{ savedAt: new Date('2026-10-15T00:01:00Z') }];
    throw new Error(`Unhandled fixture SQL: ${sql}`);
  };
  const tx: any = {
    $queryRaw: query,
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      state.events.push(sql);
      if (sql.includes("SET status='completed'")) {
        const [strategyId, input, jobId, tenant, token, attempt] = values;
        if (
          state.rowcount !== 1 ||
          !state.deadline ||
          state.job.id !== jobId ||
          state.job.tenantId !== tenant ||
          state.job.claimedBy !== token ||
          state.job.attempt !== attempt ||
          state.job.status !== 'running' ||
          state.job.strategyId != null ||
          state.job.input.objectiveGeneration.receipt.result != null
        )
          return 0;
        Object.assign(state.job, {
          status: 'completed',
          stage: 'completed',
          progressText: 'Done',
          strategyId,
          errorMessage: null,
          streamPreview: null,
          input: JSON.parse(input),
        });
        return 1;
      }
      return 0;
    },
    spDraftJob: {
      updateMany: async ({ where, data }: any) => {
        if (
          state.rowcount !== 1 ||
          Object.entries(where).some(([key, value]) => state.job[key] !== value)
        )
          return { count: 0 };
        Object.assign(state.job, structuredClone(data));
        return { count: 1 };
      },
    },
  };
  return { request, source, actor, intent, input, job, admission, state, tx };
}
