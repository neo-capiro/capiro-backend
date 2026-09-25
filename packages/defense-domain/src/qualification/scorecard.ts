/** Deterministic, fail-closed qualification gates for Package 9. */

export type GateStatus = 'PASS' | 'NO_GO';
export type ActivationMode = 'shadow_only' | 'bounded_canary';

export interface ReviewedEvidence {
  reviewed?: boolean | null;
  evidenceRecordId?: string | null;
  reviewerId?: string | null;
  reviewedAt?: string | null;
  releaseRevision?: string | null;
}

export interface SemanticFamilyEvidence {
  family: string;
  candidateTruePositives?: number | null;
  candidateFalseNegatives?: number | null;
  truePositives?: number | null;
  falsePositives?: number | null;
  falseNegatives?: number | null;
  abstentions?: number | null;
}

export interface CoverageFamilyEvidence {
  family: string;
  eligibleUnits?: number | null;
  qualifiedPublishedUnits?: number | null;
  supported?: boolean | null;
}

export interface QualificationEvidence {
  qualificationManifest?: {
    id?: string | null;
    contentHash?: string | null;
    releaseRevision?: string | null;
    approvalRecordId?: string | null;
    approvedBy?: string | null;
    expectedMarketedFamilies?: string[] | null;
    expectedMandatorySourceIds?: string[] | null;
  } | null;
  financialCorrectness?:
    | (ReviewedEvidence & {
        displayedFactCount?: number | null;
        criticalErrorCount?: number | null;
        factsWithCompleteLineage?: number | null;
      })
    | null;
  semanticAccuracy?: (ReviewedEvidence & { families?: SemanticFamilyEvidence[] | null }) | null;
  moneyAttribution?:
    | (ReviewedEvidence & {
        inferredAuthoritativeAllocationCount?: number | null;
        exactAllocatedAmount?: number | null;
        sourceAllocatedAmount?: number | null;
        unexplainedResidualsVisible?: boolean | null;
      })
    | null;
  coverage?:
    | (ReviewedEvidence & {
        denominatorComplete?: boolean | null;
        qualifiedMandatorySourceIds?: string[] | null;
        families?: CoverageFamilyEvidence[] | null;
      })
    | null;
  lifecycle?:
    | (ReviewedEvidence & { requiredScenarios?: number | null; passedScenarios?: number | null })
    | null;
  annualReuse?:
    | (ReviewedEvidence & {
        historicalCycles?: number | null;
        simulatedNextCycle?: boolean | null;
        yearSpecificCodeEdits?: number | null;
        duplicateIdentities?: number | null;
        lostHistoryRecords?: number | null;
      })
    | null;
  reliability?:
    | (ReviewedEvidence & {
        requiredFailureScenarios?: number | null;
        passedFailureScenarios?: number | null;
        lostAcceptedFacts?: number | null;
        duplicateLogicalNotifications?: number | null;
        peakPendingRows?: number | null;
        peakDeadLetterRows?: number | null;
        oldestPendingAgeMinutes?: number | null;
        maxConcurrentDrainTasks?: number | null;
        verifiedProgramUpdateP95Minutes?: number | null;
        commonQueryP95Milliseconds?: number | null;
      })
    | null;
  economics?:
    | (ReviewedEvidence & {
        savingsPercent?: number | null;
        qualityMaintained?: boolean | null;
        coverageMaintained?: boolean | null;
        independentlyAdjudicated?: boolean | null;
        approvedPriceSchedule?: boolean | null;
        adjudicationRecordId?: string | null;
        priceScheduleApprovalRecordId?: string | null;
        economicsRunId?: string | null;
      })
    | null;
  userOutcome?:
    | (ReviewedEvidence & {
        medianTimeReductionPercent?: number | null;
        completionRateMaintained?: boolean | null;
        criticalErrorRateNoHigher?: boolean | null;
        allAssignedTasksIncluded?: boolean | null;
        abstentionsRescuesTimeoutsReported?: boolean | null;
        p95TimeReported?: boolean | null;
        independentlyAdjudicated?: boolean | null;
        assignedWorkflows?: number | null;
        completedWorkflows?: number | null;
        minimumCasesPerWorkflow?: number | null;
        criticalErrors?: number | null;
        adjudicationRecordId?: string | null;
        benchmarkManifestId?: string | null;
      })
    | null;
  ownership?:
    | (ReviewedEvidence & {
        sourceAdapterOwnersComplete?: boolean | null;
        ingestionPublicationOwner?: string | null;
        legislativeDeliveryOwner?: string | null;
        modelEconomicsOwner?: string | null;
        accepted?: boolean | null;
        acceptanceRecordId?: string | null;
      })
    | null;
  rollback?:
    | (ReviewedEvidence & {
        tested?: boolean | null;
        preservesImmutableEvidence?: boolean | null;
        recoveryTargetMinutes?: number | null;
        rehearsalRecordId?: string | null;
      })
    | null;
  costBudgets?:
    | (ReviewedEvidence & {
        incrementalAwsAnnualProjectedUsd?: number | null;
        paidProviderAnnualProjectedUsd?: number | null;
        paidProviderAuthorizedUsd?: number | null;
        paidRunManifestId?: string | null;
      })
    | null;
  activationControls?:
    | (ReviewedEvidence & {
        taskScope?: string | null;
        familyScope?: string | null;
        tenantScope?: string | null;
        frozenQuestionModelPolicy?: boolean | null;
        shadowBeforeCanary?: boolean | null;
        evaluationRunManifestId?: string | null;
        releaseAuthorizationRecordId?: string | null;
      })
    | null;
}

export interface QualificationGate {
  status: GateStatus;
  reasons: string[];
  metrics?: Record<string, number | null>;
}

export type QualificationGateName =
  | 'qualificationManifest'
  | 'financialCorrectness'
  | 'semanticAccuracy'
  | 'moneyAttribution'
  | 'coverage'
  | 'lifecycle'
  | 'annualReuse'
  | 'reliability'
  | 'economics'
  | 'userOutcome'
  | 'ownership'
  | 'rollback'
  | 'costBudgets'
  | 'activationControls';

export interface QualificationScorecard {
  status: GateStatus;
  activation: ActivationMode;
  gates: Record<QualificationGateName, QualificationGate>;
  reasons: string[];
}

const CONFIDENCE_Z = 1.959963984540054;

/** Returns a two-sided 95% Wilson lower bound for a binomial proportion. */
export function wilsonLowerBound(successes: number, trials: number): number | null {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    trials <= 0 ||
    successes < 0 ||
    successes > trials
  )
    return null;
  const p = successes / trials;
  const z2 = CONFIDENCE_Z ** 2;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = CONFIDENCE_Z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

/** Scores only reviewed evidence. Every absent, malformed, or unreviewed value fails closed. */
export function buildQualificationScorecard(
  evidence: QualificationEvidence | null | undefined,
): QualificationScorecard {
  const manifest = evidence?.qualificationManifest;
  const releaseRevision = manifest?.releaseRevision ?? null;
  const gates: QualificationScorecard['gates'] = {
    qualificationManifest: manifestGate(manifest),
    financialCorrectness: gate(
      evidence?.financialCorrectness,
      (value) => {
        const displayed = count(value.displayedFactCount);
        const critical = count(value.criticalErrorCount);
        const lined = count(value.factsWithCompleteLineage);
        if (
          displayed === null ||
          displayed < 1 ||
          critical === null ||
          lined === null ||
          lined > displayed
        )
          return ['financial_counts_missing_or_invalid'];
        const reasons: string[] = [];
        if (critical !== 0) reasons.push('critical_financial_errors_detected');
        if (lined !== displayed) reasons.push('financial_lineage_incomplete');
        return reasons;
      },
      releaseRevision,
    ),
    semanticAccuracy: semanticGate(evidence?.semanticAccuracy, manifest),
    moneyAttribution: gate(
      evidence?.moneyAttribution,
      (value) => {
        const inferred = count(value.inferredAuthoritativeAllocationCount);
        const allocated = finite(value.exactAllocatedAmount);
        const source = finite(value.sourceAllocatedAmount);
        const reasons: string[] = [];
        if (inferred === null || allocated === null || source === null)
          reasons.push('money_attribution_counts_missing_or_invalid');
        else {
          if (inferred !== 0) reasons.push('inferred_authoritative_allocations_detected');
          if (allocated !== source) reasons.push('exact_allocation_reconciliation_failed');
        }
        if (value.unexplainedResidualsVisible !== true)
          reasons.push('unexplained_residuals_not_visible');
        return reasons;
      },
      releaseRevision,
    ),
    coverage: coverageGate(evidence?.coverage, manifest),
    lifecycle: gate(
      evidence?.lifecycle,
      (value) =>
        completeCountGate(value.requiredScenarios, value.passedScenarios, 'lifecycle_scenarios'),
      releaseRevision,
    ),
    annualReuse: gate(
      evidence?.annualReuse,
      (value) => {
        const historical = count(value.historicalCycles);
        const edits = count(value.yearSpecificCodeEdits);
        const duplicates = count(value.duplicateIdentities);
        const lost = count(value.lostHistoryRecords);
        const reasons: string[] = [];
        if (historical === null || historical < 2)
          reasons.push('two_historical_cycles_not_demonstrated');
        if (value.simulatedNextCycle !== true)
          reasons.push('simulated_next_cycle_not_demonstrated');
        if (edits === null || edits !== 0)
          reasons.push('year_specific_code_edits_detected_or_unknown');
        if (duplicates === null || duplicates !== 0)
          reasons.push('duplicate_identities_detected_or_unknown');
        if (lost === null || lost !== 0) reasons.push('prior_history_loss_detected_or_unknown');
        return reasons;
      },
      releaseRevision,
    ),
    reliability: reliabilityGate(evidence?.reliability, releaseRevision),
    economics: gate(
      evidence?.economics,
      (value) => {
        const savings = finite(value.savingsPercent);
        const reasons: string[] = [];
        if (savings === null || savings < 30 || savings > 100)
          reasons.push('jev_savings_below_30_percent_or_invalid');
        if (value.qualityMaintained !== true)
          reasons.push('quality_not_demonstrated_as_maintained');
        if (value.coverageMaintained !== true)
          reasons.push('coverage_not_demonstrated_as_maintained');
        if (value.independentlyAdjudicated !== true)
          reasons.push('economics_not_independently_adjudicated');
        if (value.approvedPriceSchedule !== true) reasons.push('price_schedule_not_approved');
        if (typeof value.adjudicationRecordId !== 'string' || !value.adjudicationRecordId.trim())
          reasons.push('economics_adjudication_record_missing');
        if (
          typeof value.priceScheduleApprovalRecordId !== 'string' ||
          !value.priceScheduleApprovalRecordId.trim()
        )
          reasons.push('price_schedule_approval_record_missing');
        if (typeof value.economicsRunId !== 'string' || !value.economicsRunId.trim())
          reasons.push('economics_run_id_missing');
        return reasons;
      },
      releaseRevision,
    ),
    userOutcome: gate(
      evidence?.userOutcome,
      (value) => {
        const reduction = finite(value.medianTimeReductionPercent);
        const reasons: string[] = [];
        if (reduction === null || reduction < 30 || reduction > 100)
          reasons.push('median_time_reduction_below_30_percent_or_invalid');
        if (value.completionRateMaintained !== true) reasons.push('completion_rate_not_maintained');
        if (value.criticalErrorRateNoHigher !== true)
          reasons.push('critical_error_rate_not_maintained');
        if (value.allAssignedTasksIncluded !== true) reasons.push('assigned_tasks_excluded');
        if (value.abstentionsRescuesTimeoutsReported !== true)
          reasons.push('abstentions_rescues_or_timeouts_not_reported');
        if (value.p95TimeReported !== true) reasons.push('p95_time_not_reported');
        if (value.independentlyAdjudicated !== true)
          reasons.push('buyer_results_not_independently_adjudicated');
        const workflowReasons = completeCountGate(
          value.assignedWorkflows,
          value.completedWorkflows,
          'buyer_workflows',
        );
        reasons.push(...workflowReasons);
        if (count(value.assignedWorkflows) !== 6) reasons.push('six_plan_workflows_not_assigned');
        const minimumCases = count(value.minimumCasesPerWorkflow);
        if (minimumCases === null || minimumCases < 30)
          reasons.push('buyer_cases_per_workflow_below_30_or_unknown');
        const criticalErrors = count(value.criticalErrors);
        if (criticalErrors === null || criticalErrors !== 0)
          reasons.push('buyer_critical_errors_detected_or_unknown');
        if (typeof value.adjudicationRecordId !== 'string' || !value.adjudicationRecordId.trim())
          reasons.push('buyer_adjudication_record_missing');
        if (typeof value.benchmarkManifestId !== 'string' || !value.benchmarkManifestId.trim())
          reasons.push('buyer_benchmark_manifest_missing');
        return reasons;
      },
      releaseRevision,
    ),
    ownership: gate(
      evidence?.ownership,
      (value) => {
        const reasons: string[] = [];
        if (value.sourceAdapterOwnersComplete !== true)
          reasons.push('source_adapter_owners_incomplete');
        for (const [name, owner] of [
          ['ingestion_publication', value.ingestionPublicationOwner],
          ['legislative_delivery', value.legislativeDeliveryOwner],
          ['model_economics', value.modelEconomicsOwner],
        ] as const) {
          if (typeof owner !== 'string' || !owner.trim()) reasons.push(`${name}_owner_missing`);
        }
        if (value.accepted !== true) reasons.push('ownership_not_accepted');
        if (typeof value.acceptanceRecordId !== 'string' || !value.acceptanceRecordId.trim())
          reasons.push('ownership_acceptance_record_missing');
        return reasons;
      },
      releaseRevision,
    ),
    rollback: gate(
      evidence?.rollback,
      (value) => {
        const target = count(value.recoveryTargetMinutes);
        const reasons: string[] = [];
        if (value.tested !== true) reasons.push('rollback_not_tested');
        if (value.preservesImmutableEvidence !== true)
          reasons.push('rollback_immutable_evidence_not_verified');
        if (target === null || target < 1)
          reasons.push('rollback_recovery_target_missing_or_invalid');
        if (typeof value.rehearsalRecordId !== 'string' || !value.rehearsalRecordId.trim())
          reasons.push('rollback_rehearsal_record_missing');
        return reasons;
      },
      releaseRevision,
    ),
    costBudgets: gate(
      evidence?.costBudgets,
      (value) => {
        const aws = finite(value.incrementalAwsAnnualProjectedUsd);
        const provider = finite(value.paidProviderAnnualProjectedUsd);
        const authorized = finite(value.paidProviderAuthorizedUsd);
        const reasons: string[] = [];
        if (aws === null || aws < 0 || aws > 1_000)
          reasons.push('incremental_aws_annual_cost_over_1000_or_unknown');
        if (provider === null || provider < 0 || provider > 500)
          reasons.push('paid_provider_annual_cost_over_500_or_unknown');
        if (authorized === null || authorized < 0 || authorized > 500)
          reasons.push('paid_provider_authorization_over_500_or_unknown');
        if (
          provider !== null &&
          provider > 0 &&
          (authorized === null ||
            authorized <= 0 ||
            typeof value.paidRunManifestId !== 'string' ||
            !value.paidRunManifestId.trim())
        )
          reasons.push('paid_provider_run_not_manifest_authorized');
        return reasons;
      },
      releaseRevision,
    ),
    activationControls: gate(
      evidence?.activationControls,
      (value) => {
        const reasons: string[] = [];
        for (const [name, scope] of [
          ['task', value.taskScope],
          ['family', value.familyScope],
          ['tenant', value.tenantScope],
        ] as const) {
          if (typeof scope !== 'string' || !scope.trim())
            reasons.push(`${name}_activation_scope_missing`);
        }
        if (value.frozenQuestionModelPolicy !== true)
          reasons.push('question_model_policy_not_frozen');
        if (value.shadowBeforeCanary !== true) reasons.push('shadow_before_canary_not_verified');
        if (
          typeof value.evaluationRunManifestId !== 'string' ||
          !value.evaluationRunManifestId.trim()
        )
          reasons.push('evaluation_run_manifest_missing');
        if (
          typeof value.releaseAuthorizationRecordId !== 'string' ||
          !value.releaseAuthorizationRecordId.trim()
        )
          reasons.push('release_authorization_missing');
        return reasons;
      },
      releaseRevision,
    ),
  };
  const reasons = Object.entries(gates).flatMap(([name, result]) =>
    result.reasons.map((reason) => `${name}:${reason}`),
  );
  const status = reasons.length === 0 ? 'PASS' : 'NO_GO';
  return {
    status,
    activation: status === 'PASS' ? 'bounded_canary' : 'shadow_only',
    gates,
    reasons,
  };
}

function manifestGate(manifest: QualificationEvidence['qualificationManifest']): QualificationGate {
  if (!manifest) return noGo('manifest_missing');
  const reasons: string[] = [];
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) reasons.push('manifest_id_missing');
  if (typeof manifest.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.contentHash))
    reasons.push('manifest_hash_missing_or_invalid');
  if (
    typeof manifest.releaseRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.releaseRevision)
  )
    reasons.push('release_revision_missing_or_invalid');
  if (typeof manifest.approvalRecordId !== 'string' || !manifest.approvalRecordId.trim())
    reasons.push('manifest_approval_record_missing');
  if (typeof manifest.approvedBy !== 'string' || !manifest.approvedBy.trim())
    reasons.push('manifest_approver_missing');
  if (!validUniqueStrings(manifest.expectedMarketedFamilies))
    reasons.push('expected_marketed_families_missing_or_invalid');
  if (!validUniqueStrings(manifest.expectedMandatorySourceIds))
    reasons.push('expected_mandatory_sources_missing_or_invalid');
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons };
}

function semanticGate(
  evidence: (ReviewedEvidence & { families?: SemanticFamilyEvidence[] | null }) | null | undefined,
  manifest: QualificationEvidence['qualificationManifest'],
): QualificationGate {
  if (evidence?.reviewed !== true) return noGo(reviewReason(evidence));
  if (!Array.isArray(evidence.families) || evidence.families.length === 0)
    return noGo('semantic_family_results_missing');
  const reasons = reviewBindingReasons(evidence, manifest?.releaseRevision ?? null);
  const metrics: Record<string, number | null> = {};
  const names = new Set<string>();
  for (const family of evidence.families) {
    const name = family.family.trim();
    if (!name || names.has(name)) {
      reasons.push('semantic_family_identity_missing_or_duplicate');
      continue;
    }
    names.add(name);
    const tp = count(family.truePositives);
    const fp = count(family.falsePositives);
    const fn = count(family.falseNegatives);
    const abstentions = count(family.abstentions);
    const candidateTp = count(family.candidateTruePositives);
    const candidateFn = count(family.candidateFalseNegatives);
    if (
      tp === null ||
      fp === null ||
      fn === null ||
      abstentions === null ||
      candidateTp === null ||
      candidateFn === null
    ) {
      reasons.push(`${name}:semantic_sample_counts_missing_or_invalid`);
      continue;
    }
    const candidateRecallN = candidateTp + candidateFn;
    const candidateRecall = candidateRecallN > 0 ? candidateTp / candidateRecallN : null;
    const candidateRecallLower =
      candidateRecall === null ? null : wilsonLowerBound(candidateTp, candidateRecallN);
    const precisionN = tp + fp;
    const recallN = tp + fn + abstentions;
    const precision = precisionN > 0 ? tp / precisionN : null;
    const recall = recallN > 0 ? tp / recallN : null;
    const precisionLower = precision === null ? null : wilsonLowerBound(tp, precisionN);
    const recallLower = recall === null ? null : wilsonLowerBound(tp, recallN);
    metrics[`${name}.samples`] = recallN;
    metrics[`${name}.candidateRecall`] = candidateRecall;
    metrics[`${name}.candidateRecallLower95`] = candidateRecallLower;
    metrics[`${name}.abstentions`] = abstentions;
    metrics[`${name}.precision`] = precision;
    metrics[`${name}.precisionLower95`] = precisionLower;
    metrics[`${name}.recall`] = recall;
    metrics[`${name}.recallLower95`] = recallLower;
    if (precisionLower === null || precisionLower < 0.99)
      reasons.push(`${name}:precision_95_ci_lower_below_99_percent_or_sample_missing`);
    if (recallLower === null || recallLower < 0.95)
      reasons.push(`${name}:recall_95_ci_lower_below_95_percent_or_sample_missing`);
    if (candidateRecallLower === null || candidateRecallLower < 0.95)
      reasons.push(`${name}:candidate_recall_95_ci_lower_below_95_percent_or_sample_missing`);
  }
  if (!sameStringSet(names, manifest?.expectedMarketedFamilies))
    reasons.push('semantic_family_scope_does_not_match_manifest');
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons, metrics };
}

function coverageGate(
  evidence:
    | (ReviewedEvidence & {
        denominatorComplete?: boolean | null;
        qualifiedMandatorySourceIds?: string[] | null;
        families?: CoverageFamilyEvidence[] | null;
      })
    | null
    | undefined,
  manifest: QualificationEvidence['qualificationManifest'],
): QualificationGate {
  if (evidence?.reviewed !== true) return noGo(reviewReason(evidence));
  const reasons = reviewBindingReasons(evidence, manifest?.releaseRevision ?? null);
  if (evidence.denominatorComplete !== true) reasons.push('coverage_denominator_incomplete');
  if (!validUniqueStrings(evidence.qualifiedMandatorySourceIds))
    reasons.push('qualified_mandatory_source_ids_missing_or_invalid');
  else if (
    !sameStringSet(
      new Set(evidence.qualifiedMandatorySourceIds),
      manifest?.expectedMandatorySourceIds,
    )
  )
    reasons.push('mandatory_available_sources_not_all_qualified');
  if (!Array.isArray(evidence.families) || evidence.families.length === 0)
    reasons.push('marketed_family_coverage_missing');
  else {
    const names = new Set<string>();
    for (const family of evidence.families) {
      const name = family.family.trim();
      const eligible = count(family.eligibleUnits);
      const published = count(family.qualifiedPublishedUnits);
      if (!name || names.has(name)) reasons.push('coverage_family_identity_missing_or_duplicate');
      else names.add(name);
      if (family.supported !== true)
        reasons.push(`${name || 'unknown'}:mandatory_family_unsupported`);
      if (eligible === null || eligible < 1 || published === null || published > eligible)
        reasons.push(`${name || 'unknown'}:coverage_counts_missing_or_invalid`);
      else if (published / eligible < 0.95)
        reasons.push(`${name}:qualified_publication_below_95_percent`);
    }
    if (!sameStringSet(names, manifest?.expectedMarketedFamilies))
      reasons.push('coverage_family_scope_does_not_match_manifest');
  }
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons };
}

function reliabilityGate(
  evidence:
    | (ReviewedEvidence & {
        requiredFailureScenarios?: number | null;
        passedFailureScenarios?: number | null;
        lostAcceptedFacts?: number | null;
        duplicateLogicalNotifications?: number | null;
        peakPendingRows?: number | null;
        peakDeadLetterRows?: number | null;
        oldestPendingAgeMinutes?: number | null;
        maxConcurrentDrainTasks?: number | null;
        verifiedProgramUpdateP95Minutes?: number | null;
        commonQueryP95Milliseconds?: number | null;
      })
    | null
    | undefined,
  expectedReleaseRevision: string | null,
): QualificationGate {
  if (evidence?.reviewed !== true) return noGo(reviewReason(evidence));
  const reasons = [
    ...reviewBindingReasons(evidence, expectedReleaseRevision),
    ...completeCountGate(
      evidence.requiredFailureScenarios,
      evidence.passedFailureScenarios,
      'failure_recovery_scenarios',
    ),
  ];
  for (const [name, raw] of [
    ['lost_accepted_facts', evidence.lostAcceptedFacts],
    ['duplicate_logical_notifications', evidence.duplicateLogicalNotifications],
  ] as const) {
    const value = count(raw);
    if (value === null || value !== 0) reasons.push(`${name}_detected_or_unknown`);
  }
  for (const [name, raw, ceiling] of [
    ['peak_pending_rows', evidence.peakPendingRows, 100],
    ['peak_dead_letter_rows', evidence.peakDeadLetterRows, 10],
    ['oldest_pending_age_minutes', evidence.oldestPendingAgeMinutes, 60],
    ['max_concurrent_drain_tasks', evidence.maxConcurrentDrainTasks, 4],
    ['verified_program_update_p95_minutes', evidence.verifiedProgramUpdateP95Minutes, 60],
    ['common_query_p95_milliseconds', evidence.commonQueryP95Milliseconds, 2000],
  ] as const) {
    const value = finite(raw);
    if (value === null || value < 0 || value > ceiling)
      reasons.push(`${name}_over_budget_or_unknown`);
  }
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons };
}

function completeCountGate(requiredRaw: unknown, passedRaw: unknown, label: string): string[] {
  const required = count(requiredRaw);
  const passed = count(passedRaw);
  if (required === null || required < 1 || passed === null || passed > required)
    return [`${label}_counts_missing_or_invalid`];
  return passed === required ? [] : [`${label}_incomplete`];
}

function gate<T extends ReviewedEvidence>(
  evidence: T | null | undefined,
  evaluate: (value: T) => string[],
  expectedReleaseRevision: string | null,
): QualificationGate {
  if (evidence?.reviewed !== true) return noGo(reviewReason(evidence));
  const reasons = [
    ...reviewBindingReasons(evidence, expectedReleaseRevision),
    ...evaluate(evidence),
  ];
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons };
}

function reviewBindingReasons(
  evidence: ReviewedEvidence,
  expectedReleaseRevision: string | null,
): string[] {
  const reasons: string[] = [];
  if (typeof evidence.evidenceRecordId !== 'string' || !evidence.evidenceRecordId.trim())
    reasons.push('evidence_record_id_missing');
  if (typeof evidence.reviewerId !== 'string' || !evidence.reviewerId.trim())
    reasons.push('reviewer_id_missing');
  if (typeof evidence.reviewedAt !== 'string' || !Number.isFinite(Date.parse(evidence.reviewedAt)))
    reasons.push('reviewed_at_missing_or_invalid');
  if (
    typeof evidence.releaseRevision !== 'string' ||
    evidence.releaseRevision !== expectedReleaseRevision
  )
    reasons.push('evidence_release_revision_mismatch');
  return reasons;
}

function validUniqueStrings(values: string[] | null | undefined): values is string[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && value.trim().length > 0) &&
    new Set(values).size === values.length
  );
}

function sameStringSet(actual: Set<string>, expected: string[] | null | undefined): boolean {
  return (
    validUniqueStrings(expected) &&
    actual.size === expected.length &&
    expected.every((value) => actual.has(value))
  );
}

function reviewReason(evidence: ReviewedEvidence | null | undefined): string {
  return evidence == null ? 'evidence_missing' : 'evidence_unreviewed';
}
function noGo(reason: string): QualificationGate {
  return { status: 'NO_GO', reasons: [reason] };
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
