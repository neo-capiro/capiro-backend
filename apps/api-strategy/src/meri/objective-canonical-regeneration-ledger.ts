import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, applicationJson, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { buildSnapshot, type StrategySnapshot } from '../strategy/versioning.js';
import type { CanonicalStrategyBasis } from './objective-canonical-basis.js';
import type { NormalizedCanonicalDraft, CanonicalDraftNormalizationWitness } from './objective-canonical-draft.js';
import { GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_NORMALIZATION,
  canonicalGenerationAdmissionSha256, generationLedgerId, generationUuid,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission,
  type CanonicalGenerationAdmission, type CanonicalGenerationAcceptance } from './objective-canonical-generation.js';
import { generationAssociation, insertGenerationLedger, readGenerationLedger } from './objective-canonical-producer-ledger.js';
import { deriveCanonicalJobInput } from './objective-canonical-job-input.js';
import { planCanonicalStrategyRegeneration, type CanonicalStrategyRegenerationPlan } from './objective-canonical-regeneration.js';

export const CANONICAL_REGENERATION_NORMALIZATION_MAX_BYTES = 2 * 1024 * 1024;
/** Version 2 uses the SAME private normalization kind and deterministic ID.
 * This is owner evidence in an existing row, not another journal/schema or a
 * claim of database-enforced append-only storage. Prior basis is retained in
 * full so original human observations and field decisions remain replayable. */
export interface StoredCanonicalRegenerationNormalization {
  schemaVersion: 2; generationJobId: string; generationRequestId: string;
  sourceAdmissionId: string; sourceAdmissionSha256: string;
  sourceAcceptanceId: string; sourceAcceptanceSha256: string;
  strategyId: string; strategyVersionId: string; snapshotDigest: string;
  normalizationWitness: CanonicalDraftNormalizationWitness;
  nodes: Array<{ sourceNodeKey: string; nodeId: string }>;
  priorBasis: CanonicalStrategyBasis; priorBasisSha256: string;
  predecessorNormalizationIds: string[];
  planning: { createdByUserId: string; createdAt: string };
  mergePlan: CanonicalStrategyRegenerationPlan; mergePlanSha256: string;
}
const unavailable = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const clone = <T>(raw: T): T => JSON.parse(applicationJson(raw)) as T;
const equal = (a: unknown, b: unknown) => applicationJson(a) === applicationJson(b);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** cutVersion orders nodes by dates. Identity-normalized equality compares all
 * fields while avoiding a false mismatch with the planner's stable ID order. */
export function canonicalRegenerationSnapshot(raw: unknown): StrategySnapshot {
  const s = clone(raw) as StrategySnapshot;
  if (!s || typeof s !== 'object' || !s.meta || !Array.isArray(s.nodes)) return unavailable();
  const ids = new Set<string>();
  for (const n of s.nodes) {
    if (!n || typeof n !== 'object') return unavailable();
    generationUuid(n.id);
    if (ids.has(n.id)) return unavailable();
    ids.add(n.id);
  }
  s.nodes.sort((a, b) => compare(a.id, b.id));
  return s;
}
function recordValue(a: CanonicalGenerationAdmission, accepted: CanonicalGenerationAcceptance,
  basis: CanonicalStrategyBasis, normalized: NormalizedCanonicalDraft, plan: CanonicalStrategyRegenerationPlan,
  saved: { strategyId: string; strategyVersionId: string; snapshot: unknown }): StoredCanonicalRegenerationNormalization {
  applicationJson({ basis, normalized, plan, saved });
  if (a.expectedStrategyVersionId === null || saved.strategyId !== a.canonical.canonicalStrategyId ||
      saved.strategyVersionId === a.expectedStrategyVersionId || basis.expectedStrategyVersionId !== a.expectedStrategyVersionId ||
      basis.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) || !equal(basis.canonical, a.canonical) ||
      basis.strategyId !== saved.strategyId || !Array.isArray(basis.provenance) || !basis.provenance.length) return unavailable();
  generationUuid(saved.strategyId); generationUuid(saved.strategyVersionId);
  const normalizationId = generationLedgerId(GENERATION_NORMALIZATION, a.canonical.tenantId, a.clerkUserId, a.generationJobId);
  const w = normalized.normalizationWitness;
  if (!w || w.schemaVersion !== 2 || w.namespace !== 'capiro.objective-strategy.normalization:v2' ||
      w.identityBasis !== 'retained-server-basis' || w.expectedStrategyVersionId !== a.expectedStrategyVersionId ||
      w.basisSha256 !== applicationHash(basis) || w.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      !equal(plan.normalized, normalized) || !plan.planning || plan.planning.createdByUserId !== a.clerkUserId ||
      plan.normalizationId !== normalizationId) return unavailable();
  let replay: CanonicalStrategyRegenerationPlan;
  try {
    replay = planCanonicalStrategyRegeneration({ basis, normalized, current: basis.snapshot,
      archivedNodeIds: basis.archiveIndex.map(n => n.nodeId), createdByUserId: a.clerkUserId,
      createdAt: plan.planning.createdAt, normalizationId });
  } catch { return unavailable(); }
  if (!equal(replay, plan) || !equal(canonicalRegenerationSnapshot(saved.snapshot), canonicalRegenerationSnapshot(plan.snapshot))) return unavailable();
  const record: StoredCanonicalRegenerationNormalization = {
    schemaVersion: 2, generationJobId: a.generationJobId, generationRequestId: a.generationRequestId,
    sourceAdmissionId: generationLedgerId(GENERATION_ADMISSION, a.canonical.tenantId, a.clerkUserId, a.generationJobId),
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a),
    sourceAcceptanceId: generationLedgerId(GENERATION_ACCEPTANCE, a.canonical.tenantId, a.clerkUserId, a.generationJobId),
    sourceAcceptanceSha256: applicationHash(accepted), strategyId: saved.strategyId, strategyVersionId: saved.strategyVersionId,
    snapshotDigest: applicationHash(saved.snapshot), normalizationWitness: clone(w),
    nodes: normalized.sourceKeys.map((sourceNodeKey, i) => ({ sourceNodeKey, nodeId: normalized.nodeIds[i]! })),
    priorBasis: clone(basis), priorBasisSha256: applicationHash(basis),
    predecessorNormalizationIds: basis.provenance.map(p => p.normalizationId),
    planning: clone(plan.planning), mergePlan: clone(plan), mergePlanSha256: applicationHash(plan),
  };
  if (Buffer.byteLength(applicationJson(record), 'utf8') > CANONICAL_REGENERATION_NORMALIZATION_MAX_BYTES) return unavailable();
  return record;
}
/** Coherence/replay of ONE record against independently owner-resolved facts.
 * The basis owner additionally proves the complete, unique predecessor chain.
 * A parsed record or self-hash authenticates neither storage nor the actor. */
export function checkCanonicalRegenerationNormalization(raw: unknown, expected: {
  admission: unknown; acceptance: unknown; basis: CanonicalStrategyBasis;
  saved: { strategyId: string; strategyVersionId: string; snapshot: unknown };
}): StoredCanonicalRegenerationNormalization {
  const r = clone(raw) as StoredCanonicalRegenerationNormalization;
  const a = parseCanonicalGenerationAdmission(expected.admission);
  const accepted = requireGenerationAcceptanceForAdmission(expected.acceptance, a);
  if (!r || r.schemaVersion !== 2 || !r.mergePlan || !r.mergePlan.normalized || !equal(r.priorBasis, expected.basis)) return unavailable();
  const rebuilt = recordValue(a, accepted, expected.basis, r.mergePlan.normalized, r.mergePlan, expected.saved);
  if (!equal(r, rebuilt)) return unavailable();
  return rebuilt;
}
/** Call after the actual preserving writer cuts its version and BEFORE its
 * existing afterWrite completion hook, in that SAME transaction. The caller
 * has already freshly recaptured and compared the actual locked basis; this
 * helper replays the plan, checks the actual running claim and complete saved
 * owner rows, then appends one schema-2 row under the existing private kind. */
export async function recordCanonicalRegenerationNormalization(tx: Prisma.TransactionClient,
  tenantId: string, clerkUserId: string, generationJobId: string,
  saved: { strategyId: string; strategyVersionId: string }, input: {
    basis: CanonicalStrategyBasis; normalized: NormalizedCanonicalDraft; plan: CanonicalStrategyRegenerationPlan;
  }): Promise<StoredCanonicalRegenerationNormalization> {
  const { admission: a, acceptance } = await generationAssociation(tx, tenantId, clerkUserId, generationJobId);
  if (a.expectedStrategyVersionId === null) return unavailable();
  const job = await tx.spDraftJob.findFirst({ where: { id: generationJobId, tenantId, ownerUserId: clerkUserId } });
  if (!job) return unavailable();
  const envelope = (job.input as { objectiveGeneration?: unknown }).objectiveGeneration;
  const actual = deriveCanonicalJobInput(job, a, envelope, `canonical:${acceptance.issuance.issuanceKey}`);
  if (input.normalized.normalizationWitness.strategyType !== actual.dto.type) return unavailable();
  const version = await tx.spVersion.findFirst({ where: { id: saved.strategyVersionId, tenantId, strategyId: saved.strategyId } });
  if (!version || version.coalescible !== false || version.authorKind !== 'meri' || version.authorUserId !== clerkUserId) return unavailable();
  const prior = await tx.spVersion.findFirst({ where: { id: a.expectedStrategyVersionId, tenantId, strategyId: saved.strategyId } });
  if (!prior || prior.coalescible !== false || !equal(canonicalRegenerationSnapshot(prior.snapshot),
    canonicalRegenerationSnapshot(input.basis.snapshot))) return unavailable();
  for (const ref of input.basis.provenance) {
    const predecessor = await readGenerationLedger(tx, GENERATION_NORMALIZATION, tenantId, ref.ownerUserId, ref.generationJobId);
    if (!predecessor || applicationHash(predecessor) !== ref.normalizationSha256) return unavailable();
  }
  const record = recordValue(a, acceptance, input.basis, input.normalized, input.plan, { ...saved, snapshot: version.snapshot });
  const strategy = await tx.spStrategy.findFirst({ where: { tenantId, id: saved.strategyId } });
  const nodes = await tx.spNode.findMany({ where: { tenantId, strategyId: saved.strategyId } });
  if (!strategy || strategy.archivedAt !== null || strategy.clientId !== a.canonical.clientId ||
      nodes.some(n => n.tenantId !== tenantId || n.strategyId !== saved.strategyId) || new Set(nodes.map(n => n.id)).size !== nodes.length)
    return unavailable();
  const live = nodes.filter(n => n.archivedAt === null);
  if (!equal(canonicalRegenerationSnapshot(buildSnapshot(strategy, live)), canonicalRegenerationSnapshot(version.snapshot))) return unavailable();
  const archives = nodes.filter(n => n.archivedAt !== null).map(n => ({ nodeId: n.id, archivedAt: n.archivedAt!.toISOString() }))
    .sort((a, b) => compare(a.nodeId, b.nodeId));
  if (!equal(archives, input.basis.archiveIndex) || !equal(archives.map(n => n.nodeId), [...input.plan.archivedNodeIds].sort(compare))) return unavailable();
  await insertGenerationLedger(tx, GENERATION_NORMALIZATION, tenantId, clerkUserId, generationJobId, record);
  return record;
}
