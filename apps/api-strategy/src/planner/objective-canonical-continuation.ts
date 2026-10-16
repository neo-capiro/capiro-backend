import type { Prisma } from '../../generated/prisma-client/index.js';
import { canonicalGenerationProducer, parseCanonicalProducerRequest, producerApplication,
  requireCanonicalProducerWork, type CanonicalProducerWork } from '../meri/objective-canonical-producer.js';
import { readCanonicalSavedGeneration, requireSavedGenerationApplication } from '../meri/objective-canonical-saved-generation.js';
import { applicationHash, applicationObservation, applicationUuid, canonicalApplicationRequestId, CanonicalApplicationError,
  type CanonicalApplicationObservation, type CanonicalApplicationRequest, type CanonicalToken } from './objective-canonical-application.js';

/** Owner-read Planner consent, never copied from the Strategy generation grant.
 * This evidence is consistency input, not a credential. The existing Producer
 * and application owners must still check current authority and release fences. */
export interface CanonicalPlannerContinuationConsent {
  workAction: 'objective.plan.prepare';
  tenantId: string; actorUserId: string; clerkUserId: string; canonical: CanonicalToken;
  consentId: string; controlVersion: number;
}
type SavedGeneration = Awaited<ReturnType<typeof readCanonicalSavedGeneration>>;
const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => {
  throw new CanonicalApplicationError(code);
};
function closed(value: unknown, keys: string[]) {
  // Reject accessors/proxies/non-JSON values before inspecting properties.
  applicationHash(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
}

/** Rebuild the unchanged command from the ORIGINAL saved generation. No
 * browser-selected Strategy/version, application ID, digest or run is accepted.
 * readCanonicalSavedGeneration owns completion/normalization custody checks. */
export function savedGenerationPlannerContinuation(saved: SavedGeneration,
  consent: CanonicalPlannerContinuationConsent): CanonicalProducerWork {
  closed(consent, ['workAction', 'tenantId', 'actorUserId', 'clerkUserId', 'canonical', 'consentId', 'controlVersion']);
  const a = saved.admission, r = saved.receipt, result = r.objectiveReceipt.result;
  if (!result) return fail();
  if (consent.workAction !== 'objective.plan.prepare' || consent.tenantId !== a.canonical.tenantId ||
      consent.actorUserId !== a.actorUserId || consent.clerkUserId !== a.clerkUserId ||
      applicationHash(consent.canonical) !== applicationHash(a.canonical)) return fail('REQUEST_CONFLICT');
  const producer = canonicalGenerationProducer({ admission: a, acceptance: saved.acceptance,
    jobId: saved.producer.generation.jobId, requestId: saved.producer.generation.requestId,
    attempt: saved.producer.generation.attempt, coreFingerprint: saved.producer.generation.coreFingerprint,
    receipt: r.objectiveReceipt, strategyId: result.strategyId, strategyVersionId: result.strategyVersionId,
    snapshotDigest: r.snapshotDigest });
  if (applicationHash(producer) !== applicationHash(saved.producer) ||
      r.objectiveReceiptSha256 !== applicationHash(producer.objectiveReceipt)) return fail();
  const actual = requireSavedGenerationApplication(saved, consent.actorUserId, {
    schemaVersion: 1, canonical: a.canonical,
    applicationRequestId: canonicalApplicationRequestId(a.canonical, a.actorUserId),
    generationJobId: a.generationJobId, generationRequestId: a.generationRequestId,
    strategyId: result.strategyId, strategyVersionId: result.strategyVersionId,
    objectiveReceiptSha256: r.objectiveReceiptSha256, snapshotDigest: r.snapshotDigest,
  });
  const { schemaVersion: _schemaVersion, ...application } = actual;
  const work = parseCanonicalProducerRequest({ schemaVersion: 1, phase: 'prepare', work: {
    ...application, actorUserId: consent.actorUserId, consentId: consent.consentId, controlVersion: consent.controlVersion,
  } }).work;
  requireCanonicalProducerWork(producer, work);
  return work;
}

/** The caller holds the existing owner locks for this consistency read. This
 * opens no transaction, performs no external IO and creates no continuation row. */
export async function readCanonicalPlannerContinuation(tx: Prisma.TransactionClient,
  scope: { tenantId: string; clerkUserId: string; generationJobId: string },
  consent: CanonicalPlannerContinuationConsent): Promise<CanonicalProducerWork> {
  closed(scope, ['tenantId', 'clerkUserId', 'generationJobId']);
  applicationUuid(scope.tenantId); applicationUuid(scope.generationJobId);
  closed(consent, ['workAction', 'tenantId', 'actorUserId', 'clerkUserId', 'canonical', 'consentId', 'controlVersion']);
  const originalScope = structuredClone(scope), originalConsent = structuredClone(consent);
  return savedGenerationPlannerContinuation(await readCanonicalSavedGeneration(tx, originalScope), originalConsent);
}

/** Exact durable PLANNER operation identity from its existing owner. It is not
 * the Strategy generation's accepted run and must never be minted by a browser
 * or synthesized from a missing application receipt. Deadlines stay original. */
export interface CanonicalPlannerOriginalOperation {
  operationId: string; attemptId: string; runId: string; requestFingerprint: string;
  originalDeadlineAt: string; workSha256: string;
}
export interface CanonicalPlannerContinuationReconciliation {
  state: 'not_started' | 'accounted' | 'outcome_unconfirmed' | 'unavailable';
  original: CanonicalPlannerOriginalOperation;
  terminalReceiptId: string | null;
  outcome: 'applied' | 'failed' | 'cancelled' | null;
}
export interface CanonicalPlannerContinuationOwner {
  /** Authoritative original-operation observation under the existing owner
   * gate. not_started requires positive owner evidence, never null head/receipt,
   * timeout, elapsed deadline, stale heartbeat or a caller's status label. */
  reconcile(work: CanonicalProducerWork, original: CanonicalPlannerOriginalOperation): Promise<CanonicalPlannerContinuationReconciliation>;
  /** Use the existing application lookup with fresh retained-read authority. */
  lookup(request: CanonicalApplicationRequest, original: CanonicalPlannerOriginalOperation): Promise<CanonicalApplicationObservation>;
  /** One existing Producer/application-owner dispatch for this SAME original
   * operation. The owner must atomically recheck not_started, current Planner
   * consent/claim and original deadline before effects, keeping all existing
   * before/after/release fences. No issue, renew, retry, new run or new tx in tx. */
  prepare(work: CanonicalProducerWork, original: CanonicalPlannerOriginalOperation): Promise<CanonicalApplicationObservation>;
}
export type CanonicalPlannerContinuationOutcome =
  { outcome: 'applied'; recovered: boolean; observation: CanonicalApplicationObservation } |
  { outcome: 'failed' | 'cancelled'; terminalReceiptId: string };

function originalOperation(value: CanonicalPlannerOriginalOperation, work: CanonicalProducerWork) {
  closed(value, ['operationId', 'attemptId', 'runId', 'requestFingerprint', 'originalDeadlineAt', 'workSha256']);
  for (const key of ['operationId', 'attemptId', 'runId'] as const) applicationUuid(value[key]);
  if (typeof value.requestFingerprint !== 'string' || /^[0-9a-f]{64}$/.exec(value.requestFingerprint)?.[0] !== value.requestFingerprint ||
      value.workSha256 !== applicationHash(work) ||
      typeof value.originalDeadlineAt !== 'string' || !Number.isFinite(Date.parse(value.originalDeadlineAt)) ||
      new Date(value.originalDeadlineAt).toISOString() !== value.originalDeadlineAt) return fail();
  return JSON.parse(JSON.stringify(value)) as CanonicalPlannerOriginalOperation;
}
function reconciliation(value: CanonicalPlannerContinuationReconciliation,
  original: CanonicalPlannerOriginalOperation) {
  closed(value, ['state', 'original', 'terminalReceiptId', 'outcome']);
  if (applicationHash(value.original) !== applicationHash(original)) return fail();
  if (value.state === 'unavailable') return fail('AUTHORITY_UNAVAILABLE');
  if (value.state === 'outcome_unconfirmed') return fail();
  if (value.state === 'not_started' && value.terminalReceiptId === null && value.outcome === null) return structuredClone(value);
  if (value.state === 'accounted' && ['applied', 'failed', 'cancelled'].includes(value.outcome ?? '')) {
    applicationUuid(value.terminalReceiptId); return structuredClone(value);
  }
  return fail();
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function strings(value: unknown, uuids = false): asserts value is string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) return fail();
  if (uuids) value.forEach(applicationUuid);
  if (new Set(value).size !== value.length) return fail();
}
/** Full structural check of the existing owner observation, not a substitute
 * for its receipt reconstruction/current-read authority. Truncated/redacted
 * envelopes must never become a successful continuation acknowledgment. */
function checkedObservation(value: CanonicalApplicationObservation, work: CanonicalProducerWork) {
  closed(value, ['schemaVersion', 'applicationRequestId', 'creation', 'current']);
  const current = value.current;
  closed(current, ['requestId', 'status', 'replayed', 'recordedAt', 'observedAt', 'source', 'projects',
    'tasks', 'context', 'edges', 'exclusions', 'issues', 'counts']);
  if (!['prepared', 'prepared_with_issues', 'partial'].includes(current.status) || typeof current.replayed !== 'boolean' ||
      !timestamp(current.recordedAt) || !timestamp(current.observedAt) || current.observedAt < current.recordedAt) return fail();
  closed(current.source, ['generationJobId', 'generationRequestId', 'clientId', 'objectiveId', 'objectiveVersion',
    'objectiveRevisionId', 'strategyId', 'strategyVersionId', 'snapshotDigest']);
  for (const array of [current.projects, current.tasks, current.context, current.edges, current.exclusions, current.issues])
    if (!Array.isArray(array)) return fail();
  if (current.projects.length !== 1) return fail();
  const outputIds: string[] = [], taskNodes: string[] = [];
  for (const project of current.projects) {
    closed(project, ['groupKey', 'name', 'originalNodeIds', 'output']); strings(project.originalNodeIds, true);
    if (project.groupKey !== 'default' || typeof project.name !== 'string') return fail();
  }
  for (const task of current.tasks) {
    closed(task, ['sourceNodeId', 'originalGroupKeys', 'currentGroupKeys', 'output']);
    applicationUuid(task.sourceNodeId); taskNodes.push(task.sourceNodeId);
    strings(task.originalGroupKeys); strings(task.currentGroupKeys);
  }
  if (new Set(taskNodes).size !== taskNodes.length) return fail();
  for (const row of [...current.projects, ...current.tasks]) {
    const output = row.output;
    closed(output, ['availability', 'id', 'createdVersion', 'currentVersion']);
    if (!positive(output.createdVersion)) return fail();
    if (output.availability === 'unavailable') {
      if (output.id !== null || output.currentVersion !== null) return fail();
    } else {
      if (!['available', 'archived'].includes(output.availability) || !positive(output.currentVersion) ||
          output.currentVersion < output.createdVersion) return fail();
      applicationUuid(output.id); outputIds.push(output.id!);
    }
  }
  if (new Set(outputIds).size !== outputIds.length || current.projects[0]!.output.id !== null &&
      current.projects[0]!.output.id !== work.canonical.canonicalProjectId) return fail();
  for (const item of current.context) {
    closed(item, ['sourceNodeId', 'kind', 'title', 'note', 'dependsOnSourceNodeIds']); applicationUuid(item.sourceNodeId);
    strings(item.dependsOnSourceNodeIds, true);
    if (typeof item.kind !== 'string' || typeof item.title !== 'string' || item.note !== null && typeof item.note !== 'string') return fail();
  }
  for (const item of current.edges) {
    closed(item, ['sourceNodeId', 'dependsOnSourceNodeId', 'disposition']);
    applicationUuid(item.sourceNodeId); applicationUuid(item.dependsOnSourceNodeId);
    if (!['task_dependency', 'context_only', 'archived_source'].includes(item.disposition)) return fail();
  }
  for (const item of current.exclusions) {
    closed(item, ['sourceNodeId', 'reason']); applicationUuid(item.sourceNodeId);
    if (item.reason !== 'ARCHIVED_SOURCE_NODE') return fail();
  }
  for (const item of current.issues) {
    closed(item, ['code', 'sourceNodeIds', 'message']); strings(item.sourceNodeIds, true);
    if (typeof item.code !== 'string' || !item.code || typeof item.message !== 'string') return fail();
  }
  closed(current.counts, ['savedNodes', 'actionableNodes', 'contextNodes', 'archivedNodes', 'createdProjects', 'createdTasks']);
  if (Object.values(current.counts).some(n => !Number.isInteger(n) || n < 0 || n > 2147483647)) return fail();
  const request = producerApplication(work), c = request.canonical, s = value.current?.source;
  if (value.schemaVersion !== 1 || value.applicationRequestId !== request.applicationRequestId ||
      value.current?.requestId !== request.applicationRequestId || !s ||
      s.generationJobId !== request.generationJobId || s.generationRequestId !== request.generationRequestId ||
      s.strategyId !== request.strategyId || s.strategyVersionId !== request.strategyVersionId ||
      s.snapshotDigest !== request.snapshotDigest || s.clientId !== c.clientId || s.objectiveId !== c.objectiveId ||
      s.objectiveVersion !== c.requestedObjectiveVersion || s.objectiveRevisionId !== c.requestedObjectiveRevisionId) return fail();
  const creation = value.creation;
  closed(creation, ['availability', 'ack', 'sha256']);
  if (creation?.availability === 'available') {
    if ([...current.projects, ...current.tasks].some(row => row.output.id === null)) return fail();
    const ack = creation.ack;
    closed(ack, ['schemaVersion', 'operation', 'applicationRequestId', 'requestSha256', 'canonical', 'actorUserId',
      'consentId', 'controlVersion', 'source', 'objectiveReceiptSha256', 'ownerReceiptId', 'ownerReceiptSha256',
      'recordedAt', 'outcome', 'projects', 'tasks']);
    applicationUuid(ack.ownerReceiptId);
    if (!ack || creation.sha256 !== applicationHash(ack) || ack.requestSha256 !== applicationHash(request) ||
        ack.applicationRequestId !== request.applicationRequestId || ack.operation !== 'objective.plan.prepare' ||
        ack.schemaVersion !== 1 || !timestamp(ack.recordedAt) || !['applied', 'applied_with_issues'].includes(ack.outcome) ||
        typeof ack.ownerReceiptSha256 !== 'string' || /^[0-9a-f]{64}$/.exec(ack.ownerReceiptSha256)?.[0] !== ack.ownerReceiptSha256 ||
        applicationHash(ack.canonical) !== applicationHash(c) || applicationHash(ack.source) !== applicationHash(s) ||
        ack.actorUserId !== work.actorUserId || ack.consentId !== work.consentId || ack.controlVersion !== work.controlVersion ||
        ack.objectiveReceiptSha256 !== work.objectiveReceiptSha256) return fail();
    if (!Array.isArray(ack.projects) || !Array.isArray(ack.tasks)) return fail();
    for (const item of ack.projects) {
      closed(item, ['groupKey', 'projectId', 'createdVersion', 'originalNodeIds']); applicationUuid(item.projectId);
      strings(item.originalNodeIds, true); if (item.groupKey !== 'default' || !positive(item.createdVersion)) return fail();
    }
    for (const item of ack.tasks) {
      closed(item, ['sourceNodeId', 'taskId', 'createdVersion', 'originalGroupKeys']);
      applicationUuid(item.sourceNodeId); applicationUuid(item.taskId); strings(item.originalGroupKeys);
      if (!positive(item.createdVersion)) return fail();
    }
    return applicationObservation({ receiptVersion: 1, request, ack, ackSha256: creation.sha256 }, current);
  } else if (creation?.availability !== 'unavailable' || creation.ack !== null || creation.sha256 !== null) return fail();
  if ([...current.projects, ...current.tasks].every(row => row.output.id !== null)) return fail();
  return value;
}
function observation(value: CanonicalApplicationObservation, work: CanonicalProducerWork) {
  try { return structuredClone(checkedObservation(value, work)); } catch { return fail(); }
}

/** Bounded, unmounted source orchestration. A server owner may invoke it after
 * browser closure; it does not schedule/claim work or implement authority.
 * Every invocation reconciles the exact original operation before one prepare.
 * A lost/malformed reply gets one read reconciliation and at most one lookup;
 * uncertainty never produces a second prepare or a replacement operation. */
export async function continueCanonicalPlanner(rawWork: CanonicalProducerWork,
  rawOriginal: CanonicalPlannerOriginalOperation, owner: CanonicalPlannerContinuationOwner): Promise<CanonicalPlannerContinuationOutcome> {
  const work = parseCanonicalProducerRequest({ schemaVersion: 1, phase: 'prepare', work: rawWork }).work;
  const original = originalOperation(rawOriginal, work);
  const reconcile = async () => reconciliation(await owner.reconcile(structuredClone(work), structuredClone(original)), original);
  const recover = async (known: CanonicalPlannerContinuationReconciliation): Promise<CanonicalPlannerContinuationOutcome> => {
    if (known.state !== 'accounted') return fail();
    if (known.outcome === 'failed' || known.outcome === 'cancelled')
      return { outcome: known.outcome, terminalReceiptId: known.terminalReceiptId! };
    return { outcome: 'applied', recovered: true,
      observation: observation(await owner.lookup(producerApplication(work), structuredClone(original)), work) };
  };
  const known = await reconcile();
  if (known.state === 'accounted') return recover(known);
  try {
    return { outcome: 'applied', recovered: false,
      observation: observation(await owner.prepare(structuredClone(work), structuredClone(original)), work) };
  } catch {
    // Never resubmit after an ambiguous prepare, even if a subsequent owner
    // read says not_started. A later owner decision must account for that call.
    return recover(await reconcile());
  }
}
