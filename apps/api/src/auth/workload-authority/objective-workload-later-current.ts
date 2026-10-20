import { types as nodeTypes } from 'node:util';
import { objectiveRevisionSnapshotHash as hash } from '../../clients/objectives/objective-work-intent.js';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';

/** Source-only decision kernel for phases after the first admission. None of
 * these ports is mounted. In particular, a Strategy acceptance resource or a
 * matching SHA is not an authenticated observation of the original Meri run.
 * The owner readback must be obtained outside this database transaction from
 * Meri's pinned, original accepted-run reader; no network I/O belongs here. */
export type ObjectiveLaterPhase = 'admission-read' | 'publish' | 'request-read' | 'accept' |
  'complete' | 'completion-read' | 'terminal-account' | 'terminal-read' | 'retained-result-read';
export interface ObjectiveLaterSelector {
  tenantId: string;
  delegationRef: string;
  consentId: string;
  generationJobId: string;
  phase: ObjectiveLaterPhase;
}
export interface ObjectiveLaterJob {
  id: string; tenantId: string; clientId: string; clerkUserId: string;
  status: string; attempt: number; claimedBy: string | null; claimedAt: unknown;
  strategyId: string | null; requestKey: string; deadlineAtMs: number; input: any;
}
export interface ObjectiveLaterAdmission {
  schemaVersion: 1; namespace: 'capiro.objective-strategy.admission:v1';
  canonical: { canonicalPlanId: string; tenantId: string; clientId: string; objectiveId: string;
    canonicalStrategyId: string; canonicalProjectId: string; bindingVersion: number; epoch: 1;
    requestedIntentId: string; requestedObjectiveRevisionId: string;
    requestedObjectiveVersion: number; snapshotHash: string };
  actorUserId: string; clerkUserId: string; consentId: string; controlVersion: number;
  generationJobId: string; generationRequestId: string; admittedAtMs: number;
  effectExpiresAtMs: number; expectedStrategyVersionId: string | null;
}
export interface ObjectiveLaterNative {
  tenantId: string; clientId: string; objectiveId: string; actorUserId: string;
  membershipId: string; clerkUserId: string; tenantActive: boolean;
  membershipActive: boolean; roleAllowed: boolean; featureEnabled: boolean;
  clientActive: boolean; wallAllowed: boolean; objectiveExists: boolean;
}
export interface ObjectiveLaterCurrentEffect {
  actorUserId: string; membershipId: string; controlId: string; consentId: string;
  controlVersion: number; canonicalPlanId: string; canonicalStrategyId: string;
  canonicalProjectId: string; bindingVersion: number; intentId: string;
  objectiveRevisionId: string; objectiveVersion: number; snapshotHash: string;
  objectiveReady: boolean; controlActive: boolean; consentCurrent: boolean;
  confirmedAtMs: number; consentExpiresAtMs: number;
}
export interface ObjectiveLaterDelegation {
  ref: string; tenantId: string; clientId: string; objectiveId: string;
  action: string; controlId: string; consentId: string; controlVersion: number;
  generationJobId: string; generationRequestId: string; generationRequestFingerprint: string;
  jobRequestKey: string; clerkUserId: string; serviceSubject: string; audience: string;
  policyRevision: string; issuedAtMs: number; absoluteExpiresAtMs: number;
  authorityVersion: number; enabled: boolean; cancelledAt: unknown;
}
export interface ObjectiveLaterPublication {
  sourceAdmissionSha256: string; publicationSha256: string;
  generationRequestId: string; typedRequestSha256: string;
  executionContextSha256: string; promptSha256: string;
  originalExpiresAtMs: number;
}
export interface ObjectiveLaterBinding {
  tenantId: string; actorId: string; conversationId: string; runId: string;
  attemptId: string; workerId: string; writerFence: number;
}
export interface ObjectiveLaterAcceptance {
  sourceAdmissionSha256: string; sourceBinding: ObjectiveLaterBinding;
  sourceRequestSha256: string; acceptedAtMs: number;
  issuance: { issuanceKey: string; binding: ObjectiveLaterBinding;
    requestSha256: string; expiresAtMs: number; grantId: string;
    capabilitySha256: string; factsSha256: string };
}
/** This is an authenticated owner observation, never caller JSON or the
 * Strategy acceptance ledger echoed back. The future adapter must verify
 * genuine Meri ISSUED metadata, protected full facts and the original run. */
export interface ObjectiveOriginalMeriAcceptedReadback {
  sourceAdmissionSha256: string; sourceBinding: ObjectiveLaterBinding;
  sourceRequestSha256: string; issuanceKey: string; expiresAtMs: number;
  grantId: string; capabilitySha256: string; factsSha256: string;
  typedRequestSha256: string; executionContextSha256: string;
  acceptedRequestId: string; acceptedPromptSha256: string;
}
/** Separate current bookkeeping permission. Its owner adapter is absent;
 * original consent, claim and Meri issuance deadlines cannot be renewed. */
export interface ObjectiveTerminalAccountingObservation {
  phase: 'terminal-account' | 'terminal-read'; tenantId: string;
  delegationRef: string; generationJobId: string; actorUserId: string;
  membershipId: string; sourceAdmissionSha256: string; bindingSha256: string;
  checkedAtMs: number; expiresAtMs: number; absoluteExpiresAtMs: number;
}
export interface ObjectiveLaterRetainedOutcome {
  kind: 'completed' | 'terminal'; sourceAdmissionSha256: string;
  sourceBindingSha256: string; generationJobId: string;
  /** Only the typed, genuine non-success outcomes are terminal-readable. */
  outcome?: 'needs-information' | 'refused';
}
/** Every read is from one already-open tenant transaction. Implementations
 * must use exact tenant predicates and preserve job -> native -> canonical/
 * control -> delegation lock order. Resource readers validate private kind,
 * deterministic ID, owner, version, archive and original owner custody. */
export interface ObjectiveLaterCurrentTx {
  lockJob(selector: ObjectiveLaterSelector): Promise<ObjectiveLaterJob | null>;
  readAdmission(selector: ObjectiveLaterSelector, job: ObjectiveLaterJob): Promise<ObjectiveLaterAdmission | null>;
  readCurrentNative(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<ObjectiveLaterNative | null>;
  readCurrentEffect(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<ObjectiveLaterCurrentEffect | null>;
  lockDelegation(selector: ObjectiveLaterSelector): Promise<ObjectiveLaterDelegation | null>;
  readPublication(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<ObjectiveLaterPublication | null>;
  readAcceptance(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<ObjectiveLaterAcceptance | null>;
  /** Must establish absence under the held job lock; never infer it from a missing HTTP reply. */
  readTerminalNoWrites(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<boolean>;
  readRetainedOutcome(selector: ObjectiveLaterSelector, admission: ObjectiveLaterAdmission): Promise<ObjectiveLaterRetainedOutcome | null>;
  databaseNowMs(): Promise<number>;
}
export interface ObjectiveLaterOptions {
  enabled: boolean;
  policyRevision: string;
  originalMeri?: ObjectiveOriginalMeriAcceptedReadback;
  terminalAccounting?: ObjectiveTerminalAccountingObservation;
}
export interface ObjectiveLaterDecision {
  readonly phase: ObjectiveLaterPhase; readonly tenantId: string;
  readonly delegationRef: string; readonly generationJobId: string;
  readonly consentId: string; readonly controlId: string;
  readonly actorUserId: string; readonly membershipId: string;
  readonly sourceAdmissionSha256: string;
  readonly acceptedBindingSha256: string | null;
  readonly checkedAtMs: number; readonly validUntilMs: number;
  readonly purpose: 'effect' | 'read' | 'terminal-accounting';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const PHASES: readonly ObjectiveLaterPhase[] = ['admission-read','publish','request-read','accept','complete',
  'completion-read','terminal-account','terminal-read','retained-result-read'];
const ACCEPTED: readonly ObjectiveLaterPhase[] = ['accept','complete','completion-read','terminal-account',
  'terminal-read','retained-result-read'];
const EFFECT: readonly ObjectiveLaterPhase[] = ['publish','accept','complete'];
const CLOCK_MAX = 8_640_000_000_000_000;
const DAY = 86_400_000;
const unavailable = (): never => { throw new ObjectiveCurrentSourceUnavailable(); };
const uuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
const sha = (s: unknown): s is string => typeof s === 'string' && SHA.test(s);
const time = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= CLOCK_MAX;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2147483647;
function exactSelector(raw: ObjectiveLaterSelector): ObjectiveLaterSelector {
  const keys = ['tenantId','delegationRef','consentId','generationJobId','phase'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== keys.length) return unavailable();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return unavailable();
    copy[key] = d.value;
  }
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key)) ||
      ![copy.tenantId,copy.delegationRef,copy.consentId,copy.generationJobId].every(uuid) ||
      !PHASES.includes(copy.phase as ObjectiveLaterPhase)) return unavailable();
  return copy as unknown as ObjectiveLaterSelector;
}
const same = (a: unknown, b: unknown) => hash(a as any) === hash(b as any);
/** A preliminary policy decision, not an issuer or HTTP verifier. There is
 * no production `enabled=true` caller while the delegation migration has its
 * CHECK(enabled=false), and no Meri/accounting owner adapters are mounted. */
export async function decideObjectiveLaterCurrentWithinTx(
  tx: ObjectiveLaterCurrentTx, rawSelector: ObjectiveLaterSelector,
  options?: ObjectiveLaterOptions,
): Promise<Readonly<ObjectiveLaterDecision>> {
  if (options?.enabled !== true || !sha(options.policyRevision)) return unavailable();
  const s = exactSelector(rawSelector);
  {
    const job = await tx.lockJob(s);
    const request = job?.input?.objectiveGeneration?.request;
    if (!job || job.id !== s.generationJobId || job.tenantId !== s.tenantId || !uuid(job.clientId) ||
        typeof job.clerkUserId !== 'string' || job.clerkUserId.length < 1 || job.clerkUserId.length > 128 ||
        !request || !uuid(request.requestId) || request.clientId !== job.clientId ||
        !uuid(request.objective?.objectiveId) || !positive(request.objective?.objectiveVersion) ||
        !sha(job.input.objectiveGeneration.fingerprint) ||
        job.input.objectiveGeneration.fingerprint !== hash(request as any) ||
        job.requestKey !== `objective-v1:${hash([s.tenantId,job.clerkUserId,request.requestId])}` ||
        !time(job.deadlineAtMs)) return unavailable();
    const admission = await tx.readAdmission(s, job);
    const c = admission?.canonical;
    if (!admission || admission.schemaVersion !== 1 || admission.namespace !== 'capiro.objective-strategy.admission:v1' ||
        !c || c.tenantId !== s.tenantId || c.clientId !== job.clientId || c.objectiveId !== request.objective.objectiveId ||
        !uuid(c.canonicalPlanId) || !uuid(c.canonicalStrategyId) || !uuid(c.canonicalProjectId) ||
        !uuid(c.requestedIntentId) || !uuid(c.requestedObjectiveRevisionId) || !sha(c.snapshotHash) ||
        c.epoch !== 1 || !positive(c.bindingVersion) || c.requestedObjectiveVersion !== request.objective.objectiveVersion ||
        !uuid(admission.actorUserId) || admission.clerkUserId !== job.clerkUserId ||
        admission.consentId !== s.consentId || !positive(admission.controlVersion) ||
        admission.generationJobId !== job.id || admission.generationRequestId !== request.requestId ||
        !time(admission.admittedAtMs) || !time(admission.effectExpiresAtMs) ||
        admission.effectExpiresAtMs <= admission.admittedAtMs ||
        (admission.expectedStrategyVersionId !== null && !uuid(admission.expectedStrategyVersionId))) return unavailable();
    const admissionSha = hash(admission as any);
    const native = await tx.readCurrentNative(s, admission);
    if (!native || native.tenantId !== s.tenantId || native.clientId !== job.clientId ||
        native.objectiveId !== c.objectiveId || native.actorUserId !== admission.actorUserId ||
        !uuid(native.membershipId) || native.clerkUserId !== job.clerkUserId ||
        [native.tenantActive,native.membershipActive,native.roleAllowed,native.featureEnabled,
          native.clientActive,native.wallAllowed,native.objectiveExists].some(value => value !== true)) return unavailable();
    const effect = EFFECT.includes(s.phase);
    const current = effect ? await tx.readCurrentEffect(s, admission) : null;
    if (effect && (!current || current.actorUserId !== native.actorUserId ||
        current.membershipId !== native.membershipId || current.consentId !== s.consentId ||
        !uuid(current.controlId) || current.controlVersion !== admission.controlVersion ||
        current.canonicalPlanId !== c.canonicalPlanId || current.canonicalStrategyId !== c.canonicalStrategyId ||
        current.canonicalProjectId !== c.canonicalProjectId || current.bindingVersion !== c.bindingVersion ||
        current.intentId !== c.requestedIntentId || current.objectiveRevisionId !== c.requestedObjectiveRevisionId ||
        current.objectiveVersion !== c.requestedObjectiveVersion || current.snapshotHash !== c.snapshotHash ||
        current.objectiveReady !== true || current.controlActive !== true || current.consentCurrent !== true ||
        !time(current.confirmedAtMs) || !time(current.consentExpiresAtMs))) return unavailable();
    const delegation = await tx.lockDelegation(s);
    if (!delegation || delegation.ref !== s.delegationRef || delegation.tenantId !== s.tenantId ||
        delegation.clientId !== job.clientId || delegation.objectiveId !== c.objectiveId ||
        delegation.action !== 'objective.strategy.draft' || delegation.consentId !== s.consentId ||
        !uuid(delegation.controlId) || delegation.controlVersion !== admission.controlVersion ||
        delegation.generationJobId !== job.id || delegation.generationRequestId !== request.requestId ||
        delegation.generationRequestFingerprint !== job.input.objectiveGeneration.fingerprint ||
        delegation.jobRequestKey !== job.requestKey || delegation.clerkUserId !== job.clerkUserId ||
        delegation.serviceSubject !== 'capiro-objective-generation-worker:v1' ||
        delegation.audience !== 'capiro:objective-strategy-api:v1' ||
        delegation.policyRevision !== options.policyRevision || !positive(delegation.authorityVersion) ||
        delegation.enabled !== true || delegation.cancelledAt !== null ||
        !time(delegation.issuedAtMs) || !time(delegation.absoluteExpiresAtMs) ||
        delegation.absoluteExpiresAtMs <= delegation.issuedAtMs ||
        delegation.absoluteExpiresAtMs > delegation.issuedAtMs + DAY ||
        (current && delegation.controlId !== current.controlId)) return unavailable();
    const now = await tx.databaseNowMs();
    if (!time(now) || admission.admittedAtMs > now || delegation.issuedAtMs > now ||
        delegation.absoluteExpiresAtMs <= now) return unavailable();
    const marker = job.input.canonicalGeneration;
    // Actual Strategy marker is a deterministic admission-resource ID. The
    // resource reader must validate its private row and exact admission data.
    const h = hash(['objective_canonical_generation_admission',s.tenantId,job.clerkUserId,job.id]);
    const markerId = `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
    if (!marker || Object.keys(marker).length !== 1 || marker.admissionId !== markerId) return unavailable();
    const published = s.phase === 'admission-read' || s.phase === 'publish' ? null :
      await tx.readPublication(s, admission);
    if (s.phase !== 'admission-read' && s.phase !== 'publish' &&
        (!published || published.sourceAdmissionSha256 !== admissionSha ||
          !sha(published.publicationSha256) || published.generationRequestId !== request.requestId ||
          !sha(published.typedRequestSha256) || !sha(published.executionContextSha256) ||
          !sha(published.promptSha256) || !time(published.originalExpiresAtMs))) return unavailable();
    let acceptedBindingSha: string | null = null;
    let accepted: ObjectiveLaterAcceptance | null = null;
    const owner = ACCEPTED.includes(s.phase) ? options.originalMeri : undefined;
    if (ACCEPTED.includes(s.phase)) {
      if (!owner || !published || owner.sourceAdmissionSha256 !== admissionSha ||
          owner.sourceBinding.tenantId !== s.tenantId || owner.sourceBinding.actorId !== job.clerkUserId ||
          !uuid(owner.sourceBinding.conversationId) || !uuid(owner.sourceBinding.runId) ||
          !uuid(owner.sourceBinding.attemptId) || !uuid(owner.sourceBinding.workerId) ||
          !positive(owner.sourceBinding.writerFence) ||
          !sha(owner.sourceRequestSha256) || !sha(owner.capabilitySha256) || !sha(owner.factsSha256) ||
          !uuid(owner.grantId) || !time(owner.expiresAtMs) ||
          owner.issuanceKey !== hash(owner.sourceBinding as any) ||
          owner.acceptedRequestId !== request.requestId ||
          owner.typedRequestSha256 !== published?.typedRequestSha256 ||
          owner.executionContextSha256 !== published.executionContextSha256 ||
          owner.acceptedPromptSha256 !== published.promptSha256) return unavailable();
      acceptedBindingSha = hash(owner.sourceBinding as any);
      accepted = await tx.readAcceptance(s, admission);
      if (s.phase !== 'accept' && !accepted) return unavailable();
      if (accepted && (accepted.sourceAdmissionSha256 !== admissionSha ||
          !same(accepted.sourceBinding, owner.sourceBinding) ||
          !same(accepted.issuance.binding, owner.sourceBinding) ||
          accepted.sourceRequestSha256 !== owner.sourceRequestSha256 ||
          accepted.issuance.requestSha256 !== owner.sourceRequestSha256 ||
          accepted.issuance.issuanceKey !== owner.issuanceKey ||
          accepted.issuance.expiresAtMs !== owner.expiresAtMs ||
          accepted.issuance.grantId !== owner.grantId ||
          accepted.issuance.capabilitySha256 !== owner.capabilitySha256 ||
          accepted.issuance.factsSha256 !== owner.factsSha256 ||
          !time(accepted.acceptedAtMs) || accepted.acceptedAtMs < admission.admittedAtMs ||
          accepted.acceptedAtMs >= admission.effectExpiresAtMs ||
          accepted.issuance.expiresAtMs <= accepted.acceptedAtMs ||
          accepted.issuance.expiresAtMs > admission.effectExpiresAtMs)) return unavailable();
    }
    if (effect) {
      if (!current || current.confirmedAtMs > now || current.consentExpiresAtMs <= now ||
          admission.effectExpiresAtMs <= now || job.deadlineAtMs <= now ||
          (published && published.originalExpiresAtMs <= now) ||
          (owner && owner.expiresAtMs <= now)) return unavailable();
      if (s.phase === 'complete') {
        if (!accepted || job.status !== 'running' || job.attempt !== 2 || job.claimedAt == null ||
            job.claimedBy !== `canonical:${accepted.issuance.issuanceKey}` ||
            job.strategyId !== null || job.input.canonicalCompletion !== undefined ||
            job.input.canonicalTerminal !== undefined) return unavailable();
      } else if (job.status !== 'queued' || job.attempt !== 1 || job.claimedBy !== null ||
          job.claimedAt !== null || job.strategyId !== null) return unavailable();
    }
    if (s.phase === 'terminal-account' || s.phase === 'terminal-read') {
      const accounting = options.terminalAccounting;
      if (!acceptedBindingSha || !accounting || accounting.phase !== s.phase ||
          accounting.tenantId !== s.tenantId || accounting.delegationRef !== s.delegationRef ||
          accounting.generationJobId !== job.id || accounting.actorUserId !== native.actorUserId ||
          accounting.membershipId !== native.membershipId ||
          accounting.sourceAdmissionSha256 !== admissionSha ||
          accounting.bindingSha256 !== acceptedBindingSha ||
          !time(accounting.checkedAtMs) || accounting.checkedAtMs > now ||
          !time(accounting.expiresAtMs) || accounting.expiresAtMs <= now ||
          accounting.expiresAtMs > accounting.checkedAtMs + 60_000 ||
          accounting.absoluteExpiresAtMs !== delegation.absoluteExpiresAtMs) return unavailable();
      if (s.phase === 'terminal-account' &&
          (job.status !== 'running' || job.attempt !== 2 || job.claimedAt == null ||
            job.claimedBy !== `canonical:${owner!.issuanceKey}` || job.strategyId !== null ||
            job.input.canonicalCompletion !== undefined || job.input.canonicalTerminal !== undefined ||
            await tx.readTerminalNoWrites(s, admission) !== true)) return unavailable();
    }
    if (s.phase === 'completion-read' || s.phase === 'terminal-read') {
      const result = await tx.readRetainedOutcome(s, admission);
      if (!result || result.generationJobId !== job.id || result.sourceAdmissionSha256 !== admissionSha ||
          result.sourceBindingSha256 !== acceptedBindingSha ||
          (s.phase === 'completion-read' && (result.kind !== 'completed' || job.status !== 'completed')) ||
          (s.phase === 'terminal-read' && !(
            result.kind === 'completed' && job.status === 'completed' ||
            result.kind === 'terminal' && job.status === 'failed' &&
              (result.outcome === 'needs-information' || result.outcome === 'refused')))) return unavailable();
    }
    if (s.phase === 'retained-result-read' &&
        !['running','completed','failed'].includes(job.status)) return unavailable();
    const purpose = effect ? 'effect' : s.phase.startsWith('terminal-') ? 'terminal-accounting' : 'read';
    const validUntilMs = Math.min(now + 60_000, delegation.absoluteExpiresAtMs,
      ...(effect ? [current!.consentExpiresAtMs,admission.effectExpiresAtMs,job.deadlineAtMs,
        ...(published ? [published.originalExpiresAtMs] : []),...(owner ? [owner.expiresAtMs] : [])] : []),
      ...(purpose === 'terminal-accounting' ? [options.terminalAccounting!.expiresAtMs] : []));
    if (!time(validUntilMs) || validUntilMs <= now) return unavailable();
    return Object.freeze({ phase: s.phase, tenantId: s.tenantId, delegationRef: s.delegationRef,
      generationJobId: job.id, consentId: s.consentId, controlId: delegation.controlId,
      actorUserId: native.actorUserId, membershipId: native.membershipId,
      sourceAdmissionSha256: admissionSha, acceptedBindingSha256: acceptedBindingSha,
      checkedAtMs: now, validUntilMs, purpose });
  }
}
