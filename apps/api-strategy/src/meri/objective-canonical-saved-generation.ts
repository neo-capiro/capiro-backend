import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, canonicalApplicationRequestId, CanonicalApplicationError,
  parseCanonicalApplication, type CanonicalApplicationRequest } from '../planner/objective-canonical-application.js';
import { checkCanonicalCompletionWitness } from './objective-canonical-completion-receipt.js';
import { checkCanonicalRegenerationCompletionWitness } from './objective-canonical-regeneration-completion-receipt.js';
import { canonicalGenerationAdmissionSha256, GENERATION_ADMISSION, GENERATION_ACCEPTANCE,
  GENERATION_NORMALIZATION, GENERATION_PRODUCER, generationLedgerId } from './objective-canonical-generation.js';
import { generationAssociation, readCanonicalGenerationProducer, readGenerationLedger } from './objective-canonical-producer-ledger.js';
import { readCanonicalRequestPublication } from './objective-canonical-request-ledger.js';
import { CORE_CANONICAL_REGENERATION_REQUEST_VERSION } from './objective-canonical-regeneration-request.js';
import { checkCanonicalRegenerationNormalization } from './objective-canonical-regeneration-ledger.js';
import type { CanonicalStrategyBasis } from './objective-canonical-basis.js';
import type { DraftJobInput } from './draft-job.types.js';

const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => { throw new CanonicalApplicationError(code); };

/** Consistency reconstruction, NEVER authority or an effect/absence decision.
 * New-effect callers hold Planner -> original job locks before this read and
 * retain their existing current-source/consent/release fences. Completion reads
 * retain their own fresh read admission. No external IO, new tx, job or writer. */
async function reconstructSavedGeneration(tx: Prisma.TransactionClient,
  scope: { tenantId: string; clerkUserId: string; generationJobId: string }) {
  const { tenantId, clerkUserId, generationJobId } = scope;
  const job = await tx.spDraftJob.findFirst({ where: { tenantId, id: generationJobId, ownerUserId: clerkUserId } });
  if (!job || job.status !== 'completed') return fail();
  const input = job.input as unknown as DraftJobInput;
  if (input.canonicalTerminal !== undefined) return fail();
  const { admission: a, acceptance } = await generationAssociation(tx, tenantId, clerkUserId, generationJobId);
  const stored = await readCanonicalRequestPublication(tx, a);
  if (!stored) return fail();
  const publication = stored.publication, request = publication.request;
  if (a.expectedStrategyVersionId === null) {
    if ('requestVersion' in request || request.basis !== null) return fail('AUTHORITY_UNAVAILABLE');
  } else if (!('requestVersion' in request) || request.requestVersion !== CORE_CANONICAL_REGENERATION_REQUEST_VERSION ||
      request.applicationTarget.expectedStrategyVersionId !== a.expectedStrategyVersionId ||
      request.basisSha256 !== applicationHash(request.basis)) return fail('AUTHORITY_UNAVAILABLE');
  const producer = await readCanonicalGenerationProducer(tx, tenantId, clerkUserId, generationJobId);
  const witness = ('requestVersion' in request ? checkCanonicalRegenerationCompletionWitness : checkCanonicalCompletionWitness)(
    input.canonicalCompletion, { admission: a, acceptance, publication });
  const record = await readGenerationLedger(tx, GENERATION_NORMALIZATION, tenantId, clerkUserId, generationJobId) as Record<string, any> | null;
  const saved = producer.objectiveReceipt.result;
  if (!saved || !record || record.schemaVersion !== ('requestVersion' in request ? 2 : 1) || record.generationJobId !== generationJobId ||
      record.generationRequestId !== a.generationRequestId || record.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      record.sourceAcceptanceSha256 !== applicationHash(acceptance) || record.strategyId !== saved.strategyId ||
      record.strategyVersionId !== saved.strategyVersionId || record.snapshotDigest !== producer.snapshotDigest ||
      record.normalizationWitness?.proposedPayloadSha256 !== witness.corePayloadSha256) return fail();
  if ('requestVersion' in request) {
    // Historical ACK recovery reads the exact saved version and ORIGINAL
    // publication, never a current mutable head/basis after human edits.
    const version = await tx.spVersion.findFirst({ where: { tenantId, strategyId: saved.strategyId, id: saved.strategyVersionId } });
    if (!version || version.coalescible !== false || version.authorKind !== 'meri' || version.authorUserId !== clerkUserId ||
        applicationHash(version.snapshot) !== producer.snapshotDigest) return fail();
    checkCanonicalRegenerationNormalization(record, { admission: a, acceptance, basis: request.basis,
      saved: { strategyId: saved.strategyId, strategyVersionId: saved.strategyVersionId, snapshot: version.snapshot } });
  }
  return { admission: a, acceptance, publication, producer, normalization: record,
    receipt: { schemaVersion: 1 as const, generationJobId,
      sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a), sourceBinding: acceptance.sourceBinding,
      sourceRequestSha256: acceptance.sourceRequestSha256, completion: witness,
      objectiveReceipt: producer.objectiveReceipt, objectiveReceiptSha256: applicationHash(producer.objectiveReceipt),
      snapshotDigest: producer.snapshotDigest } };
}

/** Stored corruption is uncertainty, not an invalid caller body or proof that
 * no application occurred. Caller input and current-authority fences stay in
 * their respective owners; the private unsupported-version refusal is kept. */
export async function readCanonicalSavedGeneration(tx: Prisma.TransactionClient,
  scope: { tenantId: string; clerkUserId: string; generationJobId: string }) {
  try { return await reconstructSavedGeneration(tx, scope); }
  catch (error) {
    if (error instanceof CanonicalApplicationError && error.code !== 'AUTHORITY_UNAVAILABLE' && error.code !== 'OUTCOME_UNCONFIRMED')
      return fail();
    throw error;
  }
}

/** New-effect historical input gate. A producer/normalization label alone
 * cannot establish the SDK custody of a predecessor adopted into a basis.
 * Reconstruct each exact original saved result; never recurse into a latest
 * mutable head, renew its grant or select a newer generation on a failed read.
 * Full basis structure/chain and current rows remain the capture owner. */
export async function requireCanonicalBasisCustody(tx: Prisma.TransactionClient, basis: CanonicalStrategyBasis): Promise<void> {
  applicationHash(basis);
  if (!Array.isArray(basis.provenance) || basis.provenance.length === 0) return fail();
  for (const ref of basis.provenance) {
    const saved = await readCanonicalSavedGeneration(tx, { tenantId: basis.canonical.tenantId,
      clerkUserId: ref.ownerUserId, generationJobId: ref.generationJobId });
    const a = saved.admission, c = a.canonical;
    if (['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId', 'canonicalProjectId', 'epoch']
        .some(key => c[key as keyof typeof c] !== basis.canonical[key as keyof typeof c]) ||
        ref.generationRequestId !== a.generationRequestId || ref.canonicalBindingVersion !== c.bindingVersion ||
        ref.admissionId !== generationLedgerId(GENERATION_ADMISSION, c.tenantId, ref.ownerUserId, a.generationJobId) ||
        ref.admissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
        ref.acceptanceId !== generationLedgerId(GENERATION_ACCEPTANCE, c.tenantId, ref.ownerUserId, a.generationJobId) ||
        ref.acceptanceSha256 !== applicationHash(saved.acceptance) ||
        ref.normalizationId !== generationLedgerId(GENERATION_NORMALIZATION, c.tenantId, ref.ownerUserId, a.generationJobId) ||
        ref.normalizationSha256 !== applicationHash(saved.normalization) ||
        ref.producerId !== generationLedgerId(GENERATION_PRODUCER, c.tenantId, ref.ownerUserId, a.generationJobId) ||
        ref.producerSha256 !== applicationHash(saved.producer) ||
        ref.strategyVersionId !== saved.receipt.objectiveReceipt.result?.strategyVersionId ||
        ref.snapshotSha256 !== saved.receipt.snapshotDigest) return fail();
  }
}

/** Derive the unchanged nine-field materializer command from actual saved
 * receipt evidence. Compare it to the authenticated original work; never adopt
 * caller-selected Strategy/version, digest or a merely reserved output ID. */
export function requireSavedGenerationApplication(saved: Awaited<ReturnType<typeof readCanonicalSavedGeneration>>,
  actorUserId: string, requested: CanonicalApplicationRequest): CanonicalApplicationRequest {
  const a = saved.admission, r = saved.receipt;
  if (a.actorUserId !== actorUserId || !r.objectiveReceipt.result) return fail('REQUEST_CONFLICT');
  const actual = parseCanonicalApplication({ schemaVersion: 1, canonical: a.canonical,
    applicationRequestId: canonicalApplicationRequestId(a.canonical, actorUserId),
    generationJobId: a.generationJobId, generationRequestId: a.generationRequestId,
    strategyId: r.objectiveReceipt.result.strategyId, strategyVersionId: r.objectiveReceipt.result.strategyVersionId,
    objectiveReceiptSha256: r.objectiveReceiptSha256, snapshotDigest: r.snapshotDigest });
  if (applicationHash(actual) !== applicationHash(requested)) return fail('REQUEST_CONFLICT');
  return actual;
}
