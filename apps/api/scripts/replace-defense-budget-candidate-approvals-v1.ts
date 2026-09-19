/**
 * Phase 10B-40 follow-up -- practical baseline for the BA2/BA3
 * approval-replacement gap: bundles, in ONE CLI invocation, the two steps an
 * operator otherwise has to run by hand one at a time (correct, then
 * re-approve N times), with a running ledger and safe, idempotent resume.
 *
 * Uses the same governed services as the single-operation CLIs:
 *   1. `CandidateCorrectionV1Service.correct({commit:true})` -- exactly once,
 *      the SAME call `correct-defense-budget-candidate-v1.ts` makes.
 *   2. `ScopedFactReviewV1Service.review({commit:true})` -- once per manifest
 *      entry, the SAME call `review-defense-budget-scoped-fact-v1.ts` makes,
 *      with candidate/run/evidence identities supplied by the operator-
 *      reviewed manifest, never copied from whatever candidate happens to be
 *      current when the command executes.
 *
 * Why this is NOT one atomic database transaction (investigated, not
 * assumed -- see the PR description for the full writeup):
 *   Both services already give the single most valuable atomicity guarantee
 *   for their OWN operation: `CandidateCorrectionV1Service.correct()`
 *   supersedes every active old-candidate approval AND inserts the
 *   correction link in one Postgres transaction
 *   (`commitCandidateCorrectionAtomicallyV1`), and each
 *   `ScopedFactReviewV1Service.review()` call serializes its scope and
 *   inserts exactly one approval or returns a named conflict. What is NOT
 *   atomic, and cannot cheaply be MADE so, is the span between step 1 and
 *   the last of N step-2 calls: each step-2 call independently reloads and
 *   re-hashes the NEW candidate's extraction artifact from its durable
 *   locator (real S3 GetObject in every deployed environment) BEFORE it can
 *   even evaluate eligibility -- see `ScopedFactReviewV1Service.review()`,
 *   which awaits `this.artifacts.load(...)` ahead of any write. Wrapping
 *   steps 1..N in one outer transaction would require either:
 *     (a) holding a single long-lived Postgres transaction open across N
 *         sequential network round trips to S3 -- real lock-contention,
 *         connection-pool exhaustion and idle-in-transaction risk against a
 *         database serving real production traffic, for a candidate pair
 *         that can have dozens of PEs, or
 *     (b) refactoring both services' persistence layers so every read and
 *         write can run against a caller-supplied transaction handle
 *         threaded through readCandidate/readRun/readChecks/
 *         readDiscrepancies/readProofSnapshots/insertDecision/
 *         commitCorrection -- a real, cross-cutting change to stable,
 *         already-reviewed, correctness-critical code that both carries its
 *         own hard-won historical atomicity fixes (see each service's
 *         top-of-file comment) and that this task's own ground rules ask
 *         NOT to make to the baseline.
 *   Even with (b) built, a mid-transaction crash would still need this same
 *   kind of resumable recovery logic -- just one layer down, and after
 *   discarding strictly MORE already-verified work, since nothing could
 *   have committed yet and every S3 fetch done so far would have to be
 *   redone from zero. Conclusion: accept the narrow, well-understood
 *   interruption window between step 1 and full completion of step 2 (read
 *   surfaces briefly show 0..N-1 of N approvals active on the new candidate
 *   for an internal, staff-facing review screen -- not a money-movement or
 *   externally-served guarantee), and make recovery from it fast, safe and
 *   observable. That is what this script does. Production use therefore
 *   requires either an explicitly approved, bounded maintenance window for
 *   this resumable sequence or a separate staged/atomic-visibility redesign
 *   if a zero-gap display is required. This command does not grant either
 *   approval and does not implement the larger redesign.
 *
 * Ledger, precisely: THE DATABASE IS THE LEDGER. This script keeps no local
 * state file. On every invocation (fresh or a resume) it asks the real
 * `ScopedFactReviewV1Service` (via a dry-run `review()` call) whether the
 * NEW candidate already carries an active APPROVE decision for each
 * manifest entry's scope, and skips exactly those. A lost, stale or
 * corrupted local ledger file can therefore never cause a double-commit
 * (the real service plus the real partial unique index
 * `budget_scoped_fact_review_v1_one_active_per_candidate_scope` still
 * refuse a second active decision for the same candidate/scope) or a
 * missed entry (state is re-read from Postgres on every run, never
 * cached). The stdout ledger below is a live, human-readable progress
 * report, not a source of truth.
 *
 * Idempotent / resumable: re-running with the SAME manifest against a
 * candidate pair that is already partially (or fully) corrected --
 *   - step 1 replays as a no-op (`CandidateCorrectionV1Service`'s own
 *     idempotency: `mode: 'already_recorded'`, zero additional writes);
 *   - step 2 skips every scope that already has an active approval on the
 *     NEW candidate, and attempts only the remainder.
 * A process kill (SIGKILL, crash, host reboot) at ANY point leaves a
 * database state a re-run can resume from without a double-commit or lost
 * audit history. If a human revoked a replacement review meanwhile, ordinary
 * resume stops at that scope; intentional reapproval is a NEW reviewer action
 * with a fresh rationale and exact revoked-row acknowledgement.
 *
 * Usage:
 *   pnpm --filter @capiro/api replace:defense-budget-candidate-approvals-v1 -- \
 *     --old-candidate-id <uuid> --new-candidate-id <uuid> \
 *     --reapproval-manifest <path.json> \
 *     --actor <id> --reviewer-id <id> \
 *     --correction-reason-file <path> \
 *     [--commit]
 *
 * --reapproval-manifest is a versioned JSON envelope:
 *   { "schemaVersion": "defense_budget_approval_replacement_v1",
 *     "oldCandidate": { candidateId, currentRunId, sourceDocumentId,
 *       sourceSha256, extractionArtifactId, extractionArtifactSha256,
 *       manifestContentSha256 },
 *     "newCandidate": { the same exact identity fields },
 *     "entries": [{ peCode, fiscalYear, component, rationale,
 *       expectedTotalMillions, expectedPhysicalPage,
 *       expectedAssertionIds, expectedEvidenceIds }] }
 * Every entry targets scope kind `rdte_r2_pe_total_request_fy`, funding
 * field `request` (the only funding field scope kind v1 supports), decision
 * `approve` -- this script only ever RE-APPROVES a lost decision. A
 * rejection, or any other scope kind, must go through
 * `review-defense-budget-scoped-fact-v1.ts` directly.
 *
 * `expectedTotalMillions` / `expectedPhysicalPage` are the operator's claim
 * of what fact they are re-approving -- the exact PE-total amount and the
 * source page it cites, taken from what they already reviewed on the OLD
 * (lost) approval. This is the "does the manifest actually bind to the fact
 * on the NEW candidate, or did the re-extraction silently change it"
 * safeguard the design calls for. The check runs in TWO passes, both against
 * the real `ScopedFactReviewV1Service.review()` (dry-run, no reimplemented
 * eligibility logic):
 *   1. PRE-FLIGHT (`validateManifestBindingV1`), before step 1 (the
 *      correction) is even attempted: every entry's claim is compared to
 *      `eligibility.projection.totalMillions` /
 *      `eligibility.projection.source.physicalPage` computed fresh from the
 *      NEW candidate's own extraction artifact. ANY mismatch (or a null
 *      projection -- meaning the scope isn't currently eligible at all)
 *      aborts the ENTIRE run before any write, per-PE ledger printed either
 *      way.
 *   2. AT EXECUTION TIME, immediately before each individual commit in step
 *      2's loop, the exact same comparison is repeated (the candidate is
 *      read fresh every time -- this script keeps no cache) and that one
 *      entry is hard-failed (not committed, but the run continues to the
 *      remaining entries) if the claim no longer matches. This is what
 *      "never silently copy an approval onto a changed fact" means
 *      concretely: no code path can commit a scope whose current
 *      amount/citation the operator has not seen and re-affirmed in the
 *      manifest.
 * Assertion and evidence ids ARE part of reviewed intent. Preflight and
 * execution-time eligibility must reproduce those exact sets; matching a
 * numerical total and page alone is insufficient.
 *
 * Exit codes:
 *   0 -- fully done: N of M committed this run or already committed before
 *        it, N === M (or a dry run completed with zero writes), AND the
 *        one-statement reconciliation check (see below) observed every
 *        APPROVED and ALREADY_APPROVED scope active and exactly bound.
 *   1 -- usage error, the pre-flight manifest-binding check found any entry
 *        whose claimed amount/citation does not match the NEW candidate's
 *        current fact (nothing is written in this case -- not even step 1),
 *        or step 1 (the correction link) refused/failed for a reason a
 *        re-run of THIS script cannot fix on its own (e.g. the old candidate
 *        is already corrected by a DIFFERENT new candidate) -- step 2 is
 *        never attempted in this case.
 *   2 -- partial/interrupted: step 1 committed (or was already recorded) but
 *        only 0..N manifest entries were confirmed complete. This includes
 *        ineligibility, a genuine per-entry refusal, an unacknowledged
 *        revocation, or an unexpected runtime failure after correction was
 *        confirmed durable. The complete ledger names every manifest scope;
 *        FAILED means incomplete or unconfirmed, never assumed unwritten.
 *   3 -- RECONCILIATION FAILURE: any scope the ledger counted complete
 *        (APPROVED or ALREADY_APPROVED) was missing, revoked, superseded,
 *        stale-run, corrected-away, or identity-mismatched in the final
 *        authoritative observation, or the final observation itself failed.
 *        The complete ledger is relabeled/names unconfirmed scopes and this
 *        run does NOT claim success.
 *
 * --acknowledge-revoked-scope <scopeKey>=<exact-revoked-review-id>
 * (repeatable): on a re-run, if a
 * manifest entry's scope already shows a REVOKED row in the new candidate's
 * own review history (any status, not just active -- i.e. someone approved
 * this exact scope on this exact candidate before, and a human then revoked
 * it, whether in an earlier run of this script or directly), this script
 * REFUSES to silently recreate that approval -- doing so would erase the
 * revocation's meaning with no acknowledgment it ever happened, using
 * whatever stale rationale happens to be sitting in the manifest file. Pass
 * this flag with the exact latest revoked row printed in the ledger. The
 * id is persisted on the replacement row and bound into its decision hash;
 * a newer revocation makes the acknowledgement stale at the transactional
 * write boundary. Intentional reapproval also requires a fresh rationale.
 *
 * Reconciliation (why this exists, and why it is NOT the same guarantee as
 * step 2's own atomicity): each `ScopedFactReviewV1Service.review({commit:
 * true})` call is itself atomic: its scope/candidate/run/evidence fences,
 * history preconditions, and insert share one transaction. It does not
 * replace a competing active decision; that is a named conflict and the
 * prior decision survives. A SINGLE commit therefore cannot be half-done.
 * But this script
 * makes N such calls in sequence, and nothing stops a human from revoking
 * approval #3 (via the ordinary review UI/CLI, a completely legitimate,
 * unrelated action) while this script is still committing #4..#N, or in the
 * gap between the last commit and this script's own exit. Without
 * reconciliation, the script would print "done" and exit 0 while a human's
 * revocation sits silently overwritten in spirit (the ledger says
 * APPROVED, the database says revoked). Immediately before declaring
 * success, one set-based database statement observes EVERY review the ledger
 * counts complete, including rows skipped as ALREADY_APPROVED. It validates
 * id, candidate, current run, source/artifact/manifest identities, canonical
 * scope JSON, policy tuple, decision, status, reviewer, rationale, decision
 * hash, exact revoked-row acknowledgement, eligibility-state seal,
 * assertion/evidence ids, and projection. The shared database statement
 * timestamp is reported as "observed at"; a human may legitimately revoke a
 * row after that time. This is detection and honest reporting, not rollback
 * -- see NO ROLLBACK below.
 *
 * NO ROLLBACK / NO UNDO: this script has no `--rollback`, `--undo`, or
 * `--revert` flag, and none is planned. Its two underlying writes are each
 * individually forward-only by design (a correction link is permanently
 * append-only, per `CandidateCorrectionRepositoryV1`'s own doc comments; a
 * scoped approval can be revoked but a revocation is itself forward-only
 * audit, never a delete/undo). If a committed correction or approval turns
 * out to be wrong, the remedy is always FORWARD reconstruction, never a
 * reverse operation invented by calling either underlying service backward:
 *   - to undo an individual scoped approval: revoke it directly with
 *     `revoke-defense-budget-scoped-fact-v1.ts`, then (if appropriate)
 *     re-approve the correct fact with `review-defense-budget-scoped-fact-v1.ts`;
 *   - to undo an entire correction link: there is no supported mechanism --
 *     correct the (already-corrected) NEW candidate forward into a further,
 *     THIRD candidate. Do NOT attempt to "correct" the original OLD
 *     candidate's id back onto the NEW one as a `newCandidateId` -- the
 *     correction eligibility check now explicitly refuses exactly that
 *     shape (a candidate that already stands as the OLD side of an existing
 *     link cannot be named as a `new` side of another one; see
 *     `evaluateCandidateCorrectionEligibilityV1`'s
 *     `reverse_correction_of_already_corrected_candidate` refusal code) --
 *     this was previously possible and was a real, undocumented, destructive
 *     "reverse correction" improvisation with no safety check at all.
 * Re-running this script with the same immutable operation intent is the
 * supported idempotent resume path while no completed scope has acquired new
 * revoked history. A revoked scope is deliberately not an automatic resume:
 * intentional reapproval requires a freshly reviewed rationale plus
 * `--acknowledge-revoked-scope <scopeKey>=<exact-row-id>`, and is therefore a
 * new explicit reviewer action rather than literally the same manifest run.
 *
 * Dry-run by default (no --commit): previews step 1's eligibility and, for
 * every manifest entry, previews whether it is already active on the NEW
 * candidate or would be eligible to approve -- ZERO writes.
 */
import * as fs from 'node:fs';
import {
  CandidateCorrectionV1Service,
  CandidateCorrectionError,
} from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-v1.service.js';
import { PrismaCandidateCorrectionRepositoryV1 } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-repository-v1.js';
import {
  computeScopedFactReviewDecisionHashV1,
  scopedFactReviewDecimalValuesEqualV1,
  ScopedFactReviewV1Service,
  ScopedFactReviewError,
  TrustedByteLocatorScopedFactReviewArtifactLoaderV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-v1.service.js';
import {
  SCOPED_FACT_REVIEW_POLICY_ID_V1,
  SCOPED_FACT_REVIEW_POLICY_SHA256_V1,
  SCOPED_FACT_REVIEW_POLICY_VERSION_V1,
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  scopedFactReviewScopeKeyV1,
  type ScopedFactReviewEligibilityResultV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-policy-v1.js';
import {
  sha256CanonicalJson,
  type JsonValue,
} from '../src/defense-budget/contracts/canonical-json.js';
import {
  PrismaScopedFactReviewRepositoryV1,
  type ScopedFactReviewReconciliationExpectationV1,
  type ScopedFactReviewRepositoryV1,
  type ScopedFactReviewRowV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaScopedFactReviewCandidateLocatorReaderV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-prisma-locator-reader-v1.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../src/defense-budget/verification/trusted-proof/trusted-byte-locator-reader.js';
import { SdkS3ProofClient } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

/**
 * Fix (2026-09-19): whether `candidateId` shows a REVOKED row (any status
 * history, not just currently-active) at exactly `scopeKey`. Extracted as
 * its own exported function so it can be proven directly against a real
 * disposable Postgres, independent of the CLI's S3/artifact plumbing --
 * see `phase10b41-hardening.integration.spec.ts`.
 */
export async function findRevokedHistoryForScopeV1(
  reviews: ScopedFactReviewRepositoryV1,
  candidateId: string,
  scopeKey: string,
): Promise<ScopedFactReviewRowV1 | null> {
  const history = await reviews.listByCandidate(candidateId);
  return (
    history
      .filter((r) => r.scopeKey === scopeKey && r.status === 'revoked')
      .sort((a, b) => {
        const generationOrder = BigInt(b.reviewGeneration) - BigInt(a.reviewGeneration);
        return generationOrder === 0n ? b.id.localeCompare(a.id) : generationOrder > 0n ? 1 : -1;
      })[0] ?? null
  );
}

export interface ReconciliationConflictV1 {
  scopeKey: string;
  reviewId: string;
  detail: string;
}

export interface ReconciliationResultV1 {
  observedAt: string;
  conflicts: ReconciliationConflictV1[];
}

/**
 * Observes every approval the manifest ledger counts complete (both newly
 * APPROVED and ALREADY_APPROVED) in one set-based statement, then validates
 * the complete reviewed identity contract against that one database
 * statement timestamp.
 */
export async function reconcileCommittedApprovalsV1(
  reviews: ScopedFactReviewRepositoryV1,
  completedManifestScopes: ScopedFactReviewReconciliationExpectationV1[],
): Promise<ReconciliationResultV1> {
  const snapshot = await reviews.reconcileActiveApprovals(completedManifestScopes);
  const conflicts: ReconciliationConflictV1[] = [];
  for (const expected of completedManifestScopes) {
    const observed = snapshot.observations.find((row) => row.reviewId === expected.reviewId);
    const differences: string[] = [];
    if (observed == null || observed.actualId == null) {
      differences.push('review row missing (unexpected: review rows are append-only)');
    } else {
      const compare = (field: string, actual: unknown, wanted: unknown): void => {
        if (actual !== wanted)
          differences.push(`${field}=${String(actual)} expected ${String(wanted)}`);
      };
      compare('id', observed.actualId, expected.reviewId);
      compare('candidateId', observed.candidateId, expected.candidateId);
      compare('runId', observed.runId, expected.runId);
      compare('candidateCurrentRunId', observed.candidateCurrentRunId, expected.runId);
      if (
        observed.candidateStatus !== 'NEEDS_REVIEW' &&
        observed.candidateStatus !== 'REVIEW_ACCEPTED'
      ) {
        differences.push(
          `candidateStatus=${String(observed.candidateStatus)} expected NEEDS_REVIEW|REVIEW_ACCEPTED`,
        );
      }
      compare(
        'candidateSourceDocumentId',
        observed.candidateSourceDocumentId,
        expected.sourceDocumentId,
      );
      compare('candidateSourceSha256', observed.candidateSourceSha256, expected.sourceSha256);
      compare(
        'candidateExtractionArtifactId',
        observed.candidateExtractionArtifactId,
        expected.extractionArtifactId,
      );
      compare(
        'candidateExtractionArtifactSha256',
        observed.candidateExtractionArtifactSha256,
        expected.extractionArtifactSha256,
      );
      compare(
        'candidateManifestContentSha256',
        observed.candidateManifestContentSha256,
        expected.manifestContentSha256,
      );
      compare('sourceDocumentId', observed.sourceDocumentId, expected.sourceDocumentId);
      compare('sourceSha256', observed.sourceSha256, expected.sourceSha256);
      compare('extractionArtifactId', observed.extractionArtifactId, expected.extractionArtifactId);
      compare(
        'extractionArtifactSha256',
        observed.extractionArtifactSha256,
        expected.extractionArtifactSha256,
      );
      compare(
        'manifestContentSha256',
        observed.manifestContentSha256,
        expected.manifestContentSha256,
      );
      compare('scopeKind', observed.scopeKind, expected.scopeKind);
      compare('scopeKey', observed.scopeKey, expected.scopeKey);
      const observedScopeHash =
        observed.scope == null ? null : sha256CanonicalJson(observed.scope as unknown as JsonValue);
      const expectedScopeHash = sha256CanonicalJson(expected.scope as unknown as JsonValue);
      compare('scopeCanonicalHash', observedScopeHash, expectedScopeHash);
      compare('policyId', observed.policyId, expected.policyId);
      compare('policyVersion', observed.policyVersion, expected.policyVersion);
      compare('policySha256', observed.policySha256, expected.policySha256);
      compare('reviewerId', observed.reviewerId, expected.reviewerId);
      compare('rationale', observed.rationale, expected.rationale);
      compare('decisionHash', observed.decisionHash, expected.decisionHash);
      compare(
        'eligibilityStateVersion',
        observed.eligibilityStateVersion,
        expected.eligibilityStateVersion,
      );
      compare(
        'eligibilityStateSha256',
        observed.eligibilityStateSha256,
        expected.eligibilityStateSha256,
      );
      compare(
        'acknowledgedRevokedReviewId',
        observed.acknowledgedRevokedReviewId,
        expected.acknowledgedRevokedReviewId,
      );
      compare('decision', observed.decision, 'approve');
      compare('status', observed.status, 'active');
      compare('correctedAwayLink', observed.correctionLinkId, null);
      const actualAssertionIds = [...(observed.assertionIds ?? [])].sort();
      const expectedAssertionIds = [...expected.assertionIds].sort();
      if (JSON.stringify(actualAssertionIds) !== JSON.stringify(expectedAssertionIds)) {
        differences.push(
          `assertionIds=${JSON.stringify(actualAssertionIds)} expected ${JSON.stringify(expectedAssertionIds)}`,
        );
      }
      const actualEvidenceIds = [...(observed.evidenceIds ?? [])].sort();
      const expectedEvidenceIds = [...expected.evidenceIds].sort();
      if (JSON.stringify(actualEvidenceIds) !== JSON.stringify(expectedEvidenceIds)) {
        differences.push(
          `evidenceIds=${JSON.stringify(actualEvidenceIds)} expected ${JSON.stringify(expectedEvidenceIds)}`,
        );
      }
      const actualTotal = observed.projection?.totalMillions;
      if (
        actualTotal == null ||
        !Number.isFinite(Number(actualTotal)) ||
        Math.abs(Number(actualTotal) - Number(expected.expectedTotalMillions)) > 1e-9
      ) {
        differences.push(
          `projection.totalMillions=${actualTotal ?? 'null'} expected ${expected.expectedTotalMillions}`,
        );
      }
      compare(
        'projection.source.physicalPage',
        observed.projection?.source.physicalPage ?? null,
        expected.expectedPhysicalPage,
      );
    }
    if (differences.length > 0) {
      conflicts.push({
        scopeKey: expected.scopeKey,
        reviewId: expected.reviewId,
        detail: differences.join('; '),
      });
    }
  }
  return { observedAt: snapshot.observedAt, conflicts };
}

const EXIT_OK = 0;
const EXIT_USAGE_OR_STEP1_ERROR = 1;
const EXIT_PARTIAL = 2;

const KNOWN_FLAGS = new Set([
  '--old-candidate-id',
  '--new-candidate-id',
  '--reapproval-manifest',
  '--actor',
  '--reviewer-id',
  '--correction-reason-file',
  '--commit',
]);

export interface ManifestEntryV1 {
  peCode: string;
  fiscalYear: number;
  component: string;
  rationale: string;
  /** Operator's claim of the PE-total amount being re-approved, e.g. "10.5" (USD millions, matches `ScopedFactReviewProjectionV1.totalMillions`). */
  expectedTotalMillions: string;
  /** Operator's claim of the R-2 physical page the total is cited on (matches `ScopedFactReviewProjectionV1.source.physicalPage`). */
  expectedPhysicalPage: number;
  /** Exact fact/evidence identities the operator reviewed; numeric equality
   * alone is never enough to copy an approval. */
  expectedAssertionIds: string[];
  expectedEvidenceIds: string[];
}

interface ManifestCandidateIdentityV1 {
  candidateId: string;
  currentRunId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
}

interface ReplacementManifestV1 {
  schemaVersion: 'defense_budget_approval_replacement_v1';
  oldCandidate: ManifestCandidateIdentityV1;
  newCandidate: ManifestCandidateIdentityV1;
  entries: ManifestEntryV1[];
}

export type ReplacementLedgerOutcomeV1 =
  'ALREADY_APPROVED' | 'APPROVED' | 'FAILED' | 'RECONCILIATION_CONFLICT';

export interface ReplacementLedgerRowV1 {
  scopeKey: string;
  outcome: ReplacementLedgerOutcomeV1;
  detail: string;
  reviewId?: string;
  expectation?: ScopedFactReviewReconciliationExpectationV1;
}

function manifestEntryScopeKeyV1(entry: ManifestEntryV1): string {
  return scopedFactReviewScopeKeyV1({
    scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
    peCode: entry.peCode,
    fiscalYear: entry.fiscalYear,
    fundingField: 'request',
    component: entry.component,
  });
}

/** Complete an interrupted ledger without pretending an unobserved scope was
 * unwritten. Missing rows are explicitly unconfirmed and must be re-read from
 * Postgres on resume. */
export function completeInterruptedLedgerV1(
  entries: ManifestEntryV1[],
  ledger: ReplacementLedgerRowV1[],
  detail: string,
): void {
  const recorded = new Set(ledger.map((row) => row.scopeKey));
  for (const entry of entries) {
    const scopeKey = manifestEntryScopeKeyV1(entry);
    if (!recorded.has(scopeKey)) {
      ledger.push({ scopeKey, outcome: 'FAILED', detail });
    }
  }
}

interface Args {
  oldCandidateId: string;
  newCandidateId: string;
  manifestPath: string;
  actor: string;
  reviewerId: string;
  correctionReasonFile: string;
  commit: boolean;
  /** Scope keys the operator explicitly confirmed re-approving despite a
   * prior revocation on this exact candidate/scope. See this file's
   * top-of-file doc comment ("--acknowledge-revoked-scope"). */
  acknowledgedRevokedScopes: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | boolean> = {};
  const acknowledgedRevokedScopes = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    if (arg === '--acknowledge-revoked-scope') {
      const value = argv[++i];
      if (!value || !value.includes('=')) {
        console.error('--acknowledge-revoked-scope requires <scopeKey>=<exact-revoked-review-id>');
        process.exit(EXIT_USAGE_OR_STEP1_ERROR);
      }
      const separator = value.lastIndexOf('=');
      const scopeKey = value.slice(0, separator);
      const revokedReviewId = value.slice(separator + 1);
      if (scopeKey.length === 0 || revokedReviewId.length === 0) {
        console.error('--acknowledge-revoked-scope requires <scopeKey>=<exact-revoked-review-id>');
        process.exit(EXIT_USAGE_OR_STEP1_ERROR);
      }
      const prior = acknowledgedRevokedScopes.get(scopeKey);
      if (prior != null && prior !== revokedReviewId) {
        console.error(
          `--acknowledge-revoked-scope supplied conflicting review ids for ${scopeKey}`,
        );
        process.exit(EXIT_USAGE_OR_STEP1_ERROR);
      }
      acknowledgedRevokedScopes.set(scopeKey, revokedReviewId);
      i++;
      continue;
    }
    raw[arg] = arg === '--commit' ? true : (argv[++i] ?? '');
    i++;
  }
  const need = (flag: string): string => {
    const v = raw[flag];
    if (typeof v !== 'string' || v.length === 0) {
      console.error(`Missing ${flag}`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    return v;
  };
  return {
    oldCandidateId: need('--old-candidate-id'),
    newCandidateId: need('--new-candidate-id'),
    manifestPath: need('--reapproval-manifest'),
    actor: need('--actor'),
    reviewerId: need('--reviewer-id'),
    correctionReasonFile: need('--correction-reason-file'),
    commit: raw['--commit'] === true,
  };
}

function loadManifest(path: string): ReplacementManifestV1 {
  if (!fs.existsSync(path)) {
    console.error(`reapproval manifest not found: ${path}`);
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(
      `reapproval manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  const envelope = parsed as Partial<ReplacementManifestV1> | null;
  if (
    envelope == null ||
    typeof envelope !== 'object' ||
    envelope.schemaVersion !== 'defense_budget_approval_replacement_v1' ||
    !Array.isArray(envelope.entries) ||
    envelope.entries.length === 0
  ) {
    console.error(
      'reapproval manifest must be a defense_budget_approval_replacement_v1 envelope with a non-empty entries array',
    );
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  const parseIdentity = (label: string, rawIdentity: unknown): ManifestCandidateIdentityV1 => {
    const identity = rawIdentity as Partial<ManifestCandidateIdentityV1> | null;
    const fields: Array<keyof ManifestCandidateIdentityV1> = [
      'candidateId',
      'currentRunId',
      'sourceDocumentId',
      'sourceSha256',
      'extractionArtifactId',
      'extractionArtifactSha256',
      'manifestContentSha256',
    ];
    if (
      identity == null ||
      typeof identity !== 'object' ||
      fields.some(
        (field) => typeof identity[field] !== 'string' || (identity[field] as string).length === 0,
      )
    ) {
      console.error(`reapproval manifest ${label} must contain non-empty ${fields.join(', ')}`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    return identity as ManifestCandidateIdentityV1;
  };
  const oldCandidate = parseIdentity('oldCandidate', envelope.oldCandidate);
  const newCandidate = parseIdentity('newCandidate', envelope.newCandidate);
  const entries: ManifestEntryV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of envelope.entries.entries()) {
    const e = raw as unknown as Record<string, unknown>;
    const peCode = typeof e.peCode === 'string' ? e.peCode : null;
    const fiscalYear = typeof e.fiscalYear === 'number' ? e.fiscalYear : null;
    const component = typeof e.component === 'string' ? e.component : null;
    const rationale = typeof e.rationale === 'string' ? e.rationale : null;
    const expectedTotalMillions =
      typeof e.expectedTotalMillions === 'string' ? e.expectedTotalMillions : null;
    const expectedPhysicalPage =
      typeof e.expectedPhysicalPage === 'number' ? e.expectedPhysicalPage : null;
    const expectedAssertionIds = Array.isArray(e.expectedAssertionIds)
      ? e.expectedAssertionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : null;
    const expectedEvidenceIds = Array.isArray(e.expectedEvidenceIds)
      ? e.expectedEvidenceIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : null;
    if (
      peCode == null ||
      fiscalYear == null ||
      component == null ||
      rationale == null ||
      rationale.trim().length === 0 ||
      expectedTotalMillions == null ||
      expectedTotalMillions.trim().length === 0 ||
      !Number.isFinite(Number(expectedTotalMillions)) ||
      expectedPhysicalPage == null ||
      !Number.isInteger(expectedPhysicalPage) ||
      expectedPhysicalPage <= 0 ||
      expectedAssertionIds == null ||
      expectedAssertionIds.length === 0 ||
      expectedAssertionIds.length !== (e.expectedAssertionIds as unknown[]).length ||
      new Set(expectedAssertionIds).size !== expectedAssertionIds.length ||
      expectedEvidenceIds == null ||
      expectedEvidenceIds.length === 0 ||
      expectedEvidenceIds.length !== (e.expectedEvidenceIds as unknown[]).length ||
      new Set(expectedEvidenceIds).size !== expectedEvidenceIds.length
    ) {
      console.error(
        `manifest entry [${index}] is malformed (need string peCode/component/rationale, numeric fiscalYear, ` +
          `numeric-string expectedTotalMillions, positive-integer expectedPhysicalPage, and non-empty unique string arrays ` +
          `expectedAssertionIds/expectedEvidenceIds): ${JSON.stringify(raw)}`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const key = `${component}|${peCode}|FY${fiscalYear}`;
    if (seen.has(key)) {
      console.error(
        `manifest entry [${index}] duplicates scope ${key} -- each scope may appear at most once per manifest`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    seen.add(key);
    entries.push({
      peCode,
      fiscalYear,
      component,
      rationale,
      expectedTotalMillions,
      expectedPhysicalPage,
      expectedAssertionIds,
      expectedEvidenceIds,
    });
  }
  return {
    schemaVersion: 'defense_budget_approval_replacement_v1',
    oldCandidate,
    newCandidate,
    entries,
  };
}

/**
 * Compares one manifest entry's claimed fact against what
 * `evaluateScopedFactReviewEligibilityV1` (via a dry-run `review()` call)
 * currently computes from the NEW candidate's own extraction artifact.
 * Returns a human-readable mismatch reason, or `null` if the claim binds.
 * Numeric comparison (not string equality) so "10.50" and "10.5" -- the same
 * Decimal, formatted differently -- are correctly treated as a match; see
 * memory's own "Decimal-as-string" vNext bug class for why naive string
 * comparison here would be a real defect, not a nitpick.
 */
function factBindingMismatchV1(
  entry: ManifestEntryV1,
  eligibility: ScopedFactReviewEligibilityResultV1,
): string | null {
  const projection = eligibility.projection;
  if (projection == null) {
    return 'candidate is not currently eligible for this scope at all (no projection computed) -- cannot confirm the manifest binds to anything';
  }
  if (
    !scopedFactReviewDecimalValuesEqualV1(entry.expectedTotalMillions, projection.totalMillions)
  ) {
    return `expectedTotalMillions ${entry.expectedTotalMillions} != candidate's current totalMillions ${projection.totalMillions}`;
  }
  if (entry.expectedPhysicalPage !== projection.source.physicalPage) {
    return `expectedPhysicalPage ${entry.expectedPhysicalPage} != candidate's current physicalPage ${projection.source.physicalPage}`;
  }
  const expectedAssertionIds = [...entry.expectedAssertionIds].sort();
  const actualAssertionIds = [...eligibility.assertionIds].sort();
  if (JSON.stringify(expectedAssertionIds) !== JSON.stringify(actualAssertionIds)) {
    return `expectedAssertionIds ${JSON.stringify(expectedAssertionIds)} != candidate's current assertionIds ${JSON.stringify(actualAssertionIds)}`;
  }
  const expectedEvidenceIds = [...entry.expectedEvidenceIds].sort();
  const actualEvidenceIds = [...eligibility.evidenceIds].sort();
  if (JSON.stringify(expectedEvidenceIds) !== JSON.stringify(actualEvidenceIds)) {
    return `expectedEvidenceIds ${JSON.stringify(expectedEvidenceIds)} != candidate's current evidenceIds ${JSON.stringify(actualEvidenceIds)}`;
  }
  return null;
}

interface ManifestBindingRowV1 {
  scopeKey: string;
  ok: boolean;
  detail: string;
}

/**
 * PRE-FLIGHT ("validate ... before doing anything"): a pure dry-run pass,
 * through the real unmodified `ScopedFactReviewV1Service.review()`, over
 * every manifest entry against the NEW candidate -- zero writes, and step 1
 * (the correction) has not even been attempted yet at this point. Prints the
 * full per-PE ledger either way so an operator can see exactly what the
 * script intends to do before anything is committed.
 */
async function validateManifestBindingV1(
  reviewService: ScopedFactReviewV1Service,
  entries: ManifestEntryV1[],
  newCandidate: ManifestCandidateIdentityV1,
): Promise<ManifestBindingRowV1[]> {
  const rows: ManifestBindingRowV1[] = [];
  for (const entry of entries) {
    const scope = {
      scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
      peCode: entry.peCode,
      fiscalYear: entry.fiscalYear,
      fundingField: 'request' as const,
      component: entry.component,
    };
    const scopeKey = scopedFactReviewScopeKeyV1(scope);
    let preview;
    try {
      preview = await reviewService.review(
        {
          candidateId: newCandidate.candidateId,
          runId: newCandidate.currentRunId,
          scope,
          decision: 'approve',
          reviewerId: 'preflight-binding-check', // never committed -- dry-run only, this id is never persisted
          rationale: 'preflight manifest-binding check (dry-run only, never committed)',
          expectedSourceSha256: newCandidate.sourceSha256,
          expectedExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
          expectedManifestContentSha256: newCandidate.manifestContentSha256,
          expectedReviewedFact: {
            totalMillions: entry.expectedTotalMillions,
            physicalPage: entry.expectedPhysicalPage,
            assertionIds: entry.expectedAssertionIds,
            evidenceIds: entry.expectedEvidenceIds,
          },
        },
        { commit: false },
      );
    } catch (error) {
      if (!(error instanceof ScopedFactReviewError)) throw error;
      rows.push({
        scopeKey,
        ok: false,
        detail: `scoped review preflight refused: ${error.message} (code: ${error.code})`,
      });
      continue;
    }
    if (!preview.eligibility.eligible) {
      rows.push({
        scopeKey,
        ok: false,
        detail: `candidate is ineligible for approval: ${preview.eligibility.refusalReasons
          .map((reason) => reason.code)
          .join(', ')}`,
      });
      continue;
    }
    const mismatch = factBindingMismatchV1(entry, preview.eligibility);
    if (mismatch != null) {
      rows.push({ scopeKey, ok: false, detail: mismatch });
    } else {
      rows.push({
        scopeKey,
        ok: true,
        detail: `claim confirmed: ${entry.expectedTotalMillions}M on physical page ${entry.expectedPhysicalPage}`,
      });
    }
  }
  return rows;
}

function candidateIdentityMismatchesV1(
  expected: ManifestCandidateIdentityV1,
  observed: {
    id: string;
    currentRunId: string | null;
    sourceDocumentId: string;
    sourceSha256: string;
    extractionArtifactId: string;
    extractionArtifactSha256: string;
    manifestContentSha256: string;
  },
): string[] {
  const differences: string[] = [];
  const compare = (field: string, actual: string | null, wanted: string): void => {
    if (actual !== wanted) differences.push(`${field}=${actual ?? 'null'} expected ${wanted}`);
  };
  compare('candidateId', observed.id, expected.candidateId);
  compare('currentRunId', observed.currentRunId, expected.currentRunId);
  compare('sourceDocumentId', observed.sourceDocumentId, expected.sourceDocumentId);
  compare('sourceSha256', observed.sourceSha256, expected.sourceSha256);
  compare('extractionArtifactId', observed.extractionArtifactId, expected.extractionArtifactId);
  compare(
    'extractionArtifactSha256',
    observed.extractionArtifactSha256,
    expected.extractionArtifactSha256,
  );
  compare('manifestContentSha256', observed.manifestContentSha256, expected.manifestContentSha256);
  return differences;
}

function correctionExpectedIdentityV1(identity: ManifestCandidateIdentityV1) {
  return {
    currentRunId: identity.currentRunId,
    sourceDocumentId: identity.sourceDocumentId,
    sourceSha256: identity.sourceSha256,
    extractionArtifactId: identity.extractionArtifactId,
    extractionArtifactSha256: identity.extractionArtifactSha256,
    manifestContentSha256: identity.manifestContentSha256,
  };
}

function reconciliationExpectationV1(input: {
  manifest: ReplacementManifestV1;
  entry: ManifestEntryV1;
  scopeKey: string;
  reviewId: string;
  reviewerId: string;
  acknowledgedRevokedReviewId: string | null;
  eligibilityStateVersion: string | null;
  eligibilityStateSha256: string | null;
}): ScopedFactReviewReconciliationExpectationV1 {
  const scope = {
    scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
    peCode: input.entry.peCode,
    fiscalYear: input.entry.fiscalYear,
    fundingField: 'request' as const,
    component: input.entry.component,
  };
  const decisionHash = computeScopedFactReviewDecisionHashV1({
    candidateId: input.manifest.newCandidate.candidateId,
    runId: input.manifest.newCandidate.currentRunId,
    sourceSha256: input.manifest.newCandidate.sourceSha256,
    extractionArtifactSha256: input.manifest.newCandidate.extractionArtifactSha256,
    manifestContentSha256: input.manifest.newCandidate.manifestContentSha256,
    policyId: SCOPED_FACT_REVIEW_POLICY_ID_V1,
    policyVersion: SCOPED_FACT_REVIEW_POLICY_VERSION_V1,
    policySha256: SCOPED_FACT_REVIEW_POLICY_SHA256_V1,
    scopeKind: scope.scopeKind,
    scopeKey: input.scopeKey,
    assertionIds: input.entry.expectedAssertionIds,
    decision: 'approve',
    reviewerId: input.reviewerId,
    rationale: input.entry.rationale,
    acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId,
    eligibilityStateVersion: input.eligibilityStateVersion,
    eligibilityStateSha256: input.eligibilityStateSha256,
  });
  return {
    reviewId: input.reviewId,
    candidateId: input.manifest.newCandidate.candidateId,
    runId: input.manifest.newCandidate.currentRunId,
    sourceDocumentId: input.manifest.newCandidate.sourceDocumentId,
    sourceSha256: input.manifest.newCandidate.sourceSha256,
    extractionArtifactId: input.manifest.newCandidate.extractionArtifactId,
    extractionArtifactSha256: input.manifest.newCandidate.extractionArtifactSha256,
    manifestContentSha256: input.manifest.newCandidate.manifestContentSha256,
    scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
    scopeKey: input.scopeKey,
    scope,
    policyId: SCOPED_FACT_REVIEW_POLICY_ID_V1,
    policyVersion: SCOPED_FACT_REVIEW_POLICY_VERSION_V1,
    policySha256: SCOPED_FACT_REVIEW_POLICY_SHA256_V1,
    reviewerId: input.reviewerId,
    rationale: input.entry.rationale,
    decisionHash,
    eligibilityStateVersion: input.eligibilityStateVersion,
    eligibilityStateSha256: input.eligibilityStateSha256,
    acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId,
    assertionIds: [...input.entry.expectedAssertionIds],
    evidenceIds: [...input.entry.expectedEvidenceIds],
    expectedTotalMillions: input.entry.expectedTotalMillions,
    expectedPhysicalPage: input.entry.expectedPhysicalPage,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.manifestPath);
  const entries = manifest.entries;
  const correctionSelectedScopes = entries.map((entry) => {
    const scope = {
      scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
      peCode: entry.peCode,
      fiscalYear: entry.fiscalYear,
      fundingField: 'request' as const,
      component: entry.component,
    };
    return {
      scopeKind: scope.scopeKind,
      scopeKey: scopedFactReviewScopeKeyV1(scope),
      scope,
      expectedTotalMillions: entry.expectedTotalMillions,
      expectedPhysicalPage: entry.expectedPhysicalPage,
      expectedAssertionIds: [...entry.expectedAssertionIds],
      expectedEvidenceIds: [...entry.expectedEvidenceIds],
    };
  });
  if (
    manifest.oldCandidate.candidateId !== args.oldCandidateId ||
    manifest.newCandidate.candidateId !== args.newCandidateId
  ) {
    console.error(
      `candidate arguments do not match reviewed manifest intent: CLI old/new=${args.oldCandidateId}/${args.newCandidateId}, ` +
        `manifest old/new=${manifest.oldCandidate.candidateId}/${manifest.newCandidate.candidateId}`,
    );
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  if (!fs.existsSync(args.correctionReasonFile)) {
    console.error(`correction reason file not found: ${args.correctionReasonFile}`);
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  const correctionReason = fs.readFileSync(args.correctionReasonFile, 'utf8');

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const s3ProofClient = new SdkS3ProofClient();
  try {
    await prisma.$connect();

    const { createPrismaBudgetVerificationRepository } =
      await import('../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js');
    const verification = createPrismaBudgetVerificationRepository(prisma);
    const corrections = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
    const correctionService = new CandidateCorrectionV1Service(verification, corrections);

    const byteReader = new CompositeByteLocatorReader(
      new FilesystemByteLocatorReader(),
      new S3ByteLocatorReader(s3ProofClient),
    );
    const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    const locators = new PrismaScopedFactReviewCandidateLocatorReaderV1(prisma);
    const artifacts = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(byteReader);
    const reviewService = new ScopedFactReviewV1Service(verification, locators, artifacts, reviews);

    /* ---------------- Step 0: pre-flight manifest-binding validation (BEFORE step 1, zero writes) ---------------- */
    const [oldCandidateForPreflight, newCandidateForPreflight] = await Promise.all([
      verification.readCandidate(args.oldCandidateId),
      verification.readCandidate(args.newCandidateId),
    ]);
    if (oldCandidateForPreflight == null || newCandidateForPreflight == null) {
      console.error(
        `reviewed candidate intent cannot be loaded (old=${oldCandidateForPreflight == null ? 'missing' : 'present'}, ` +
          `new=${newCandidateForPreflight == null ? 'missing' : 'present'})`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const identityMismatches = [
      ...candidateIdentityMismatchesV1(manifest.oldCandidate, oldCandidateForPreflight).map(
        (detail) => `oldCandidate.${detail}`,
      ),
      ...candidateIdentityMismatchesV1(manifest.newCandidate, newCandidateForPreflight).map(
        (detail) => `newCandidate.${detail}`,
      ),
    ];
    if (identityMismatches.length > 0) {
      console.error(
        `reviewed candidate/run/evidence intent is stale; step 1 was NOT attempted:\n  ${identityMismatches.join('\n  ')}`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const bindingRows = await validateManifestBindingV1(
      reviewService,
      entries,
      manifest.newCandidate,
    );
    console.error(
      '\n--- pre-flight manifest-binding ledger (what this script intends to do; zero writes so far) ---',
    );
    for (const row of bindingRows)
      console.error(`${row.ok ? 'BOUND   ' : 'MISMATCH'}  ${row.scopeKey}  ${row.detail}`);
    const unbound = bindingRows.filter((r) => !r.ok);
    if (unbound.length > 0) {
      console.error(
        `\nRefusing to proceed: ${unbound.length} of ${bindingRows.length} manifest entries do not bind to the new candidate's ` +
          `current facts (see MISMATCH lines above). Step 1 (the correction) was NOT attempted. Fix the manifest to match the ` +
          `new candidate's real current amounts/citations, or drop the affected entries, then re-run.`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    console.error(
      `All ${bindingRows.length} manifest entries are bound to the new candidate's current facts.\n`,
    );

    /* ---------------- Step 1: correction link (dry-run preview always printed) ---------------- */
    const correctionPreview = await correctionService.correct(
      {
        oldCandidateId: args.oldCandidateId,
        newCandidateId: args.newCandidateId,
        actor: args.actor,
        reason: correctionReason,
        expectedOldCandidateIdentity: correctionExpectedIdentityV1(manifest.oldCandidate),
        expectedNewCandidateIdentity: correctionExpectedIdentityV1(manifest.newCandidate),
        selectedScopes: correctionSelectedScopes,
      },
      { commit: false },
    );
    console.log(
      JSON.stringify({ step: 'correction', mode: 'dry-run', preview: correctionPreview }, null, 2),
    );

    if (!args.commit) {
      console.error(
        `\nDry-run complete for ${entries.length} manifest entr${entries.length === 1 ? 'y' : 'ies'} -- no writes performed. Pass --commit to execute.`,
      );
      for (const entry of entries) {
        const scope = {
          scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
          peCode: entry.peCode,
          fiscalYear: entry.fiscalYear,
          fundingField: 'request' as const,
          component: entry.component,
        };
        console.error(`  [dry-run] ${scopedFactReviewScopeKeyV1(scope)}`);
      }
      process.exit(EXIT_OK);
    }

    /* ---------------- Step 1: commit ---------------- */
    let correctionLinkId: string;
    try {
      const correctionResult = await correctionService.correct(
        {
          oldCandidateId: args.oldCandidateId,
          newCandidateId: args.newCandidateId,
          actor: args.actor,
          reason: correctionReason,
          expectedOldCandidateIdentity: correctionExpectedIdentityV1(manifest.oldCandidate),
          expectedNewCandidateIdentity: correctionExpectedIdentityV1(manifest.newCandidate),
          selectedScopes: correctionSelectedScopes,
        },
        { commit: true },
      );
      correctionLinkId = correctionResult.persisted!.id;
      console.error(
        `Step 1 (correction): ${correctionResult.mode} -- link ${correctionLinkId}, ${correctionResult.supersededScopedFactReviewIds.length} prior scoped approval(s) superseded.`,
      );
    } catch (err) {
      if (err instanceof CandidateCorrectionError) {
        console.error(
          `Step 1 (correction) refused -- step 2 was NOT attempted: ${err.message} (code: ${err.code})`,
        );
        if (err.existingLink)
          console.error(`Existing link: ${JSON.stringify(err.existingLink, null, 2)}`);
        process.exit(EXIT_USAGE_OR_STEP1_ERROR);
      }
      throw err;
    }

    const ledger: ReplacementLedgerRowV1[] = [];
    const printLedgerSummary = (): void => {
      console.log('\n--- ledger summary ---');
      for (const row of ledger)
        console.log(`${row.outcome.padEnd(24)} ${row.scopeKey}  ${row.detail}`);
    };
    const exitPartialAfterCorrection = (headline: string, unconfirmedDetail: string): never => {
      completeInterruptedLedgerV1(entries, ledger, unconfirmedDetail);
      printLedgerSummary();
      const confirmed = ledger.filter(
        (row) => row.outcome === 'ALREADY_APPROVED' || row.outcome === 'APPROVED',
      ).length;
      console.error(
        `\n${headline}\nCorrection ${correctionLinkId} remains durable and append-only; ${confirmed} of ${entries.length} ` +
          'manifest scopes are confirmed complete in this process ledger. FAILED scopes are incomplete or unconfirmed; ' +
          'rerun the exact reviewed intent to rebuild state from Postgres.',
      );
      process.exit(EXIT_PARTIAL);
    };

    /* ---------------- Step 2: replacement approvals, one real service call per manifest entry ---------------- */
    // Re-read rather than trust the pre-flight snapshot: step 1 just committed a
    // real write, and this is a shared production database another process
    // could also be touching -- never assume nothing changed since pre-flight.
    let newCandidate: Awaited<ReturnType<typeof verification.readCandidate>> = null;
    try {
      newCandidate = await verification.readCandidate(args.newCandidateId);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      exitPartialAfterCorrection(
        `Unexpected post-correction candidate re-read interruption after correction ${correctionLinkId}: ${detail}`,
        `POST_CORRECTION_READ_UNCONFIRMED: this scope was not attempted because the replacement candidate could not be re-read (${detail})`,
      );
    }
    const postCorrectionCandidate =
      newCandidate ??
      exitPartialAfterCorrection(
        `new candidate ${args.newCandidateId} not found after correction committed -- cannot proceed to step 2`,
        'POST_CORRECTION_ABORT_NOT_ATTEMPTED: replacement candidate was missing after the correction committed',
      );
    const postCorrectionIdentityMismatches = candidateIdentityMismatchesV1(
      manifest.newCandidate,
      postCorrectionCandidate,
    );
    if (postCorrectionIdentityMismatches.length > 0) {
      exitPartialAfterCorrection(
        `new candidate identity changed after correction ${correctionLinkId}; no replacement approvals were attempted:\n  ` +
          postCorrectionIdentityMismatches.join('\n  '),
        `POST_CORRECTION_ABORT_NOT_ATTEMPTED: replacement identity changed (${postCorrectionIdentityMismatches.join('; ')})`,
      );
    }

    try {
      for (const entry of entries) {
        const scope = {
          scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
          peCode: entry.peCode,
          fiscalYear: entry.fiscalYear,
          fundingField: 'request' as const,
          component: entry.component,
        };
        const scopeKey = scopedFactReviewScopeKeyV1(scope);
        const reviewInput = {
          candidateId: args.newCandidateId,
          runId: manifest.newCandidate.currentRunId,
          scope,
          decision: 'approve' as const,
          reviewerId: args.reviewerId,
          rationale: entry.rationale,
          expectedSourceSha256: manifest.newCandidate.sourceSha256,
          expectedExtractionArtifactSha256: manifest.newCandidate.extractionArtifactSha256,
          expectedManifestContentSha256: manifest.newCandidate.manifestContentSha256,
          acknowledgedRevokedReviewId: args.acknowledgedRevokedScopes.get(scopeKey) ?? null,
          expectedReviewedFact: {
            totalMillions: entry.expectedTotalMillions,
            physicalPage: entry.expectedPhysicalPage,
            assertionIds: entry.expectedAssertionIds,
            evidenceIds: entry.expectedEvidenceIds,
          },
        };

        // THE DATABASE IS THE LEDGER: ask the real service, fresh, every time
        // -- never a locally cached "did I already do this" file.
        let preview;
        try {
          preview = await reviewService.review(reviewInput, { commit: false });
        } catch (err) {
          if (err instanceof ScopedFactReviewError) {
            const detail = `EXECUTION_PREVIEW_REFUSED: ${err.message} (code: ${err.code})`;
            ledger.push({ scopeKey, outcome: 'FAILED', detail });
            console.log(`FAILED  ${scopeKey}  ${detail}`);
            continue;
          }
          throw err;
        }
        const alreadyActive = preview.existingActiveDecisionsForScope.find(
          (d) => d.candidateId === args.newCandidateId && d.decision === 'approve',
        );
        if (alreadyActive != null) {
          const alreadyRow = await reviews.readById(alreadyActive.id);
          if (alreadyRow == null) {
            ledger.push({
              scopeKey,
              outcome: 'FAILED',
              detail: `ALREADY_APPROVED_RACE: review ${alreadyActive.id} disappeared before its identity could be recorded`,
            });
            console.log(`FAILED  ${scopeKey}  ALREADY_APPROVED_RACE: review=${alreadyActive.id}`);
            continue;
          }
          ledger.push({
            scopeKey,
            outcome: 'ALREADY_APPROVED',
            detail: `review ${alreadyActive.id} (from an earlier run; reviewer ${alreadyRow.reviewerId})`,
            reviewId: alreadyActive.id,
            expectation: reconciliationExpectationV1({
              manifest,
              entry,
              scopeKey,
              reviewId: alreadyActive.id,
              reviewerId: args.reviewerId,
              acknowledgedRevokedReviewId: args.acknowledgedRevokedScopes.get(scopeKey) ?? null,
              eligibilityStateVersion:
                alreadyRow.eligibilityStateVersion == null ? null : preview.eligibilityStateVersion,
              eligibilityStateSha256:
                alreadyRow.eligibilityStateVersion == null ? null : preview.eligibilityStateSha256,
            }),
          });
          console.log(`ALREADY_APPROVED  ${scopeKey}  review=${alreadyActive.id}`);
          continue;
        }

        // Concurrent-revocation guard (fix, 2026-09-19): no active decision
        // exists for this scope on the new candidate right now, but that can
        // ALSO be true because one existed and a human explicitly revoked it
        // -- not only because nothing was ever recorded. Silently proceeding
        // to re-approve would erase that revocation's meaning using whatever
        // stale rationale happens to be sitting in this run's manifest file,
        // with no acknowledgment a human ever touched it. Check this exact
        // candidate's own review history (every status, not just active) for
        // a REVOKED row at this scope key before committing a "fresh" entry.
        const revokedHistory = await findRevokedHistoryForScopeV1(
          reviews,
          args.newCandidateId,
          scopeKey,
        );
        const acknowledgedRevokedReviewId = args.acknowledgedRevokedScopes.get(scopeKey) ?? null;
        if (revokedHistory != null && acknowledgedRevokedReviewId == null) {
          const detail =
            `REFUSED_UNACKNOWLEDGED_REVOCATION: review ${revokedHistory.id} for this scope was revoked by ` +
            `${revokedHistory.revokedBy ?? 'unknown'} at ${revokedHistory.revokedAt ?? 'unknown time'} ` +
            `(reason: ${revokedHistory.revocationReason ?? 'none recorded'}); pass ` +
            `--acknowledge-revoked-scope ${scopeKey}=${revokedHistory.id} with a fresh rationale to intentionally re-approve it`;
          ledger.push({ scopeKey, outcome: 'FAILED', detail });
          console.log(`FAILED  ${scopeKey}  ${detail}`);
          continue;
        }
        if (revokedHistory == null && acknowledgedRevokedReviewId != null) {
          const detail = `REFUSED_STALE_REVOCATION_ACK: acknowledged review ${acknowledgedRevokedReviewId}, but no revoked generation currently exists for this candidate/scope`;
          ledger.push({ scopeKey, outcome: 'FAILED', detail });
          console.log(`FAILED  ${scopeKey}  ${detail}`);
          continue;
        }
        if (revokedHistory != null && acknowledgedRevokedReviewId !== revokedHistory.id) {
          const detail = `REFUSED_STALE_REVOCATION_ACK: acknowledged review ${acknowledgedRevokedReviewId}, but latest revoked review is ${revokedHistory.id}`;
          ledger.push({ scopeKey, outcome: 'FAILED', detail });
          console.log(`FAILED  ${scopeKey}  ${detail}`);
          continue;
        }

        // AT EXECUTION TIME, immediately before committing: re-check this
        // entry's claimed amount/citation against what the fresh dry-run
        // preview (fetched microseconds ago, above) just computed. Pre-flight
        // already checked this once for every entry before step 1 ran, but
        // nothing prevents the underlying fact from changing between then and
        // now on a live database another process can also write to -- commit
        // is refused, never silently allowed through, if it no longer matches.
        const executionTimeMismatch = factBindingMismatchV1(entry, preview.eligibility);
        if (executionTimeMismatch != null) {
          ledger.push({
            scopeKey,
            outcome: 'FAILED',
            detail: `MANIFEST_FACT_MISMATCH_AT_EXECUTION: ${executionTimeMismatch}`,
          });
          console.log(
            `FAILED  ${scopeKey}  MANIFEST_FACT_MISMATCH_AT_EXECUTION: ${executionTimeMismatch}`,
          );
          continue;
        }

        try {
          const committed = await reviewService.review(reviewInput, { commit: true });
          const persisted = committed.persisted!;
          ledger.push({
            scopeKey,
            outcome: 'APPROVED',
            detail: `review ${persisted.id}`,
            reviewId: persisted.id,
            expectation: reconciliationExpectationV1({
              manifest,
              entry,
              scopeKey,
              reviewId: persisted.id,
              reviewerId: args.reviewerId,
              acknowledgedRevokedReviewId: args.acknowledgedRevokedScopes.get(scopeKey) ?? null,
              eligibilityStateVersion: committed.eligibilityStateVersion,
              eligibilityStateSha256: committed.eligibilityStateSha256,
            }),
          });
          console.log(`APPROVED  ${scopeKey}  review=${persisted.id}`);
        } catch (err) {
          if (err instanceof ScopedFactReviewError) {
            ledger.push({ scopeKey, outcome: 'FAILED', detail: `${err.code}: ${err.message}` });
            console.log(`FAILED  ${scopeKey}  ${err.code}: ${err.message}`);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      exitPartialAfterCorrection(
        `Unexpected step-2 runtime interruption after correction ${correctionLinkId}: ${detail}`,
        `RUNTIME_INTERRUPTION_UNCONFIRMED: this scope was not confirmed before the process stopped (${detail})`,
      );
    }

    /* ---------------- Reconciliation: re-verify real current state before claiming success ---------------- */
    // One set-based database statement observes every scope this ledger will
    // count complete, including ALREADY_APPROVED resume entries. Its single
    // statement_timestamp is an honest observed-at boundary, not a promise
    // that a human cannot revoke a review after this process exits.
    const completedManifestScopes = ledger.flatMap((row) =>
      row.expectation == null ? [] : [row.expectation],
    );
    let reconciliation: ReconciliationResultV1;
    try {
      reconciliation = await reconcileCommittedApprovalsV1(reviews, completedManifestScopes);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const row of ledger) {
        if (row.outcome === 'APPROVED' || row.outcome === 'ALREADY_APPROVED') {
          row.outcome = 'RECONCILIATION_CONFLICT';
          row.detail = `RECONCILIATION_OBSERVATION_FAILED: ${detail}`;
        }
      }
      completeInterruptedLedgerV1(
        entries,
        ledger,
        `RECONCILIATION_OBSERVATION_FAILED: scope state was not authoritatively observed (${detail})`,
      );
      printLedgerSummary();
      console.error(
        `\nRECONCILIATION FAILED: correction ${correctionLinkId} remains durable, but no authoritative final ` +
          `snapshot was obtained. This run does NOT claim success. Re-run the exact reviewed intent. Error: ${detail}`,
      );
      process.exit(EXIT_RECONCILIATION_FAILED);
    }

    if (reconciliation.conflicts.length > 0) {
      for (const conflict of reconciliation.conflicts) {
        const row = ledger.find(
          (entry) => entry.scopeKey === conflict.scopeKey && entry.reviewId === conflict.reviewId,
        );
        if (row != null) {
          row.outcome = 'RECONCILIATION_CONFLICT';
          row.detail = `review ${conflict.reviewId}: ${conflict.detail}`;
        }
      }
      console.error(
        `\n--- RECONCILIATION FAILED at ${reconciliation.observedAt}: a completed manifest scope no longer matched reviewed intent ---`,
      );
      for (const conflict of reconciliation.conflicts) {
        console.error(
          `RECONCILIATION_CONFLICT  ${conflict.scopeKey}  review=${conflict.reviewId}  ${conflict.detail}`,
        );
      }
      printLedgerSummary();
      const reconciledDoneCount = ledger.filter(
        (row) => row.outcome === 'ALREADY_APPROVED' || row.outcome === 'APPROVED',
      ).length;
      console.error(
        `\ncorrection ${correctionLinkId} remains append-only; ${reconciledDoneCount} of ${ledger.length} manifest scopes remain ` +
          `observed complete and ${reconciliation.conflicts.length} of ${completedManifestScopes.length} ` +
          `scope(s) counted complete failed the authoritative observed-at reconciliation. This run does NOT claim success. ` +
          `Named scope keys: [${reconciliation.conflicts.map((r) => r.scopeKey).join(', ')}]. Re-run to resume. A revoked scope requires ` +
          `--acknowledge-revoked-scope <scopeKey>=<exact-revoked-review-id> plus a fresh rationale for intentional reapproval.`,
      );
      process.exit(EXIT_RECONCILIATION_FAILED);
    }

    /* ---------------- Summary ---------------- */
    const doneCount = ledger.filter(
      (l) => l.outcome === 'ALREADY_APPROVED' || l.outcome === 'APPROVED',
    ).length;
    const total = ledger.length;
    const remaining = ledger.filter((l) => l.outcome === 'FAILED').map((l) => l.scopeKey);

    printLedgerSummary();

    if (doneCount === total) {
      console.error(
        `\ncorrection ${correctionLinkId} recorded; ${doneCount} of ${total} manifest scopes were observed active and exactly bound ` +
          `to reviewed candidate/run/evidence intent at ${reconciliation.observedAt}. They may be revoked after that time.`,
      );
      process.exit(EXIT_OK);
    } else {
      console.error(
        `\ncorrection ${correctionLinkId} recorded; ${doneCount} of ${total} manifest scopes were observed active at ` +
          `${reconciliation.observedAt}; scopes [${remaining.join(', ')}] remain incomplete on candidate ${args.newCandidateId}. ` +
          `Active observations may change after ${reconciliation.observedAt}.`,
      );
      process.exit(EXIT_PARTIAL);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await s3ProofClient.destroy().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  });
}
