/** Production Phase 4 projection entry point with exact Phase 2 proof binding. */
import type { RdteCycleBundleV1, RdteCycleVerificationRefV1 } from '../rdte-cycle-bundle-v1.js';
import {
  computeProjectionPlanContentSha256,
  proofBoundRdteCanonicalProjectionPlanV1Schema,
  RDTE_PROJECTION_TARGET_V1_VALUES,
  rdteProjectionCandidateId,
  type ProofBoundRdteAssertionBindingV1,
  type ProofBoundRdteCanonicalProjectionPlanV1,
  type ProofBoundRdteProjectionCandidateV1,
  type RdteProjectionTargetV1,
} from './rdte-canonical-projection-plan-v1.js';
import {
  planRdteCanonicalProjection,
  type RdteCanonicalRowSnapshotV1,
} from './rdte-projection-planner-v1.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../contracts/extraction-artifact-v1.js';

function isTrustedTerminal(verification: RdteCycleVerificationRefV1): boolean {
  return (
    (verification.phase2Decision === 'PASS' && verification.status === 'VERIFICATION_PASSED') ||
    (verification.phase2Decision === 'REVIEW' && verification.status === 'REVIEW_ACCEPTED')
  );
}

function peCodeOfAssertion(assertion: DefenseBudgetAssertionV1): string | null {
  if ('identity' in assertion && assertion.identity?.lineKind === 'RDTE_PE') {
    return assertion.identity.peCode;
  }
  if ('parentPeCode' in assertion && typeof assertion.parentPeCode === 'string') {
    return assertion.parentPeCode;
  }
  return null;
}

type CandidateValues = Record<string, string | number | boolean | null>;

function periodMetadata(
  assertion: DefenseBudgetAssertionV1,
  role: 'planned' | 'actual',
): Record<string, unknown> | null {
  if (assertion.assertionKind !== 'milestone') return null;
  const value = assertion.metadata?.[role === 'planned' ? 'plannedPeriod' : 'actualPeriod'];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeMilestoneProjection(input: {
  target: RdteProjectionTargetV1;
  naturalKey: string;
  values: CandidateValues;
  assertion: DefenseBudgetAssertionV1 | undefined;
}): { target: RdteProjectionTargetV1; naturalKey: string; values: CandidateValues } {
  if (!input.assertion || input.assertion.assertionKind !== 'milestone') {
    return { target: input.target, naturalKey: input.naturalKey, values: input.values };
  }
  const values: CandidateValues = {
    ...input.values,
    milestoneType: input.assertion.milestoneType,
  };
  const projectCodeValue = input.assertion.metadata?.projectCode;
  const projectCode =
    typeof projectCodeValue === 'string' && projectCodeValue.trim()
      ? projectCodeValue.trim()
      : null;
  if (projectCode) values.projectCode = projectCode;
  else delete values.projectCode;

  if (
    input.target === 'ProgramElementMilestone' ||
    input.target === 'ProgramElementProjectMilestone'
  ) {
    const target: RdteProjectionTargetV1 = projectCode
      ? 'ProgramElementProjectMilestone'
      : 'ProgramElementMilestone';
    const naturalKey = projectCode
      ? `${input.assertion.parentPeCode}|${projectCode}|${input.assertion.milestoneType}`
      : `${input.assertion.parentPeCode}|${input.assertion.milestoneType}`;
    return { target, naturalKey, values };
  }

  if (
    input.target !== 'ProgramElementMilestoneSchedulePeriod' &&
    input.target !== 'ProgramElementProjectMilestoneSchedulePeriod'
  ) {
    return { target: input.target, naturalKey: input.naturalKey, values };
  }

  const target: RdteProjectionTargetV1 = projectCode
    ? 'ProgramElementProjectMilestoneSchedulePeriod'
    : 'ProgramElementMilestoneSchedulePeriod';
  const role = values.periodRole === 'actual' ? 'actual' : 'planned';
  const period = periodMetadata(input.assertion, role);
  const kind = typeof period?.kind === 'string' ? period.kind : values.periodKind;

  /* Exact dates are complete values, not simultaneous calendar-month records. */
  if (kind === 'exact_date') {
    delete values.calendarYear;
    delete values.calendarMonth;
    delete values.calendarQuarter;
    delete values.fiscalYear;
    delete values.fiscalQuarter;
    delete values.rangeStart;
    delete values.rangeEnd;
  }

  /* Coarse ranges retain both endpoint kinds/raw text. DATE columns are used
   * only when each endpoint is an exact date. */
  if (kind === 'range') {
    delete values.exactDate;
    delete values.calendarYear;
    delete values.calendarMonth;
    delete values.calendarQuarter;
    delete values.fiscalYear;
    delete values.fiscalQuarter;
    const start =
      period?.start && typeof period.start === 'object' && !Array.isArray(period.start)
        ? (period.start as Record<string, unknown>)
        : null;
    const end =
      period?.end && typeof period.end === 'object' && !Array.isArray(period.end)
        ? (period.end as Record<string, unknown>)
        : null;
    if (start) {
      if (typeof start.kind === 'string') values.rangeStartKind = start.kind;
      if (typeof start.rawText === 'string') values.rangeStartRawText = start.rawText;
    }
    if (end) {
      if (typeof end.kind === 'string') values.rangeEndKind = end.kind;
      if (typeof end.rawText === 'string') values.rangeEndRawText = end.rawText;
    }
    if (typeof start?.exactDate === 'string' && typeof end?.exactDate === 'string') {
      values.rangeStart = start.exactDate;
      values.rangeEnd = end.exactDate;
    } else {
      delete values.rangeStart;
      delete values.rangeEnd;
    }
  }

  const rawText = typeof values.rawText === 'string' ? values.rawText : '';
  const naturalKey = projectCode
    ? `${input.assertion.parentPeCode}|${projectCode}|${input.assertion.milestoneType}|${role}|${rawText}`
    : `${input.assertion.parentPeCode}|${input.assertion.milestoneType}|${role}|${rawText}`;
  return { target, naturalKey, values };
}

function isMilestoneProjectionTarget(target: RdteProjectionTargetV1): boolean {
  return (
    target === 'ProgramElementMilestone' ||
    target === 'ProgramElementMilestoneSchedulePeriod' ||
    target === 'ProgramElementProjectMilestone' ||
    target === 'ProgramElementProjectMilestoneSchedulePeriod'
  );
}

function isProjectMilestoneTarget(target: RdteProjectionTargetV1): boolean {
  return (
    target === 'ProgramElementProjectMilestone' ||
    target === 'ProgramElementProjectMilestoneSchedulePeriod'
  );
}

function isProjectScopedMilestone(assertion: DefenseBudgetAssertionV1 | undefined): boolean {
  if (!assertion || assertion.assertionKind !== 'milestone') return false;
  const projectCode = assertion.metadata?.projectCode;
  return typeof projectCode === 'string' && projectCode.trim().length > 0;
}

function stableValues(values: CandidateValues): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))),
  );
}

/**
 * The legacy pure mapper groups milestones before it knows about project scope.
 * After assertion-level normalization, distinct projects have distinct keys and
 * are inserts into additive tables. A genuine same-project value conflict still
 * fails closed; it is never downgraded to an insert or resolved last-wins.
 */
function consolidateNormalizedProjectMilestones(
  candidates: readonly ProofBoundRdteProjectionCandidateV1[],
): ProofBoundRdteProjectionCandidateV1[] {
  const groups = new Map<string, ProofBoundRdteProjectionCandidateV1[]>();
  const passthrough: ProofBoundRdteProjectionCandidateV1[] = [];
  for (const candidate of candidates) {
    if (!isProjectMilestoneTarget(candidate.target)) {
      passthrough.push(candidate);
      continue;
    }
    const key = `${candidate.target}|${candidate.naturalKey}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const normalized: ProofBoundRdteProjectionCandidateV1[] = [...passthrough];
  for (const [key, group] of groups) {
    const sorted = [...group].sort(
      (left, right) =>
        left.artifactId.localeCompare(right.artifactId) ||
        left.candidateId.localeCompare(right.candidateId),
    );
    const first = sorted[0];
    if (!first) continue;
    const firstValues = stableValues(first.values);
    if (sorted.some((candidate) => stableValues(candidate.values) !== firstValues)) {
      throw new Error(`project milestone projection conflict for ${key}`);
    }

    const assertionIds = [...new Set(sorted.flatMap((candidate) => candidate.assertionIds))].sort();
    const evidenceIds = [...new Set(sorted.flatMap((candidate) => candidate.evidenceIds))].sort();
    const bindingsByAssertion = new Map<string, ProofBoundRdteAssertionBindingV1>();
    for (const candidate of sorted) {
      for (const binding of candidate.assertionBindings) {
        const existing = bindingsByAssertion.get(binding.assertionId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
          throw new Error(
            `assertion proof binding conflict for project milestone ${binding.assertionId}`,
          );
        }
        bindingsByAssertion.set(binding.assertionId, binding);
      }
    }
    const assertionBindings = [...bindingsByAssertion.values()].sort((left, right) =>
      left.assertionId.localeCompare(right.assertionId),
    );
    const { exclusionReason: _legacyDuplicateConflict, ...withoutExclusion } = first;
    normalized.push({
      ...withoutExclusion,
      candidateId: rdteProjectionCandidateId({
        target: first.target,
        naturalKey: first.naturalKey,
        artifactId: first.artifactId,
      }),
      operation: 'insert',
      reason: 'project-scoped R-4 milestone targets an additive project table',
      assertionIds,
      evidenceIds,
      assertionBindings,
    });
  }

  return normalized.sort(
    (left, right) =>
      left.target.localeCompare(right.target) ||
      left.naturalKey.localeCompare(right.naturalKey) ||
      left.artifactId.localeCompare(right.artifactId),
  );
}

function buildDiffSummary(
  candidates: readonly Pick<ProofBoundRdteProjectionCandidateV1, 'target' | 'operation'>[],
): ProofBoundRdteCanonicalProjectionPlanV1['diffSummary'] {
  return RDTE_PROJECTION_TARGET_V1_VALUES.map((target) => {
    const targetCandidates = candidates.filter((candidate) => candidate.target === target);
    return {
      target,
      insertCount: targetCandidates.filter((candidate) => candidate.operation === 'insert').length,
      updateCount: targetCandidates.filter((candidate) => candidate.operation === 'update').length,
      noOpCount: targetCandidates.filter((candidate) => candidate.operation === 'no_op').length,
      conflictCount: targetCandidates.filter((candidate) => candidate.operation === 'conflict')
        .length,
    };
  }).filter(
    (summary) =>
      summary.insertCount > 0 ||
      summary.updateCount > 0 ||
      summary.noOpCount > 0 ||
      summary.conflictCount > 0,
  );
}

/**
 * The pure mapper emits compatibility IDs. This wrapper is the production
 * boundary: every candidate and every contributing assertion are joined to the
 * exact terminal Phase 2 proof. `acceptedAssertionIds` is used only as a
 * necessary machine-check ledger; Phase 4 still owns projection semantics and
 * this function never treats Phase 2 as canonical-write authority.
 */
export function planProofBoundRdteCanonicalProjection(input: {
  bundle: RdteCycleBundleV1;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}): { plan: ProofBoundRdteCanonicalProjectionPlanV1 } {
  const mapped = planRdteCanonicalProjection({
    bundle: input.bundle,
    artifacts: input.artifacts,
    ...(input.canonicalRows ? { canonicalRows: input.canonicalRows } : {}),
  });
  const verificationByKey = new Map(
    input.bundle.verifications.map((verification) => [
      verification.manifestDocumentKey,
      verification,
    ]),
  );
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const assertionIndex = new Map<
    string,
    { artifact: DefenseBudgetExtractionArtifactV1; assertion: DefenseBudgetAssertionV1 }
  >();
  for (const artifact of input.artifacts) {
    for (const assertion of artifact.assertions) {
      const existing = assertionIndex.get(assertion.assertionId);
      if (existing && existing.artifact.artifactId !== artifact.artifactId) {
        throw new Error(`assertion ${assertion.assertionId} appears in multiple RDT&E artifacts`);
      }
      assertionIndex.set(assertion.assertionId, { artifact, assertion });
    }
  }

  const proofBoundCandidates = mapped.plan.candidates.flatMap((candidate) => {
    const primaryVerification = verificationByKey.get(candidate.sourceDocumentKey);
    if (!primaryVerification) {
      throw new Error(
        `projection candidate ${candidate.candidateId} has no certified verification reference`,
      );
    }
    if (!isTrustedTerminal(primaryVerification)) {
      throw new Error(
        `projection candidate ${candidate.candidateId} is governed by non-terminal verification ` +
          `${primaryVerification.phase2Decision}/${primaryVerification.status}`,
      );
    }
    if (
      candidate.verificationCandidateId !== primaryVerification.candidateId ||
      candidate.verificationRunId !== primaryVerification.verificationRunId ||
      candidate.verificationDecisionId !== primaryVerification.verificationRunId ||
      candidate.artifactId !== primaryVerification.artifactId ||
      candidate.artifactContentSha256 !== primaryVerification.artifactContentSha256 ||
      candidate.sourcePdfSha256 !== primaryVerification.sourcePdfSha256
    ) {
      throw new Error(
        `projection candidate ${candidate.candidateId} is not bound to the certified Phase 2 result`,
      );
    }

    let assertionIds = [...new Set(candidate.assertionIds)].sort();
    let evidenceIds = [...new Set(candidate.evidenceIds)].sort();

    /* ProgramElementSource is synthesized from evidenced assertions. The pure
     * mapper historically emitted an empty ledger; derive the exact source
     * assertions here rather than accepting an unrelated document-level pass. */
    if (assertionIds.length === 0) {
      if (candidate.target !== 'ProgramElementSource') {
        throw new Error(`projection candidate ${candidate.candidateId} has no assertion basis`);
      }
      const artifact = artifactById.get(candidate.artifactId);
      const peCode = candidate.values.peCode;
      if (!artifact || typeof peCode !== 'string' || !peCode.trim()) {
        throw new Error(
          `ProgramElementSource candidate ${candidate.candidateId} cannot resolve its PE evidence basis`,
        );
      }
      const supporting = artifact.assertions.filter(
        (assertion) => peCodeOfAssertion(assertion) === peCode && assertion.evidenceIds.length > 0,
      );
      assertionIds = supporting.map((assertion) => assertion.assertionId).sort();
      evidenceIds = [...new Set(supporting.flatMap((assertion) => assertion.evidenceIds))].sort();
    }

    if (assertionIds.length === 0 || evidenceIds.length === 0) {
      throw new Error(
        `projection candidate ${candidate.candidateId} requires nonempty assertion and evidence ledgers`,
      );
    }

    const assertionBindings: ProofBoundRdteAssertionBindingV1[] = [];
    for (const assertionId of assertionIds) {
      const indexed = assertionIndex.get(assertionId);
      if (!indexed) {
        throw new Error(
          `projection candidate ${candidate.candidateId} references unknown assertion ${assertionId}`,
        );
      }
      const verification = verificationByKey.get(indexed.artifact.source.manifestDocumentKey);
      if (!verification || !isTrustedTerminal(verification)) {
        throw new Error(
          `projection assertion ${assertionId} has no trusted terminal Phase 2 result`,
        );
      }
      if (verification.rejectedAssertionIds.includes(assertionId)) {
        throw new Error(`projection assertion ${assertionId} is rejected by Phase 2`);
      }
      if (!verification.acceptedAssertionIds.includes(assertionId)) {
        throw new Error(
          `projection assertion ${assertionId} did not pass the required Phase 2 checks`,
        );
      }
      if (indexed.assertion.evidenceIds.length === 0) {
        throw new Error(`projection assertion ${assertionId} has no evidence`);
      }
      assertionBindings.push({
        assertionId,
        evidenceIds: [...indexed.assertion.evidenceIds].sort(),
        manifestDocumentKey: verification.manifestDocumentKey,
        artifactId: verification.artifactId,
        artifactContentSha256: verification.artifactContentSha256,
        verificationCandidateId: verification.candidateId,
        verificationRunId: verification.verificationRunId,
        verificationDecision: verification.phase2Decision,
        verificationStatus: verification.status,
        verificationPolicySha256: verification.policySha256,
        sourceDocumentId: verification.sourceDocumentId,
        sourcePdfSha256: verification.sourcePdfSha256,
      });
    }
    assertionBindings.sort((left, right) => left.assertionId.localeCompare(right.assertionId));

    const containsProjectScopedMilestone =
      isMilestoneProjectionTarget(candidate.target) &&
      assertionIds.some((assertionId) =>
        isProjectScopedMilestone(assertionIndex.get(assertionId)?.assertion),
      );
    const assertionGroups = containsProjectScopedMilestone
      ? assertionIds.map((assertionId) => [assertionId])
      : [assertionIds];

    return assertionGroups.map((groupAssertionIds) => {
      const groupBindings = assertionBindings.filter((binding) =>
        groupAssertionIds.includes(binding.assertionId),
      );
      const groupEvidenceIds = [
        ...new Set(groupBindings.flatMap((binding) => binding.evidenceIds)),
      ].sort();
      if (groupBindings.length === 0 || groupEvidenceIds.length === 0) {
        throw new Error(
          `projection candidate ${candidate.candidateId} lost assertion proof during milestone split`,
        );
      }
      const firstAssertion = assertionIndex.get(groupAssertionIds[0]!)?.assertion;
      const normalized = normalizeMilestoneProjection({
        target: candidate.target,
        naturalKey: candidate.naturalKey,
        values: candidate.values,
        assertion: firstAssertion,
      });
      const singleBinding = groupBindings.length === 1 ? groupBindings[0] : undefined;
      const artifactId = singleBinding?.artifactId ?? candidate.artifactId;
      const artifactContentSha256 =
        singleBinding?.artifactContentSha256 ?? candidate.artifactContentSha256;
      const verificationCandidateId =
        singleBinding?.verificationCandidateId ?? primaryVerification.candidateId;
      const verificationRunId =
        singleBinding?.verificationRunId ?? primaryVerification.verificationRunId;
      const sourceDocumentKey = singleBinding?.manifestDocumentKey ?? candidate.sourceDocumentKey;
      const sourcePdfSha256 = singleBinding?.sourcePdfSha256 ?? candidate.sourcePdfSha256;
      const candidateId = rdteProjectionCandidateId({
        target: normalized.target,
        naturalKey: normalized.naturalKey,
        artifactId,
      });

      return {
        ...candidate,
        candidateId,
        target: normalized.target,
        naturalKey: normalized.naturalKey,
        values: normalized.values,
        artifactId,
        artifactContentSha256,
        verificationCandidateId,
        verificationRunId,
        verificationDecisionId: verificationRunId,
        sourceDocumentKey,
        sourcePdfSha256,
        assertionIds: [...groupAssertionIds].sort(),
        evidenceIds: groupEvidenceIds,
        verificationDecision:
          singleBinding?.verificationDecision ?? primaryVerification.phase2Decision,
        verificationStatus: singleBinding?.verificationStatus ?? primaryVerification.status,
        verificationPolicySha256:
          singleBinding?.verificationPolicySha256 ?? primaryVerification.policySha256,
        sourceDocumentId: singleBinding?.sourceDocumentId ?? primaryVerification.sourceDocumentId,
        assertionBindings: groupBindings,
      };
    });
  });
  const candidates = consolidateNormalizedProjectMilestones(proofBoundCandidates);
  const resolvedProjectAssertionIds = new Set(
    candidates
      .filter((candidate) => isProjectMilestoneTarget(candidate.target))
      .flatMap((candidate) => candidate.assertionIds),
  );
  const exclusions = mapped.plan.exclusions.filter(
    (exclusion) =>
      !(
        exclusion.reason === 'duplicate_conflict' &&
        exclusion.assertionId != null &&
        resolvedProjectAssertionIds.has(exclusion.assertionId)
      ),
  );
  const { contentSha256: _oldHash, ...mappedWithoutHash } = mapped.plan;
  const hashInput = {
    ...mappedWithoutHash,
    candidates,
    exclusions,
    diffSummary: buildDiffSummary(candidates),
  };
  const plan = proofBoundRdteCanonicalProjectionPlanV1Schema.parse({
    ...hashInput,
    contentSha256: computeProjectionPlanContentSha256(hashInput),
  });
  return { plan };
}
