/**
 * Production wrapper around the original pure Phase 5 projection planner.
 *
 * It closes the post-merge audit gaps without authorizing writes:
 * - every input artifact is the exact artifact certified by the cycle bundle;
 * - every artifact is bound to exact Phase 3 parser-result proof;
 * - every projected assertion is accepted by the exact Phase 2 run;
 * - only a Phase 2 machine PASS may enter Phase 5 projection planning;
 * - every projection candidate carries non-empty assertion/evidence ledgers;
 * - MILCON identity includes the manifest-owned appropriation account;
 * - same project/location under different accounts cannot collapse before
 *   duplicate handling;
 * - candidate IDs and the plan content SHA are recomputed after normalization.
 */
import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';
import { sha256CanonicalJson } from '../contracts/canonical-json.js';
import {
  defenseBudgetVerificationResultV1Schema,
  type DefenseBudgetVerificationResultV1,
} from '../verification/verification-contract-v1.js';
import {
  computeNonRdteProjectionPlanContentSha256,
  nonRdteProjectionCandidateId,
  type NonRdteCanonicalProjectionPlanV1,
  type NonRdteProjectionCandidateV1,
} from './non-rdte-canonical-projection-plan-v1.js';
import {
  planNonRdteCanonicalProjection,
  NonRdteProjectionPlanningError,
  type NonRdteProjectionPlannerInput,
  type NonRdteProjectionPlannerResult,
} from './non-rdte-projection-planner-v1.js';
import {
  assertPhase5ArtifactProofBound,
  type Phase5ParserResultProofV1,
} from './non-rdte-proof-bound-artifact-v1.js';

export interface Phase5ProofBoundProjectionPlannerInput extends Omit<
  NonRdteProjectionPlannerInput,
  'allowedReviewedAcceptances'
> {
  parserResultProofsByArtifactId: ReadonlyMap<string, readonly Phase5ParserResultProofV1[]>;
  /** Exact Phase 2 result keyed by verificationRunId. */
  verificationResultsByRunId: ReadonlyMap<string, DefenseBudgetVerificationResultV1>;
  /** Manifest document key -> exact printed appropriation/account context. */
  milconAccountByDocumentKey: ReadonlyMap<string, string>;
}

interface MilconIdentityParts {
  projectCode: string;
  component: string;
  location?: string;
}

type MilconProjectIdentityV1 = Extract<BudgetLineIdentityV1, { lineKind: 'MILCON_PROJECT' }>;

function upper(value: string): string {
  return value.trim().toUpperCase();
}

function actualMilconKey(identity: MilconIdentityParts, account: string): string {
  const location =
    identity.location == null || identity.location.trim() === ''
      ? 'NO_LOC'
      : upper(identity.location);
  return `MILCON_PROJECT:${upper(identity.component)}:${upper(identity.projectCode)}:${location}:${upper(account)}`;
}

function discriminator(identity: MilconIdentityParts, account: string): string {
  const location =
    identity.location == null || identity.location.trim() === ''
      ? 'NO_LOC'
      : upper(identity.location);
  const accountHash = sha256CanonicalJson(account as JsonValue)
    .slice(0, 16)
    .toUpperCase();
  return `${location}__ACCT_${accountHash}`;
}

function legacyMilconKey(identity: MilconIdentityParts): string {
  const location =
    identity.location == null || identity.location.trim() === ''
      ? 'NO_LOC'
      : upper(identity.location);
  return `MILCON_PROJECT:${upper(identity.component)}:${upper(identity.projectCode)}:${location}:${location}`;
}

function procurementKey(
  identity: Extract<BudgetLineIdentityV1, { lineKind: 'PROCUREMENT_BLIN' }>,
): string {
  return `PROCUREMENT_BLIN:${identity.component}:${upper(identity.account)}:${upper(identity.code)}:${identity.advanceProcurement ? 'advance' : 'base'}`;
}

function omKey(identity: Extract<BudgetLineIdentityV1, { lineKind: 'OM_SAG' }>): string {
  return `OM_SAG:${identity.component}:${upper(identity.account)}:${upper(identity.code)}`;
}

function identityKey(identity: BudgetLineIdentityV1): string | null {
  if (identity.lineKind === 'PROCUREMENT_BLIN') return procurementKey(identity);
  if (identity.lineKind === 'OM_SAG') return omKey(identity);
  if (identity.lineKind === 'MILCON_PROJECT') return legacyMilconKey(identity);
  return null;
}

function assertionIdentityKey(assertion: DefenseBudgetAssertionV1): string | null {
  switch (assertion.assertionKind) {
    case 'procurement_line':
      return procurementKey(assertion.parentIdentity);
    case 'om_line':
      return omKey(assertion.identity);
    case 'milcon_project':
      return legacyMilconKey(assertion.identity);
    case 'funding':
    case 'quantity':
    case 'unit_cost':
    case 'narrative':
      return identityKey(assertion.identity);
    case 'relationship':
      return identityKey(assertion.from);
    case 'document_fact': {
      const value = assertion.metadata?.identityNaturalKey;
      return typeof value === 'string' ? value : null;
    }
    default:
      return null;
  }
}

function normalizeMilconIdentity(
  identity: MilconProjectIdentityV1,
  account: string,
  replacements: Map<string, string>,
): MilconProjectIdentityV1;
function normalizeMilconIdentity(
  identity: BudgetLineIdentityV1,
  account: string,
  replacements: Map<string, string>,
): BudgetLineIdentityV1;
function normalizeMilconIdentity(
  identity: BudgetLineIdentityV1,
  account: string,
  replacements: Map<string, string>,
): BudgetLineIdentityV1 {
  if (identity.lineKind !== 'MILCON_PROJECT') return identity;
  const fullKey = actualMilconKey(identity, account);
  const encoded = discriminator(identity, account);
  const normalized: MilconProjectIdentityV1 = {
    ...identity,
    location: encoded,
  };
  const oldKey = legacyMilconKey(normalized);
  const existing = replacements.get(oldKey);
  if (existing != null && existing !== fullKey) {
    throw new NonRdteProjectionPlanningError(
      `MILCON discriminator collision for ${oldKey}`,
      'milcon_identity_collision',
    );
  }
  replacements.set(oldKey, fullKey);
  return normalized;
}

function normalizeArtifactForLegacyPlanner(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  accountByDocumentKey: ReadonlyMap<string, string>;
  replacements: Map<string, string>;
}): DefenseBudgetExtractionArtifactV1 {
  const artifact = structuredClone(input.artifact);
  if (artifact.source.family !== 'milcon') return artifact;
  const account = input.accountByDocumentKey.get(artifact.source.manifestDocumentKey)?.trim();
  if (!account) {
    throw new NonRdteProjectionPlanningError(
      `MILCON document ${artifact.source.manifestDocumentKey} has no manifest account`,
      'milcon_account_missing',
    );
  }

  artifact.assertions = artifact.assertions.map((assertion) => {
    switch (assertion.assertionKind) {
      case 'milcon_project':
        return {
          ...assertion,
          identity: normalizeMilconIdentity(assertion.identity, account, input.replacements),
          metadata: { ...(assertion.metadata ?? {}), account },
        };
      case 'funding':
      case 'quantity':
      case 'unit_cost':
      case 'narrative':
        return {
          ...assertion,
          identity: normalizeMilconIdentity(assertion.identity, account, input.replacements),
          metadata: { ...(assertion.metadata ?? {}), account },
        };
      case 'relationship':
        return {
          ...assertion,
          from: normalizeMilconIdentity(assertion.from, account, input.replacements),
          to: normalizeMilconIdentity(assertion.to, account, input.replacements),
          metadata: { ...(assertion.metadata ?? {}), account },
        };
      case 'document_fact': {
        const rawKey = assertion.metadata?.identityNaturalKey;
        if (typeof rawKey !== 'string' || !rawKey.startsWith('MILCON_PROJECT:')) {
          return assertion;
        }
        return { ...assertion, metadata: { ...(assertion.metadata ?? {}), account } };
      }
      default:
        return assertion;
    }
  });
  return artifact;
}

function replaceKnownKeys(value: string, replacements: ReadonlyMap<string, string>): string {
  let output = value;
  for (const [from, to] of replacements) {
    output = output.split(from).join(to);
  }
  return output;
}

function normalizeValue(
  value: string | number | boolean | null,
  replacements: ReadonlyMap<string, string>,
): string | number | boolean | null {
  return typeof value === 'string' ? replaceKnownKeys(value, replacements) : value;
}

function bindSourceObservationLedgers(input: {
  candidate: NonRdteProjectionCandidateV1;
  artifactsById: ReadonlyMap<string, DefenseBudgetExtractionArtifactV1>;
}): NonRdteProjectionCandidateV1 {
  if (input.candidate.assertionIds.length > 0 && input.candidate.evidenceIds.length > 0) {
    return input.candidate;
  }
  if (input.candidate.target !== 'BudgetLineSourceObservation') {
    throw new NonRdteProjectionPlanningError(
      `projection candidate ${input.candidate.candidateId} has an empty assertion/evidence ledger`,
      'projection_provenance_empty',
    );
  }

  const artifact = input.artifactsById.get(input.candidate.artifactId);
  const identityNaturalKey = input.candidate.values.identityNaturalKey;
  if (artifact == null || typeof identityNaturalKey !== 'string') {
    throw new NonRdteProjectionPlanningError(
      `source-observation candidate ${input.candidate.candidateId} cannot resolve its artifact identity`,
      'projection_provenance_unresolved',
    );
  }

  const assertionIds: string[] = [];
  const evidenceIds: string[] = [];
  for (const assertion of artifact.assertions) {
    if (assertionIdentityKey(assertion) !== identityNaturalKey) continue;
    if (assertion.evidenceIds.length === 0) continue;
    assertionIds.push(assertion.assertionId);
    evidenceIds.push(...assertion.evidenceIds);
  }
  if (assertionIds.length === 0 || evidenceIds.length === 0) {
    throw new NonRdteProjectionPlanningError(
      `source-observation candidate ${input.candidate.candidateId} has no supporting assertion proof`,
      'projection_provenance_unresolved',
    );
  }
  return {
    ...input.candidate,
    assertionIds: [...new Set(assertionIds)].sort(),
    evidenceIds: [...new Set(evidenceIds)].sort(),
  };
}

function normalizePlan(input: {
  original: NonRdteProjectionPlannerResult;
  normalizedArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
  replacements: ReadonlyMap<string, string>;
}): NonRdteProjectionPlannerResult {
  const artifactsById = new Map(
    input.normalizedArtifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const candidates = input.original.plan.candidates.map((candidate) => {
    const values = Object.fromEntries(
      Object.entries(candidate.values).map(([key, value]) => [
        key,
        normalizeValue(value, input.replacements),
      ]),
    );
    const normalized = bindSourceObservationLedgers({
      candidate: {
        ...candidate,
        naturalKey: replaceKnownKeys(candidate.naturalKey, input.replacements),
        reason: replaceKnownKeys(candidate.reason, input.replacements),
        values,
      },
      artifactsById,
    });
    return {
      ...normalized,
      candidateId: nonRdteProjectionCandidateId({
        target: normalized.target,
        naturalKey: normalized.naturalKey,
        artifactId: normalized.artifactId,
      }),
    };
  });

  const withoutHash: Omit<NonRdteCanonicalProjectionPlanV1, 'contentSha256'> = {
    ...input.original.plan,
    candidates,
    exclusions: input.original.plan.exclusions.map((exclusion) => ({
      ...exclusion,
      message: replaceKnownKeys(exclusion.message, input.replacements),
    })),
  };
  return {
    plan: {
      ...withoutHash,
      contentSha256: computeNonRdteProjectionPlanContentSha256(withoutHash),
    },
  };
}

function acceptedArtifactForProjection(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  verificationRef: NonRdteProjectionPlannerInput['bundle']['verifications'][number];
  result: DefenseBudgetVerificationResultV1;
}): DefenseBudgetExtractionArtifactV1 {
  const result = defenseBudgetVerificationResultV1Schema.parse(input.result);
  const expectedDecision =
    result.decision === 'PASS'
      ? 'VERIFICATION_PASSED'
      : result.decision === 'REVIEW'
        ? 'NEEDS_REVIEW'
        : 'REJECTED';
  if (
    input.verificationRef.artifactId !== input.artifact.artifactId ||
    result.manifestDocumentKey !== input.artifact.source.manifestDocumentKey ||
    result.verificationRunId !== input.verificationRef.verificationRunId ||
    result.candidateId !== input.verificationRef.verificationCandidateId ||
    result.extractionArtifactId !== input.artifact.artifactId ||
    result.extractionArtifactSha256 !== input.artifact.contentSha256 ||
    result.sourcePdfSha256 !== input.artifact.source.sourcePdfSha256 ||
    input.artifact.source.sourceDocumentId == null ||
    result.sourceDocumentId !== input.artifact.source.sourceDocumentId ||
    expectedDecision !== input.verificationRef.decision
  ) {
    throw new NonRdteProjectionPlanningError(
      `Phase 2 result does not match certified artifact ${input.artifact.artifactId}`,
      'verification_result_mismatch',
    );
  }
  if (
    result.decision !== 'PASS' ||
    result.status !== 'VERIFICATION_PASSED' ||
    input.verificationRef.decision !== 'VERIFICATION_PASSED'
  ) {
    throw new NonRdteProjectionPlanningError(
      `Phase 5 projection accepts only a Phase 2 VERIFICATION_PASSED result for ${input.artifact.artifactId}`,
      'verification_not_passed',
    );
  }
  const artifactIds = new Set(input.artifact.assertions.map((assertion) => assertion.assertionId));
  const accepted = new Set(result.acceptedAssertionIds);
  for (const assertionId of accepted) {
    if (!artifactIds.has(assertionId)) {
      throw new NonRdteProjectionPlanningError(
        `Phase 2 run ${result.verificationRunId} accepted unknown assertion ${assertionId}`,
        'verification_assertion_unknown',
      );
    }
  }
  for (const assertionId of result.rejectedAssertionIds) {
    if (accepted.has(assertionId)) {
      throw new NonRdteProjectionPlanningError(
        `Phase 2 run ${result.verificationRunId} both accepted and rejected ${assertionId}`,
        'verification_assertion_conflict',
      );
    }
  }
  return {
    ...input.artifact,
    assertions: input.artifact.assertions.filter((assertion) =>
      accepted.has(assertion.assertionId),
    ),
  };
}

function uniqueMap<K, V>(entries: readonly (readonly [K, V])[], label: string): Map<K, V> {
  const map = new Map<K, V>();
  for (const [key, value] of entries) {
    if (map.has(key)) {
      throw new NonRdteProjectionPlanningError(
        `duplicate ${label}: ${String(key)}`,
        'certified_bundle_duplicate',
      );
    }
    map.set(key, value);
  }
  return map;
}

export function planProofBoundNonRdteCanonicalProjection(
  input: Phase5ProofBoundProjectionPlannerInput,
): NonRdteProjectionPlannerResult {
  const unsafeInput = input as Phase5ProofBoundProjectionPlannerInput & {
    allowedReviewedAcceptances?: unknown;
  };
  if (unsafeInput.allowedReviewedAcceptances != null) {
    throw new NonRdteProjectionPlanningError(
      'caller-supplied reviewed acceptance is not a Phase 2 proof object and cannot authorize Phase 5 projection',
      'review_acceptance_bypass',
    );
  }

  const certifiedArtifactByDocumentKey = uniqueMap(
    input.bundle.artifacts.map((artifact) => [artifact.manifestDocumentKey, artifact] as const),
    'certified artifact document key',
  );
  const verificationByDocumentKey = uniqueMap(
    input.bundle.verifications.map(
      (verification) => [verification.manifestDocumentKey, verification] as const,
    ),
    'verification document key',
  );
  const inputArtifactByDocumentKey = uniqueMap(
    input.artifacts.map((artifact) => [artifact.source.manifestDocumentKey, artifact] as const),
    'input artifact document key',
  );
  if (inputArtifactByDocumentKey.size !== certifiedArtifactByDocumentKey.size) {
    throw new NonRdteProjectionPlanningError(
      `projection artifact set does not equal the certified bundle artifact set`,
      'certified_artifact_set_mismatch',
    );
  }

  const acceptedArtifacts: DefenseBudgetExtractionArtifactV1[] = [];
  for (const artifact of input.artifacts) {
    const certifiedArtifact = certifiedArtifactByDocumentKey.get(
      artifact.source.manifestDocumentKey,
    );
    if (
      certifiedArtifact == null ||
      certifiedArtifact.artifactId !== artifact.artifactId ||
      certifiedArtifact.artifactContentSha256 !== artifact.contentSha256
    ) {
      throw new NonRdteProjectionPlanningError(
        `artifact ${artifact.artifactId} is not the exact artifact certified by the bundle`,
        'certified_artifact_mismatch',
      );
    }
    const proofs = input.parserResultProofsByArtifactId.get(artifact.artifactId);
    if (proofs == null) {
      throw new NonRdteProjectionPlanningError(
        `artifact ${artifact.artifactId} has no parser-result proof bundle`,
        'parser_result_proof_missing',
      );
    }
    assertPhase5ArtifactProofBound({ artifact, parserResultProofs: proofs });
    const verificationRef = verificationByDocumentKey.get(artifact.source.manifestDocumentKey);
    if (verificationRef == null) {
      throw new NonRdteProjectionPlanningError(
        `artifact ${artifact.artifactId} has no cycle verification reference`,
        'verification_result_missing',
      );
    }
    const result = input.verificationResultsByRunId.get(verificationRef.verificationRunId);
    if (result == null) {
      throw new NonRdteProjectionPlanningError(
        `verification result ${verificationRef.verificationRunId} is unavailable`,
        'verification_result_missing',
      );
    }
    acceptedArtifacts.push(acceptedArtifactForProjection({ artifact, verificationRef, result }));
  }

  const replacements = new Map<string, string>();
  const normalizedArtifacts = acceptedArtifacts.map((artifact) =>
    normalizeArtifactForLegacyPlanner({
      artifact,
      accountByDocumentKey: input.milconAccountByDocumentKey,
      replacements,
    }),
  );
  const planned = planNonRdteCanonicalProjection({
    bundle: input.bundle,
    artifacts: normalizedArtifacts,
    familyReport: input.familyReport,
    ...(input.canonicalRows != null ? { canonicalRows: input.canonicalRows } : {}),
  });
  return normalizePlan({
    original: planned,
    normalizedArtifacts,
    replacements,
  });
}
