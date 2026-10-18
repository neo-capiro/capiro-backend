import { applicationHash, applicationUuid, canonicalApplicationRequestId, CanonicalApplicationError,
  parseCanonicalApplication, type CanonicalApplicationRequest } from '../planner/objective-canonical-application.js';
import { parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission,
  type CanonicalGenerationAdmission, type CanonicalGenerationAcceptance } from './objective-canonical-generation.js';
import { validObjectiveOutcome, type ObjectiveReceipt } from './objective-generation.types.js';

/** The continuation consent belongs to plan.prepare. It is deliberately distinct
 * from the original strategy.draft consent retained in sourceAdmission. */
export interface CanonicalProducerWork extends Omit<CanonicalApplicationRequest, 'schemaVersion'> {
  actorUserId: string; consentId: string; controlVersion: number;
}
export type ProducerPhase = 'start' | 'prepare' | 'read' | 'stop';
export interface CanonicalProducerRequest { schemaVersion: 1; phase: ProducerPhase; work: CanonicalProducerWork }
export interface StoredCanonicalGenerationProducer {
  schemaVersion: 1;
  sourceAdmission: CanonicalGenerationAdmission;
  acceptance: CanonicalGenerationAcceptance;
  generation: { jobId: string; requestId: string; attempt: number; coreFingerprint: string };
  objectiveReceipt: ObjectiveReceipt;
  snapshotDigest: string;
}
export const producerApplication = (w: CanonicalProducerWork): CanonicalApplicationRequest => ({
  schemaVersion: 1, canonical: w.canonical, applicationRequestId: w.applicationRequestId,
  generationJobId: w.generationJobId, generationRequestId: w.generationRequestId,
  strategyId: w.strategyId, strategyVersionId: w.strategyVersionId,
  objectiveReceiptSha256: w.objectiveReceiptSha256, snapshotDigest: w.snapshotDigest,
});
export function parseCanonicalProducerRequest(raw: unknown): CanonicalProducerRequest {
  try {
    // applicationHash rejects accessors, proxies, sparse arrays and non-JSON
    // values BEFORE reading properties. Parsing is validation, never authority.
    applicationHash(raw);
    const r = raw as CanonicalProducerRequest;
    if (!r || Object.keys(r).sort().join(',') !== 'phase,schemaVersion,work' || r.schemaVersion !== 1 ||
        !['start','prepare','read','stop'].includes(r.phase) || !r.work ||
        Object.keys(r.work).sort().join(',') !== ['canonical','applicationRequestId','generationJobId',
          'generationRequestId','strategyId','strategyVersionId','objectiveReceiptSha256','snapshotDigest',
          'actorUserId','consentId','controlVersion'].sort().join(',')) throw new Error();
    const a = parseCanonicalApplication(producerApplication(r.work));
    applicationUuid(r.work.actorUserId); applicationUuid(r.work.consentId);
    if (!Number.isInteger(r.work.controlVersion) || r.work.controlVersion < 1 || r.work.controlVersion > 2147483647 ||
        canonicalApplicationRequestId(a.canonical, r.work.actorUserId) !== a.applicationRequestId) throw new Error();
    return JSON.parse(JSON.stringify(r)) as CanonicalProducerRequest;
  } catch { throw new CanonicalApplicationError('INPUT_INVALID'); }
}
/** Reconstruct only from owner-read admission, acceptance, actual completed job
 * and exact saved version. This function cannot attest Meri issuance/custody. */
export function canonicalGenerationProducer(source: {
  admission: unknown; acceptance: unknown; jobId: string; requestId: string;
  attempt: number; coreFingerprint: string; receipt: ObjectiveReceipt;
  strategyId: string; strategyVersionId: string; snapshotDigest: string;
}): StoredCanonicalGenerationProducer {
  const a = parseCanonicalGenerationAdmission(source.admission);
  const accepted = requireGenerationAcceptanceForAdmission(source.acceptance, a);
  const r = source.receipt;
  const hash = /^[0-9a-f]{64}$/;
  if (source.jobId !== a.generationJobId || source.requestId !== a.generationRequestId ||
      !Number.isSafeInteger(source.attempt) || source.attempt < 1 ||
      typeof source.coreFingerprint !== 'string' || hash.exec(source.coreFingerprint)?.[0] !== source.coreFingerprint ||
      typeof source.snapshotDigest !== 'string' || hash.exec(source.snapshotDigest)?.[0] !== source.snapshotDigest ||
      !validObjectiveOutcome(r, 'completed', source.strategyId, null) ||
      r.requestId !== a.generationRequestId || r.source.clientId !== a.canonical.clientId ||
      r.source.objectiveId !== a.canonical.objectiveId ||
      r.source.objectiveVersion !== a.canonical.requestedObjectiveVersion ||
      r.source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      r.result!.strategyId !== a.canonical.canonicalStrategyId || r.result!.strategyId !== source.strategyId ||
      r.result!.strategyVersionId !== source.strategyVersionId ||
      Date.parse(r.result!.savedAt) < accepted.acceptedAtMs ||
      Date.parse(r.result!.savedAt) >= Math.min(a.effectExpiresAtMs, accepted.issuance.expiresAtMs))
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  return { schemaVersion: 1, sourceAdmission: a, acceptance: accepted,
    generation: { jobId: source.jobId, requestId: source.requestId,
      attempt: source.attempt, coreFingerprint: source.coreFingerprint },
    objectiveReceipt: JSON.parse(JSON.stringify(r)) as ObjectiveReceipt, snapshotDigest: source.snapshotDigest };
}
export function requireCanonicalProducerWork(stored: StoredCanonicalGenerationProducer, work: CanonicalProducerWork) {
  const a = stored.sourceAdmission, r = stored.objectiveReceipt;
  if (applicationHash(a.canonical) !== applicationHash(work.canonical) || a.actorUserId !== work.actorUserId ||
      a.generationJobId !== work.generationJobId || a.generationRequestId !== work.generationRequestId ||
      r.result!.strategyId !== work.strategyId || r.result!.strategyVersionId !== work.strategyVersionId ||
      applicationHash(r) !== work.objectiveReceiptSha256 || stored.snapshotDigest !== work.snapshotDigest)
    throw new CanonicalApplicationError('REQUEST_CONFLICT');
  // DO NOT compare a.consentId/controlVersion with work.consentId/controlVersion:
  // they are different action grants. The receiver checks the Planner grant.
}
