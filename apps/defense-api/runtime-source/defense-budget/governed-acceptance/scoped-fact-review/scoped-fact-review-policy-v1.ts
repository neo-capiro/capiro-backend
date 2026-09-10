/**
 * scoped-fact-review-policy-v1 -- Phase 10B-35.
 *
 * Structured, versioned eligibility policy for approving a SMALL, EXPLICIT set
 * of verified R-2 PE-total assertions for bounded display, without approving
 * the candidate as a whole and without waiving any unresolved monetary
 * evidence elsewhere in the artifact.
 *
 * What this policy is NOT:
 *   - not a candidate-wide acceptance (see `rdte-r1-review-acceptance-eligibility-v1`
 *     and `BudgetReviewV1Service` -- those remain untouched and candidate-wide);
 *   - not a relabelling of NOT_RUN checks as PASS;
 *   - not a message-regex allow-list: every rule below reads structured fields
 *     (assertion kind / rowKind / peCode / fiscalYear / positionCycle / evidence
 *     page / source-fact row) of the hash-verified extraction artifact and of
 *     the persisted checks, discrepancies and proof snapshots.
 *
 * Scope kind v1: `rdte_r2_pe_total_request_fy` -- one program element's FY
 * "Total Program Element" row on its own Exhibit R-2 summary page, in the
 * President's Budget request stage (`positionCycle = pb_fy<FY>`). The approved
 * assertion set is exactly the R-2 `r2_total_component` pe_total assertion
 * (plus the `r2_base_component` pe_total assertion when printed) for that PE
 * and FY, and the PE's own `program_element_identity` assertion anchored on
 * the same physical page.
 *
 * Fail-closed rules (each produces a named `refusalReasons` entry):
 *   candidate-wide gates -- run decision PASS|REVIEW (never REJECT); candidate
 *     status NEEDS_REVIEW|REVIEW_ACCEPTED; zero FAIL+blocking checks; zero
 *     blocking-severity discrepancies; no proof snapshot missing|mismatch;
 *     artifact content hash recomputed == candidate.extractionArtifactSha256;
 *     artifact.source is rdte / r2 / pb / same FY / same component.
 *   scope resolution -- exactly one pe_total total-component assertion for
 *     (peCode, FY); optional base component must equal total when no OCO is
 *     printed; identity assertion for the PE exists with contextSource
 *     explicit_header on the SAME physical page as the total.
 *   independence (source-grounded, not "absent from the discrepancy list") --
 *     (1) no approved assertion id is named by any review/blocking discrepancy
 *     or by any FAIL/NOT_RUN check; (2) every omission / discrepancy that lands
 *     on the same physical page is classified by TABLE ROW: a finding on the
 *     approved row blocks, a finding on another row is recorded as independent
 *     with its row; (3) any assertion on that page whose identity is a
 *     different PE (or whose parent PE differs) is a wrong identity binding on
 *     the approved page and blocks -- this is exactly the defect class the
 *     Phase 10B-34 source-page check found, and it is never waivable.
 *
 * Pure module: no I/O, no Prisma, no clock.
 */
import { createHash } from 'node:crypto';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type {
  ReadCandidateV1,
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadRunV1,
} from '../../verification/persistence/verification-repository.js';

export const SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1 = 'rdte_r2_pe_total_request_fy' as const;
export type ScopedFactReviewScopeKindV1 = typeof SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1;

export const SCOPED_FACT_REVIEW_POLICY_ID_V1 = 'rdte_r2_scoped_pe_total_review_policy_v1';
export const SCOPED_FACT_REVIEW_POLICY_VERSION_V1 = '1.0.0';
/** Content hash of the rule set. Bump the version AND this seed whenever any
 * rule below changes, so a persisted approval always names the exact policy
 * that evaluated it. */
export const SCOPED_FACT_REVIEW_POLICY_SHA256_V1 = createHash('sha256')
  .update(
    [
      SCOPED_FACT_REVIEW_POLICY_ID_V1,
      SCOPED_FACT_REVIEW_POLICY_VERSION_V1,
      'candidate_gates:run_pass_or_review,candidate_needs_review_or_review_accepted,no_fail_blocking_check,no_blocking_discrepancy,no_missing_or_mismatch_proof,artifact_hash_recomputed,source_rdte_r2_pb',
      'scope:single_pe_total_total_component,base_equals_total_without_oco,identity_explicit_header_same_page',
      'independence:no_direct_finding,same_page_findings_by_row,no_wrong_identity_binding_on_page',
    ].join('|'),
  )
  .digest('hex');

/* ------------------------------------------------------------------ */
/* Inputs / outputs                                                    */
/* ------------------------------------------------------------------ */

export interface ScopedFactReviewScopeV1 {
  scopeKind: ScopedFactReviewScopeKindV1;
  peCode: string;
  fiscalYear: number;
  /** Always 'request' for scope kind v1 (President's Budget request stage). */
  fundingField: 'request';
  component: string;
}

export function scopedFactReviewScopeKeyV1(scope: ScopedFactReviewScopeV1): string {
  return `${scope.component}|${scope.peCode}|FY${scope.fiscalYear}|${scope.fundingField}`;
}

export interface ScopedFactReviewEvaluationInputV1 {
  candidate: ReadCandidateV1;
  run: ReadRunV1;
  checks: readonly ReadCheckV1[];
  discrepancies: readonly ReadDiscrepancyV1[];
  proofSnapshots: readonly ReadProofSnapshotV1[];
  artifact: DefenseBudgetExtractionArtifactV1;
  scope: ScopedFactReviewScopeV1;
}

export interface ScopedFactReviewRefusalV1 {
  code:
    | 'run_not_pass_or_review'
    | 'candidate_not_reviewable'
    | 'fail_blocking_check_present'
    | 'blocking_discrepancy_present'
    | 'proof_snapshot_not_verified'
    | 'artifact_hash_mismatch'
    | 'artifact_source_out_of_scope'
    | 'pe_total_not_found'
    | 'ambiguous_duplicate_pe_total'
    | 'base_total_mismatch_without_oco'
    | 'identity_not_anchored_on_page'
    | 'scoped_assertion_named_in_unresolved_finding'
    | 'same_row_finding_on_approved_page'
    | 'wrong_identity_binding_on_approved_page'
    | 'unsupported_scope_kind';
  detail: string;
}

export interface ScopedFactReviewSamePageFindingV1 {
  kind: 'omission' | 'discrepancy' | 'check';
  id: string;
  code: string;
  rowIndex: number | null;
  relation: 'same_row' | 'different_row' | 'row_unknown';
  detail: string;
}

export interface ScopedFactReviewProjectionV1 {
  peCode: string;
  peTitle: string;
  component: string;
  fiscalYear: number;
  stage: 'request';
  stageLabel: string;
  positionCycle: string;
  baseMillions: string | null;
  ocoMillions: string | null;
  totalMillions: string;
  units: 'USD millions';
  source: {
    sourceDocumentId: string;
    sourceSha256: string;
    sourceUrl: string | null;
    documentType: string;
    exhibit: 'R-2';
    physicalPage: number;
    artifactId: string;
    artifactContentSha256: string;
    identityAssertionId: string;
    totalAssertionId: string;
    baseAssertionId: string | null;
    ocoAssertionId: string | null;
    evidenceIds: string[];
    sourceFactPaths: string[];
    evidenceGranularity: string[];
  };
}

export interface ScopedFactReviewIndependenceV1 {
  approvedRow: { physicalPage: number; rowIndex: number | null; tableLabel: string | null };
  directFindings: Array<{ kind: 'check' | 'discrepancy'; id: string; code: string }>;
  samePageFindings: ScopedFactReviewSamePageFindingV1[];
  wrongIdentityAssertionsOnPage: Array<{ assertionId: string; assertionKind: string; identity: string }>;
  candidateWide: {
    runDecision: string;
    candidateStatus: string;
    notRunRequiredChecks: string[];
    reviewDiscrepancyCount: number;
  };
}

export interface ScopedFactReviewEligibilityResultV1 {
  eligible: boolean;
  policy: { id: string; version: string; sha256: string };
  scopeKey: string;
  refusalReasons: ScopedFactReviewRefusalV1[];
  assertionIds: string[];
  evidenceIds: string[];
  projection: ScopedFactReviewProjectionV1 | null;
  independence: ScopedFactReviewIndependenceV1 | null;
  /** Structured limitations the approval MUST carry through to serving. */
  limitations: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type AnyAssertion = Record<string, unknown> & {
  assertionId: string;
  assertionKind: string;
  evidenceIds?: string[];
  sourceFactIds?: string[];
};

interface EvidenceLike {
  evidenceId: string;
  page?: number;
  granularity?: string;
  tableLabel?: string;
  rowLabel?: string;
}

interface SourceFactLike {
  factId: string;
  sourcePath: string;
  rawValue?: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function rowFromSourcePath(sourcePath: string | null | undefined): number | null {
  const m = sourcePath?.match(/(?:^|\/)row:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : null;
}
function pageFromSourcePath(sourcePath: string | null | undefined): number | null {
  const m = sourcePath?.match(/(?:^|\/)page:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : null;
}
function rowFromRowLabel(rowLabel: string | null | undefined): number | null {
  const m = rowLabel?.match(/^row_(\d+)$/);
  return m ? Number(m[1]) : null;
}

function decimalEquals(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return a === b;
  return Math.abs(na - nb) < 1e-9;
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

export function evaluateScopedFactReviewEligibilityV1(
  input: ScopedFactReviewEvaluationInputV1,
): ScopedFactReviewEligibilityResultV1 {
  const { candidate, run, checks, discrepancies, proofSnapshots, artifact, scope } = input;
  const refusals: ScopedFactReviewRefusalV1[] = [];
  const policy = {
    id: SCOPED_FACT_REVIEW_POLICY_ID_V1,
    version: SCOPED_FACT_REVIEW_POLICY_VERSION_V1,
    sha256: SCOPED_FACT_REVIEW_POLICY_SHA256_V1,
  };
  const scopeKey = scopedFactReviewScopeKeyV1(scope);
  const refuse = (code: ScopedFactReviewRefusalV1['code'], detail: string): void => {
    refusals.push({ code, detail });
  };
  const result = (
    partial: Partial<Pick<ScopedFactReviewEligibilityResultV1, 'assertionIds' | 'evidenceIds' | 'projection' | 'independence' | 'limitations'>>,
  ): ScopedFactReviewEligibilityResultV1 => ({
    eligible: refusals.length === 0,
    policy,
    scopeKey,
    refusalReasons: refusals,
    assertionIds: partial.assertionIds ?? [],
    evidenceIds: partial.evidenceIds ?? [],
    projection: partial.projection ?? null,
    independence: partial.independence ?? null,
    limitations: partial.limitations ?? [],
  });

  if (scope.scopeKind !== SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1) {
    refuse('unsupported_scope_kind', `scope kind ${String(scope.scopeKind)} is not governed by ${policy.id}`);
    return result({});
  }

  /* ---------------- candidate-wide gates ---------------- */
  if (run.decision !== 'PASS' && run.decision !== 'REVIEW') {
    refuse('run_not_pass_or_review', `run ${run.id} decision is ${run.decision}`);
  }
  if (run.candidateId !== candidate.id) {
    refuse('candidate_not_reviewable', `run ${run.id} belongs to candidate ${run.candidateId}, not ${candidate.id}`);
  }
  if (candidate.currentRunId != null && candidate.currentRunId !== run.id) {
    refuse('candidate_not_reviewable', `run ${run.id} is not the candidate's current run (${candidate.currentRunId})`);
  }
  if (candidate.status !== 'NEEDS_REVIEW' && candidate.status !== 'REVIEW_ACCEPTED') {
    refuse('candidate_not_reviewable', `candidate ${candidate.id} status is ${candidate.status}`);
  }
  for (const check of checks) {
    if (check.outcome === 'FAIL' && check.blocking) {
      refuse('fail_blocking_check_present', `check ${check.code} is FAIL and blocking: ${check.message}`);
    }
  }
  for (const d of discrepancies) {
    if (d.severity === 'blocking') {
      refuse('blocking_discrepancy_present', `discrepancy ${d.discrepancyId} (${d.code}) is blocking`);
    }
  }
  for (const p of proofSnapshots) {
    if (p.status === 'missing' || p.status === 'mismatch') {
      refuse('proof_snapshot_not_verified', `proof ${p.proofKind} is ${p.status}`);
    }
  }
  const recomputed = computeArtifactContentSha256(artifact);
  if (recomputed !== candidate.extractionArtifactSha256 || artifact.contentSha256 !== recomputed) {
    refuse(
      'artifact_hash_mismatch',
      `recomputed artifact content sha ${recomputed} vs candidate ${candidate.extractionArtifactSha256} / artifact ${artifact.contentSha256}`,
    );
  }
  const source = artifact.source as unknown as Record<string, unknown>;
  if (
    str(source.family) !== 'rdte' ||
    str(source.documentType) !== 'r2' ||
    str(source.budgetCycle) !== 'pb' ||
    num(source.fiscalYear) !== scope.fiscalYear ||
    str(source.component) !== scope.component ||
    str(source.sourcePdfSha256) !== candidate.sourceSha256 ||
    str(source.sourceDocumentId) !== candidate.sourceDocumentId
  ) {
    refuse(
      'artifact_source_out_of_scope',
      `artifact.source family=${String(source.family)} documentType=${String(source.documentType)} budgetCycle=${String(source.budgetCycle)} fy=${String(source.fiscalYear)} component=${String(source.component)} pdf=${String(source.sourcePdfSha256)} doc=${String(source.sourceDocumentId)} does not match scope ${scopeKey} / candidate ${candidate.id}`,
    );
  }

  /* ---------------- scope resolution ---------------- */
  const assertions = artifact.assertions as unknown as AnyAssertion[];
  const evidenceById = new Map<string, EvidenceLike>();
  for (const e of artifact.evidence as unknown as EvidenceLike[]) evidenceById.set(e.evidenceId, e);
  const factsById = new Map<string, SourceFactLike>();
  for (const f of (artifact.sourceFacts ?? []) as unknown as SourceFactLike[]) factsById.set(f.factId, f);
  const pageOf = (a: AnyAssertion): number | null => {
    const meta = a.metadata as Record<string, unknown> | undefined;
    const metaPage = meta ? num(meta.physicalPage) : null;
    if (metaPage != null) return metaPage;
    for (const id of a.evidenceIds ?? []) {
      const p = evidenceById.get(id)?.page;
      if (typeof p === 'number') return p;
    }
    for (const id of a.sourceFactIds ?? []) {
      const p = pageFromSourcePath(factsById.get(id)?.sourcePath);
      if (p != null) return p;
    }
    return null;
  };
  const rowOf = (a: AnyAssertion): number | null => {
    const meta = a.metadata as Record<string, unknown> | undefined;
    const metaRow = meta ? num(meta.rowIndex) : null;
    if (metaRow != null) return metaRow;
    for (const id of a.sourceFactIds ?? []) {
      const r = rowFromSourcePath(factsById.get(id)?.sourcePath);
      if (r != null) return r;
    }
    for (const id of a.evidenceIds ?? []) {
      const r = rowFromRowLabel(evidenceById.get(id)?.rowLabel);
      if (r != null) return r;
    }
    return null;
  };

  const isPeTotalFor = (a: AnyAssertion, fieldName: string): boolean => {
    if (a.assertionKind !== 'document_fact' || a.fieldName !== fieldName) return false;
    const v = a.value as Record<string, unknown> | undefined;
    return (
      v != null &&
      v.rowKind === 'pe_total' &&
      v.peCode === scope.peCode &&
      num(v.fiscalYear) === scope.fiscalYear &&
      v.positionCycle === `pb_fy${scope.fiscalYear}` &&
      typeof v.valueMillions === 'string'
    );
  };
  const totals = assertions.filter((a) => isPeTotalFor(a, 'r2_total_component'));
  const bases = assertions.filter((a) => isPeTotalFor(a, 'r2_base_component'));
  const ocos = assertions.filter((a) => isPeTotalFor(a, 'r2_oco_component'));
  if (totals.length === 0) {
    refuse('pe_total_not_found', `no pe_total r2_total_component assertion for ${scope.peCode} FY${scope.fiscalYear} (pb_fy${scope.fiscalYear})`);
    return result({});
  }
  if (totals.length > 1 || bases.length > 1 || ocos.length > 1) {
    refuse(
      'ambiguous_duplicate_pe_total',
      `expected at most one pe_total per component, found total=${totals.length} base=${bases.length} oco=${ocos.length} for ${scope.peCode} FY${scope.fiscalYear}`,
    );
    return result({});
  }
  const total = totals[0]!;
  const base = bases[0];
  const oco = ocos[0];
  const totalValue = (total.value as Record<string, unknown>).valueMillions as string;
  const baseValue = base ? ((base.value as Record<string, unknown>).valueMillions as string) : null;
  const ocoValue = oco ? ((oco.value as Record<string, unknown>).valueMillions as string) : null;
  if (baseValue != null && ocoValue == null && !decimalEquals(baseValue, totalValue)) {
    refuse('base_total_mismatch_without_oco', `base ${baseValue} != total ${totalValue} while no OCO component is printed`);
  }
  const totalPage = pageOf(total);
  if (totalPage == null) {
    refuse('identity_not_anchored_on_page', `pe_total assertion ${total.assertionId} carries no physical page evidence`);
    return result({});
  }
  for (const other of [base, oco]) {
    if (other && pageOf(other) !== totalPage) {
      refuse('ambiguous_duplicate_pe_total', `component assertion ${other.assertionId} is on page ${String(pageOf(other))}, total is on page ${totalPage}`);
    }
  }
  const identity = assertions.find((a) => {
    if (a.assertionKind !== 'program_element_identity') return false;
    const id = a.identity as Record<string, unknown> | undefined;
    const meta = a.metadata as Record<string, unknown> | undefined;
    return id?.peCode === scope.peCode && meta?.contextSource === 'explicit_header' && pageOf(a) === totalPage;
  });
  if (identity == null) {
    refuse(
      'identity_not_anchored_on_page',
      `no program_element_identity for ${scope.peCode} with contextSource=explicit_header on physical page ${totalPage}`,
    );
    return result({});
  }
  if (str(identity.component) !== scope.component) {
    refuse('artifact_source_out_of_scope', `identity component ${String(identity.component)} != scope component ${scope.component}`);
  }

  const approved: AnyAssertion[] = [identity, total, ...(base ? [base] : []), ...(oco ? [oco] : [])];
  const assertionIds = approved.map((a) => a.assertionId);
  const evidenceIds = [...new Set(approved.flatMap((a) => a.evidenceIds ?? []))];
  const sourceFactPaths = [
    ...new Set(approved.flatMap((a) => (a.sourceFactIds ?? []).map((id) => factsById.get(id)?.sourcePath).filter((p): p is string => typeof p === 'string'))),
  ];
  const approvedRowIndex = rowOf(total);
  const approvedTableLabel = (total.evidenceIds ?? []).map((id) => evidenceById.get(id)?.tableLabel).find((t): t is string => typeof t === 'string') ?? null;

  /* ---------------- independence analysis ---------------- */
  const approvedIdSet = new Set(assertionIds);
  const directFindings: ScopedFactReviewIndependenceV1['directFindings'] = [];
  for (const check of checks) {
    if (check.outcome !== 'FAIL' && check.outcome !== 'NOT_RUN') continue;
    if (check.assertionIds.some((id) => approvedIdSet.has(id))) {
      directFindings.push({ kind: 'check', id: check.checkId, code: check.code });
      refuse('scoped_assertion_named_in_unresolved_finding', `check ${check.code} (${check.outcome}) names an approved assertion`);
    }
  }
  for (const d of discrepancies) {
    if (d.severity !== 'review' && d.severity !== 'blocking') continue;
    if (d.assertionIds.some((id) => approvedIdSet.has(id))) {
      directFindings.push({ kind: 'discrepancy', id: d.discrepancyId, code: d.code });
      refuse('scoped_assertion_named_in_unresolved_finding', `discrepancy ${d.code} (${d.severity}) names an approved assertion`);
    }
  }

  const samePageFindings: ScopedFactReviewSamePageFindingV1[] = [];
  const classifyRow = (rowIndex: number | null): ScopedFactReviewSamePageFindingV1['relation'] => {
    if (rowIndex == null || approvedRowIndex == null) return 'row_unknown';
    return rowIndex === approvedRowIndex ? 'same_row' : 'different_row';
  };
  for (const o of (artifact.omissions ?? []) as unknown as Array<Record<string, unknown>>) {
    const fact = factsById.get(String(o.sourceFactId));
    const page = pageFromSourcePath(fact?.sourcePath);
    if (page !== totalPage) continue;
    const rowIndex = rowFromSourcePath(fact?.sourcePath);
    const relation = classifyRow(rowIndex);
    samePageFindings.push({
      kind: 'omission',
      id: String(o.omissionId),
      code: `${String(o.reason)}:${(String(o.message ?? '').match(/omission: (\w+)/) ?? [])[1] ?? 'unknown'}`,
      rowIndex,
      relation,
      detail: `${String(o.message ?? '')} [${fact?.sourcePath ?? 'no source path'}]`,
    });
    if (relation !== 'different_row') {
      refuse('same_row_finding_on_approved_page', `omission ${String(o.omissionId)} on page ${totalPage} row ${String(rowIndex)} (${relation}) touches the approved PE-total row ${String(approvedRowIndex)}`);
    }
  }
  const assertionById = new Map(assertions.map((a) => [a.assertionId, a]));
  for (const d of discrepancies) {
    if (d.severity !== 'review' && d.severity !== 'blocking') continue;
    const referenced = d.assertionIds.map((id) => assertionById.get(id)).filter((a): a is AnyAssertion => a != null);
    const onPage = referenced.filter((a) => pageOf(a) === totalPage);
    if (onPage.length === 0) continue;
    for (const a of onPage) {
      const rowIndex = rowOf(a);
      const relation = classifyRow(rowIndex);
      samePageFindings.push({
        kind: 'discrepancy',
        id: d.discrepancyId,
        code: d.code,
        rowIndex,
        relation,
        detail: `${d.code} references assertion ${a.assertionId} (${a.assertionKind}) on page ${totalPage} row ${String(rowIndex)}`,
      });
      if (relation !== 'different_row') {
        refuse('same_row_finding_on_approved_page', `discrepancy ${d.code} references page ${totalPage} row ${String(rowIndex)} (${relation}) -- the approved PE-total row is ${String(approvedRowIndex)}`);
      }
    }
  }

  const wrongIdentityAssertionsOnPage: ScopedFactReviewIndependenceV1['wrongIdentityAssertionsOnPage'] = [];
  for (const a of assertions) {
    if (pageOf(a) !== totalPage) continue;
    let identityPe: string | null = null;
    if (a.assertionKind === 'project_funding' || a.assertionKind === 'project') identityPe = str(a.parentPeCode);
    else if (a.assertionKind === 'document_fact') identityPe = str((a.value as Record<string, unknown> | undefined)?.peCode);
    else if (a.assertionKind === 'program_element_identity') identityPe = str((a.identity as Record<string, unknown> | undefined)?.peCode);
    else if (a.assertionKind === 'funding') identityPe = str((a.identity as Record<string, unknown> | undefined)?.peCode) ?? str(a.peCode);
    if (identityPe != null && identityPe !== scope.peCode) {
      const projectCode = str(a.projectCode) ?? str((a.value as Record<string, unknown> | undefined)?.projectCode);
      wrongIdentityAssertionsOnPage.push({
        assertionId: a.assertionId,
        assertionKind: a.assertionKind,
        identity: projectCode ? `${identityPe}/${projectCode}` : identityPe,
      });
    }
  }
  if (wrongIdentityAssertionsOnPage.length > 0) {
    refuse(
      'wrong_identity_binding_on_approved_page',
      `${wrongIdentityAssertionsOnPage.length} assertion(s) on physical page ${totalPage} are bound to a different PE than ${scope.peCode}: ${[...new Set(wrongIdentityAssertionsOnPage.map((w) => w.identity))].join(', ')} -- a known-incorrect identity binding on the approved page is never waivable`,
    );
  }

  const notRunRequiredChecks = checks.filter((c) => c.outcome === 'NOT_RUN' && c.required).map((c) => c.code);
  const independence: ScopedFactReviewIndependenceV1 = {
    approvedRow: { physicalPage: totalPage, rowIndex: approvedRowIndex, tableLabel: approvedTableLabel },
    directFindings,
    samePageFindings,
    wrongIdentityAssertionsOnPage,
    candidateWide: {
      runDecision: run.decision,
      candidateStatus: candidate.status,
      notRunRequiredChecks,
      reviewDiscrepancyCount: discrepancies.filter((d) => d.severity === 'review').length,
    },
  };

  const granularity = [...new Set(evidenceIds.map((id) => evidenceById.get(id)?.granularity).filter((g): g is string => typeof g === 'string'))];
  const limitations = [
    'scope:pe_total_only -- project-level detail for this PE is not verified or approved by this decision',
    'coverage:partial -- this approval covers one program element total from one source document; it is not a complete family, component or fiscal-year collection',
    `evidence:${granularity.length > 0 ? granularity.join('+') : 'unknown'} -- single-source publisher document, no second independent source`,
    ...(candidate.status === 'NEEDS_REVIEW' ? ['candidate:whole_candidate_not_accepted -- the candidate as a whole remains NEEDS_REVIEW; this decision approves only the listed assertion ids'] : []),
    ...(notRunRequiredChecks.length > 0 ? [`checks:not_run -- required checks still NOT_RUN for the candidate: ${notRunRequiredChecks.join(', ')}`] : []),
    ...(samePageFindings.length > 0 ? [`same_page_findings:${samePageFindings.length} -- findings on other rows of physical page ${totalPage} remain unresolved and are not approved`] : []),
  ];

  const projection: ScopedFactReviewProjectionV1 = {
    peCode: scope.peCode,
    peTitle: str(identity.title) ?? '',
    component: scope.component,
    fiscalYear: scope.fiscalYear,
    stage: 'request',
    stageLabel: `FY${scope.fiscalYear} President's Budget request`,
    positionCycle: `pb_fy${scope.fiscalYear}`,
    baseMillions: baseValue,
    ocoMillions: ocoValue,
    totalMillions: totalValue,
    units: 'USD millions',
    source: {
      sourceDocumentId: candidate.sourceDocumentId,
      sourceSha256: candidate.sourceSha256,
      sourceUrl: str(source.sourceUrl),
      documentType: str(source.documentType) ?? 'r2',
      exhibit: 'R-2',
      physicalPage: totalPage,
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.contentSha256,
      identityAssertionId: identity.assertionId,
      totalAssertionId: total.assertionId,
      baseAssertionId: base?.assertionId ?? null,
      ocoAssertionId: oco?.assertionId ?? null,
      evidenceIds,
      sourceFactPaths,
      evidenceGranularity: granularity,
    },
  };

  return result({ assertionIds, evidenceIds, projection, independence, limitations });
}
