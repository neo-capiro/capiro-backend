import { types as nodeTypes } from 'node:util';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ObjectiveWorkloadIssuanceError, type ObjectiveIssuanceSelector } from './objective-workload-issuance.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  type ObjectiveWorkloadRequestBinding } from './objective-workload-jwt.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9:._-]{0,127}$/;
const unavailable = (): never => { throw new ObjectiveWorkloadIssuanceError('UNAVAILABLE'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.exec(value)?.[0] === value;
export const OBJECTIVE_ADMISSION_TARGET_PATH = '/strategy-api/internal/objective-canonical/generation-admissions';
export interface ObjectiveAdmissionSource {
  readonly selector: ObjectiveIssuanceSelector;
  readonly binding: ObjectiveWorkloadRequestBinding;
}
/** Routing observation only. The durable issuer must independently lock and
 * recheck the original native source before it can allocate or release a token. */
export interface ObjectiveAdmissionSourceHint {
  readonly generationJobId: string;
  readonly operationId: string;
  readonly callerIssuer: string;
  readonly callerSubject: string;
  readonly issuanceRequestSha256: string;
}
export type ObjectiveAdmissionSourceResolver = (hint: ObjectiveAdmissionSourceHint) => Promise<ObjectiveAdmissionSource>;
type Route = { generationJobId: string; tenantId: string; clientId: string; objectiveId: string;
  delegationRef: string; consentId: string; clerkUserId: string; workAction: string;
  serviceSubject: string; audience: string };
const KEYS: readonly (keyof Route)[] = ['generationJobId', 'tenantId', 'clientId', 'objectiveId',
  'delegationRef', 'consentId', 'clerkUserId', 'workAction', 'serviceSubject', 'audience'];

function route(raw: unknown, jobId: string): Route {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== KEYS.length)
    return unavailable();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of KEYS) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    captured[key] = d.value;
  }
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !KEYS.includes(key as keyof Route)) ||
      !['generationJobId', 'tenantId', 'clientId', 'objectiveId', 'delegationRef', 'consentId']
        .every(key => uuid(captured[key])) || captured.generationJobId !== jobId ||
      typeof captured.clerkUserId !== 'string' || captured.clerkUserId.length < 1 || captured.clerkUserId.length > 128 ||
      captured.workAction !== 'objective.strategy.draft' || captured.serviceSubject !== OBJECTIVE_GENERATION_WORKER_SUBJECT ||
      captured.audience !== OBJECTIVE_STRATEGY_AUDIENCE) return unavailable();
  return captured as unknown as Route;
}

/** Fixed server-derived target bytes. This observes no current permission. */
function resolved(r: Route): ObjectiveAdmissionSource {
  const selector: ObjectiveIssuanceSelector = Object.freeze({ tenantId: r.tenantId, delegationRef: r.delegationRef,
    consentId: r.consentId, generationJobId: r.generationJobId, phase: 'admit' });
  return Object.freeze({ selector, binding: Object.freeze({ subject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
    audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: OBJECTIVE_ADMISSION_TARGET_PATH, query: '',
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, generationJobId: r.generationJobId }), 'utf8'),
    operation: 'objective.strategy.draft', phase: 'admit', tenantId: r.tenantId,
    generationJobId: r.generationJobId, delegationRef: r.delegationRef, consentId: r.consentId,
    attemptId: null, runId: null, acceptedBindingSha256: null, sourceSha256: null }) });
}

/** Disabled-by-default native routing resolver, now composed by the admission
 * runtime behind its hard-disabled production provider. Invoke ONLY after
 * the ingress verifies the named generation worker's exact raw caller proof.
 * A global immutable job UUID is a hint, never a caller-selected tenant/ref.
 * Successful cross-tenant routing is audited in the SAME system transaction.
 * Unknown/ambiguous scope rolls back: it has no invented audit tenant, global
 * operation denial or successful audit claim. No delegation is created/enabled.
 */
export function createPrismaObjectiveAdmissionSource(prisma: Pick<PrismaService, 'withSystem'>,
  options: { enabled?: boolean } = {}): ObjectiveAdmissionSourceResolver {
  const enabled = options.enabled === true;
  return async rawHint => {
    if (!enabled) return unavailable();
    if (!rawHint || typeof rawHint !== 'object' || Array.isArray(rawHint) || nodeTypes.isProxy(rawHint) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(rawHint))) return unavailable();
    const hintKeys = ['generationJobId', 'operationId', 'callerIssuer', 'callerSubject', 'issuanceRequestSha256'];
    if (Reflect.ownKeys(rawHint).length !== hintKeys.length) return unavailable();
    const hint: Record<string, unknown> = Object.create(null);
    for (const key of hintKeys) {
      const d = Object.getOwnPropertyDescriptor(rawHint, key);
      if (!d || !d.enumerable || !('value' in d)) return unavailable(); hint[key] = d.value;
    }
    if (Reflect.ownKeys(rawHint).some(key => typeof key !== 'string' || !hintKeys.includes(key)) ||
        !uuid(hint.generationJobId) || !uuid(hint.operationId) ||
        typeof hint.callerIssuer !== 'string' || NAME.exec(hint.callerIssuer)?.[0] !== hint.callerIssuer ||
        hint.callerSubject !== OBJECTIVE_GENERATION_WORKER_SUBJECT || typeof hint.issuanceRequestSha256 !== 'string' ||
        SHA.exec(hint.issuanceRequestSha256)?.[0] !== hint.issuanceRequestSha256) return unavailable();
    const generationJobId = hint.generationJobId;
    return prisma.withSystem(async tx => {
      const rows = await tx.$queryRaw<Route[]>`SELECT j.id::text AS "generationJobId",j.tenant_id::text AS "tenantId",
        j.client_id::text AS "clientId",d.objective_id::text AS "objectiveId",d.delegation_ref::text AS "delegationRef",
        d.consent_id::text AS "consentId",j.owner_user_id AS "clerkUserId",d.work_action AS "workAction",
        d.service_subject AS "serviceSubject",d.audience
        FROM sp_draft_job j JOIN client_objective_workload_delegations d ON d.generation_job_id=j.id
          AND d.tenant_id=j.tenant_id AND d.client_id=j.client_id AND d.clerk_user_id=j.owner_user_id
        WHERE j.id=${generationJobId}::uuid LIMIT 2`;
      if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
      const r = route(rows[0], generationJobId);
      // The tenant-scoped issuer may not see a permanent decision belonging to
      // another tenant. Refuse an observed re-routing before JTI allocation.
      // This observes an existing fence; it creates no global denial/authority.
      // A routing snapshot can race: the native global PK and durable claim
      // transaction remain the ultimate no-second-sign/commit fence.
      const decisions = await tx.$queryRaw<Array<Record<string, unknown>>>`SELECT operation_id::text AS "operationId",
        caller_issuer AS "callerIssuer",caller_subject AS "callerSubject",issuance_request_sha256 AS "requestSha256",
        decision,resolved_tenant_id::text AS "tenantId",generation_job_id::text AS "generationJobId",phase
        FROM client_objective_workload_issue_decisions WHERE operation_id=${hint.operationId}::uuid`;
      if (!Array.isArray(decisions) || decisions.length > 1) return unavailable();
      if (decisions.length === 1) {
        const d = decisions[0]!;
        if (d.operationId !== hint.operationId || d.callerIssuer !== hint.callerIssuer || d.callerSubject !== hint.callerSubject ||
            d.requestSha256 !== hint.issuanceRequestSha256 || d.tenantId !== r.tenantId ||
            !['issued', 'denied'].includes(d.decision as string) ||
            d.decision === 'issued' && (d.generationJobId !== r.generationJobId || d.phase !== 'admit') ||
            d.decision === 'denied' && (d.generationJobId !== null || d.phase !== null)) return unavailable();
      }
      await tx.auditLog.create({ data: { tenantId: r.tenantId, actorUserId: null,
        actorRole: OBJECTIVE_GENERATION_WORKER_SUBJECT, action: 'objective_workload_admission_scope_resolved',
        entityType: 'strategy_draft_job', entityId: r.generationJobId } });
      return resolved(r);
    }, { timeoutMs: 3000 });
  };
}
