import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EventEmitter } from 'node:events';
import { createObjectiveStrategyRequestCodec } from '@capiro/shared/objective-strategy-intake';
import { createPlannerApplicationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';

export const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const codec = createObjectiveStrategyRequestCodec({ sha256, invalidRequest: () => { throw Error('invalid'); } });
export const hash = createPlannerApplicationCodec({ sha256, isProxy: types.isProxy }).applicationHash;

/** Synthetic persisted owner rows; all authorization/codec/service code is real. */
export function objectiveJobFixture() {
  const snapshot = { id: id(3), clientId: id(2), version: 7, status: 'ready', deletedAt: null };
  const request = { requestId: id(1), clientId: id(2), objective: { objectiveId: id(3), objectiveVersion: 7 }, type: 'earmark' };
  const command = { schemaVersion: 1, requestId: id(16), command: 'retry', workAction: 'objective.strategy.draft',
    expectedObjectiveVersion: 7, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null };
  const wrapper = { schemaVersion: 2, command, selection: { type: request.type, generationRequestId: request.requestId } };
  const common = { tenant_id: id(9), client_id: id(2), objective_id: id(3), work_action: 'objective.strategy.draft',
    canonical_plan_id: id(11), canonical_epoch: 1, canonical_strategy_id: id(12), canonical_project_id: id(13),
    canonical_binding_version: 1, root_intent_id: id(14), source_revision_id: id(8), source_objective_version: 7,
    source_snapshot_hash: hash(snapshot), root_actor_user_id: id(17) };
  const intake: any = { ...common, id: id(4), control_id: id(18), consent_id: id(6), command_receipt_id: id(7),
    command_request_id: id(16), actor_user_id: id(15), actor_membership_id: id(19), original_clerk_user_id: 'user_original',
    control_version: 1, selected_type: request.type, generation_request_id: id(1), wrapper,
    wrapper_sha256: codec.digest({ clientId: id(2), objectiveId: id(3), body: wrapper }),
    typed_request: request, request_fingerprint: codec.digest(request), job_request_key: codec.requestKey(id(9), 'user_original', id(1)),
    generation_job_id: id(5) };
  const consent: any = { ...common, id: id(6), control_id: id(18), command_receipt_id: id(7),
    consenting_actor_user_id: id(15), consenting_membership_id: id(19), command_request_id: id(16), payload_digest: 'b'.repeat(64),
    confirmed_at: new Date(800).toISOString(), configured_duration_ms: 5000, effective_duration_ms: 5000,
    stricter_expires_at: null, consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1 };
  const receipt: any = { ...common, id: id(7), created_consent_id: id(6), result_consent_id: id(6), control_version_after: 1,
    actor_user_id: id(15), actor_membership_id: id(19), command_kind: 'retry', outcome: 'reconsent_recorded',
    request_id: id(16), command, payload_digest: 'b'.repeat(64), committed_at: new Date(900).toISOString() };
  const row: any = { intake, consent, receipt, snapshot, deadlineMs: '5000', reservedMs: '1000', consentExpiresMs: '5000' };
  const binding = { tenantId: id(9), actorId: id(15), conversationId: id(20), runId: id(21), attemptId: id(22), workerId: id(23), writerFence: 1 };
  const acceptance: any = { schemaVersion: 1, sourceBinding: binding, sourceAdmissionSha256: 'a'.repeat(64),
    sourceRequestSha256: 'b'.repeat(64), acceptedAtMs: 1500, effectExpiresAtMs: 4500 };
  const job: any = { id: id(5), tenantId: id(9), clientId: id(2), ownerUserId: 'user_original', status: 'running', attempt: 2,
    claimedBy: `canonical:${hash(binding)}`, claimedAt: new Date(1500), requestKey: intake.job_request_key, deadlineAtMs: '5000',
    input: { bearer: null, objectiveGeneration: { request, fingerprint: codec.digest(request) } } };
  const state = { now: 2000, member: true, wall: true, objective: true, controls: true, acceptance: true };
  const member = { userId: id(15), membershipId: id(19), tenantSlug: 'synthetic', role: 'standard_user', memoryWall: true };
  const control = { version: 1, consentId: id(6), cancelled: false, sourceCurrent: true };
  const calls: string[] = [];
  const tx: any = {
    async $queryRawUnsafe(sql: string, ...args: unknown[]) {
      calls.push(sql);
      if (sql.includes('FROM sp_draft_job')) return sql.includes('FOR UPDATE') ? [job] : [{ tenantId: id(9) }];
      if (sql.includes('to_jsonb(i)')) return [row];
      if (sql.includes('SELECT id::text AS id') && sql.includes('client_objective_strategy_intakes')) return [{ id: id(4) }];
      if (sql.includes('clock_timestamp')) return [{ nowMs: String(state.now) }];
      if (sql.includes('FOR SHARE OF ctl')) return state.controls ? [control] : [];
      if (sql.includes('FROM sp_planner_resources')) return state.acceptance ? [{ data: acceptance }] : [];
      throw Error('Unexpected SQL owner');
    },
    async $queryRaw(parts: TemplateStringsArray) {
      const sql = parts.join('?'); calls.push(sql);
      if (sql.includes('JOIN tenant_memberships')) return state.member ? [member] : [];
      if (sql.includes('FROM client_memory_access')) return state.wall ? [{ id: id(24) }] : [];
      if (sql.includes('FROM client_objectives')) return state.objective ? [{ version: 7 }] : [];
      throw Error('Unexpected tagged SQL owner');
    },
  };
  const prisma: any = { withSystem: (f: any) => f(tx), withTenant: (_t: string, f: any) => f(tx) };
  const req: any = Object.assign(new EventEmitter(), { headers: { 'x-internal-service-secret': 'synthetic-test-secret',
    'x-meri-deadline-at': '4000' }, aborted: false, complete: true });
  const guard = new InternalServiceGuard({ get: () => 'synthetic-test-secret' } as never);
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  const policyRevision = 'synthetic-current-policy';
  const context = { binding, subject: { kind: 'client', entityType: 'client', entityIds: [id(2)], tenantId: id(9), actorId: id(15),
    policyRevision, scopes: [{ tenantId: id(9), kind: 'client', resourceId: id(2), policyRevision }], rosterVersionId: null },
    policyRevision, normalizationContext: null };
  return { row, job, member, control, acceptance, state, calls, tx, prisma, req, context };
}
