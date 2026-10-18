import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_PRODUCER, GENERATION_NORMALIZATION, generationLedgerId,
  canonicalGenerationAdmissionSha256, generationUuid, generationSha256,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission,
  type CanonicalGenerationAdmission, type CanonicalGenerationAcceptance, type GenerationLedgerKind } from './objective-canonical-generation.js';
import { canonicalGenerationProducer, type StoredCanonicalGenerationProducer } from './objective-canonical-producer.js';
import type { DraftJobInput } from './draft-job.types.js';
import type { NormalizedCanonicalDraft, CanonicalDraftNormalizationWitness } from './objective-canonical-draft.js';
import type { StrategySnapshot } from '../strategy/versioning.js';

type Tx = Prisma.TransactionClient;
type Kind = GenerationLedgerKind;
export const generationMarker = (a: CanonicalGenerationAdmission) => ({
  admissionId: generationLedgerId(GENERATION_ADMISSION, a.canonical.tenantId, a.clerkUserId, a.generationJobId),
});
export async function readGenerationLedger(tx: Tx, kind: Kind, tenant: string, clerk: string, job: string) {
  const id = generationLedgerId(kind, tenant, clerk, job);
  const row = await tx.spPlannerResource.findFirst({ where: { tenantId: tenant, id } });
  if (!row) return null;
  if (row.kind !== kind || row.ownerId !== clerk || row.archived || row.projectId !== null || row.version !== 1 || row.shareTokenHash !== null)
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  return row.data as unknown;
}
/** INSERT-only owner behavior, not a claim of DB-enforced append-only storage.
 * Generic Planner resource reads/writes must deny these private kinds. */
export async function insertGenerationLedger(tx: Tx, kind: Kind, tenant: string, clerk: string, job: string, data: unknown) {
  const old = await readGenerationLedger(tx, kind, tenant, clerk, job);
  if (old) {
    if (applicationHash(old) !== applicationHash(data)) throw new CanonicalApplicationError('REQUEST_CONFLICT');
    return;
  }
  await tx.spPlannerResource.create({ data: { id: generationLedgerId(kind, tenant, clerk, job), tenantId: tenant,
    ownerId: clerk, kind, projectId: null, version: 1, archived: false, shareTokenHash: null,
    name: 'Objective canonical generation evidence', data: data as Prisma.InputJsonValue } });
}
export async function generationAssociation(tx: Tx, tenant: string, clerk: string, job: string) {
  const raw = await readGenerationLedger(tx, GENERATION_ADMISSION, tenant, clerk, job);
  if (!raw) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const admission = parseCanonicalGenerationAdmission(raw);
  if (admission.canonical.tenantId !== tenant || admission.clerkUserId !== clerk || admission.generationJobId !== job)
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const acceptedRaw = await readGenerationLedger(tx, GENERATION_ACCEPTANCE, tenant, clerk, job);
  if (!acceptedRaw) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const acceptance = requireGenerationAcceptanceForAdmission(acceptedRaw, admission);
  return { admission, acceptance };
}
export interface StoredCanonicalNormalization {
  schemaVersion: 1; generationJobId: string; generationRequestId: string;
  sourceAdmissionId: string; sourceAdmissionSha256: string;
  sourceAcceptanceId: string; sourceAcceptanceSha256: string;
  strategyId: string; strategyVersionId: string; snapshotDigest: string;
  normalizationWitness: CanonicalDraftNormalizationWitness;
  nodes: Array<{ sourceNodeKey: string; nodeId: string }>;
}
/** Internal writer evidence only. A witness/hash is not model result custody,
 * current authority or permission to regenerate. The existing beforeWrite gate
 * holds the real job claim. Call after cutVersion, before afterWrite, in that
 * SAME initial Strategy transaction; failure must escape and roll it all back. */
export async function recordCanonicalNormalization(tx: Tx, tenant: string, clerk: string, jobId: string,
  saved: { strategyId: string; strategyVersionId: string }, normalized: NormalizedCanonicalDraft): Promise<StoredCanonicalNormalization> {
  const { admission: a, acceptance } = await generationAssociation(tx, tenant, clerk, jobId);
  const job = await tx.spDraftJob.findFirst({ where: { id: jobId, tenantId: tenant } });
  const input = job?.input as unknown as DraftJobInput | undefined, envelope = input?.objectiveGeneration;
  const unavailable = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
  if (!job || job.ownerUserId !== clerk || job.clientId !== a.canonical.clientId || job.status !== 'running' ||
      job.claimedBy !== `canonical:${acceptance.issuance.issuanceKey}` || job.attempt !== 2 || job.strategyId !== null ||
      !envelope || envelope.request.requestId !== a.generationRequestId || envelope.receipt.result !== null ||
      envelope.request.clientId !== a.canonical.clientId || envelope.request.objective.objectiveId !== a.canonical.objectiveId ||
      envelope.request.objective.objectiveVersion !== a.canonical.requestedObjectiveVersion ||
      envelope.receipt.source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      envelope.receipt.failure !== null || applicationHash(envelope.request) !== envelope.fingerprint ||
      applicationHash(input?.canonicalGeneration) !== applicationHash(generationMarker(a)) ||
      a.expectedStrategyVersionId !== null || saved.strategyId !== a.canonical.canonicalStrategyId) return unavailable();
  generationUuid(saved.strategyId); generationUuid(saved.strategyVersionId);
  // Reject non-JSON/accessor/proxy input before reading any witness properties.
  applicationHash(normalized);
  const w = normalized.normalizationWitness, keys = normalized.sourceKeys, ids = normalized.nodeIds;
  if (!w || w.schemaVersion !== 1 || w.namespace !== 'capiro.objective-strategy.normalization:v1' ||
      w.identityBasis !== 'initial-reservation' || w.expectedStrategyVersionId !== null || w.strategyType !== input?.dto.type ||
      w.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      w.normalizedResponseSha256 !== applicationHash(normalized.response) ||
      w.nodeIdsSha256 !== applicationHash(ids) || w.sourceKeysSha256 !== applicationHash(keys) ||
      !Array.isArray(keys) || !Array.isArray(ids) || ids.length === 0 || ids.length !== keys.length ||
      ids.length !== normalized.response.nodes.length || new Set(ids).size !== ids.length || new Set(keys).size !== keys.length ||
      keys.some(key => typeof key !== 'string' || /^[a-z][a-z0-9_-]{0,63}$/.exec(key)?.[0] !== key)) return unavailable();
  generationSha256(w.proposedPayloadSha256); ids.forEach(generationUuid);
  const version = await tx.spVersion.findFirst({ where: { id: saved.strategyVersionId, tenantId: tenant, strategyId: saved.strategyId } });
  const snapshot = version?.snapshot as unknown as StrategySnapshot | undefined;
  const actualNodes = await tx.spNode.findMany({ where: { tenantId: tenant, strategyId: saved.strategyId }, select: { id: true } });
  const expected = new Set(ids);
  if (!version || version.coalescible || version.authorKind !== 'meri' || version.authorUserId !== clerk ||
      snapshot?.meta.id !== saved.strategyId || snapshot.meta.clientId !== a.canonical.clientId ||
      snapshot.meta.createdByUserId !== clerk || snapshot.meta.type !== w.strategyType || snapshot.meta.meriSummary !== normalized.response.summary ||
      !Array.isArray(snapshot.nodes) || snapshot.nodes.length !== ids.length ||
      new Set(snapshot.nodes.map(n => n.id)).size !== ids.length || snapshot.nodes.some(n => !expected.has(n.id)) ||
      actualNodes.length !== ids.length || actualNodes.some(n => !expected.has(n.id))) return unavailable();
  const record: StoredCanonicalNormalization = { schemaVersion: 1, generationJobId: jobId, generationRequestId: a.generationRequestId,
    sourceAdmissionId: generationLedgerId(GENERATION_ADMISSION, tenant, clerk, jobId), sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a),
    sourceAcceptanceId: generationLedgerId(GENERATION_ACCEPTANCE, tenant, clerk, jobId), sourceAcceptanceSha256: applicationHash(acceptance),
    strategyId: saved.strategyId, strategyVersionId: saved.strategyVersionId, snapshotDigest: applicationHash(version.snapshot),
    normalizationWitness: JSON.parse(JSON.stringify(w)) as CanonicalDraftNormalizationWitness,
    nodes: keys.map((sourceNodeKey, i) => ({ sourceNodeKey, nodeId: ids[i]! })) };
  await insertGenerationLedger(tx, GENERATION_NORMALIZATION, tenant, clerk, jobId, record);
  return record;
}
/** Called after the existing Objective completion CAS, in the SAME writer tx.
 * Every identity comes from locked owner rows and the actual saved version. */
export async function recordCanonicalGenerationProducer(tx: Tx, tenant: string, clerk: string, jobId: string) {
  const { admission, acceptance } = await generationAssociation(tx, tenant, clerk, jobId);
  const job = await tx.spDraftJob.findFirst({ where: { id: jobId, tenantId: tenant } });
  const input = job?.input as unknown as DraftJobInput | undefined;
  const envelope = input?.objectiveGeneration;
  const result = envelope?.receipt.result;
  if (!job || job.ownerUserId !== clerk || job.status !== 'completed' || !envelope || !result ||
      applicationHash(envelope.request) !== envelope.fingerprint ||
      applicationHash(input?.canonicalGeneration) !== applicationHash(generationMarker(admission)))
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const version = await tx.spVersion.findFirst({ where: { id: result.strategyVersionId, tenantId: tenant,
    strategyId: result.strategyId } });
  const meta = (version?.snapshot as { meta?: { id?: string; clientId?: string } } | undefined)?.meta;
  if (!version || version.coalescible || version.authorKind !== 'meri' ||
      meta?.id !== result.strategyId || meta?.clientId !== admission.canonical.clientId)
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const producer = canonicalGenerationProducer({ admission, acceptance, jobId, requestId: envelope.request.requestId,
    attempt: job.attempt, coreFingerprint: envelope.fingerprint, receipt: envelope.receipt,
    strategyId: job.strategyId!, strategyVersionId: version.id, snapshotDigest: applicationHash(version.snapshot) });
  await insertGenerationLedger(tx, GENERATION_PRODUCER, tenant, clerk, jobId, producer);
  return producer;
}
/** Historical read re-derives the exact immutable evidence from the retained
 * actual job/version and original acceptance; it never follows a newer run. */
export async function readCanonicalGenerationProducer(tx: Tx, tenant: string, clerk: string, jobId: string):
  Promise<StoredCanonicalGenerationProducer> {
  const raw = await readGenerationLedger(tx, GENERATION_PRODUCER, tenant, clerk, jobId);
  if (!raw) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const { admission, acceptance } = await generationAssociation(tx, tenant, clerk, jobId);
  const job = await tx.spDraftJob.findFirst({ where: { id: jobId, tenantId: tenant } });
  const input = job?.input as unknown as DraftJobInput | undefined;
  const envelope = input?.objectiveGeneration, result = envelope?.receipt.result;
  if (!job || job.status !== 'completed' || job.ownerUserId !== clerk || !envelope || !result ||
      applicationHash(envelope.request) !== envelope.fingerprint ||
      applicationHash(input?.canonicalGeneration) !== applicationHash(generationMarker(admission)))
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const version = await tx.spVersion.findFirst({ where: { id: result.strategyVersionId, tenantId: tenant,
    strategyId: result.strategyId } });
  const meta = (version?.snapshot as { meta?: { id?: string; clientId?: string } } | undefined)?.meta;
  if (!version || version.coalescible || version.authorKind !== 'meri' ||
      meta?.id !== result.strategyId || meta?.clientId !== admission.canonical.clientId)
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const rebuilt = canonicalGenerationProducer({ admission, acceptance, jobId, requestId: envelope.request.requestId,
    attempt: job.attempt, coreFingerprint: envelope.fingerprint, receipt: envelope.receipt,
    strategyId: job.strategyId!, strategyVersionId: version.id, snapshotDigest: applicationHash(version.snapshot) });
  if (applicationHash(raw) !== applicationHash(rebuilt)) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  return rebuilt;
}
export type VerifiedGenerationAssociation = { admission: CanonicalGenerationAdmission; acceptance: CanonicalGenerationAcceptance };
