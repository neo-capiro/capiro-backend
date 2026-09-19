/**
 * Phase 10B-40 follow-up -- practical baseline for the BA2/BA3
 * approval-replacement gap: bundles, in ONE CLI invocation, the two steps an
 * operator otherwise has to run by hand one at a time (correct, then
 * re-approve N times), with a running ledger and safe, idempotent resume.
 *
 * Bundles, unmodified:
 *   1. `CandidateCorrectionV1Service.correct({commit:true})` -- exactly once,
 *      the SAME call `correct-defense-budget-candidate-v1.ts` makes.
 *   2. `ScopedFactReviewV1Service.review({commit:true})` -- once per manifest
 *      entry, the SAME call `review-defense-budget-scoped-fact-v1.ts` makes,
 *      with `--expected-*` hashes derived automatically from the NEW
 *      candidate's own persisted record instead of requiring an operator to
 *      type them by hand for every one of N entries.
 *
 * Why this is NOT one atomic database transaction (investigated, not
 * assumed -- see the PR description for the full writeup):
 *   Both services already give the single most valuable atomicity guarantee
 *   for their OWN operation: `CandidateCorrectionV1Service.correct()`
 *   supersedes every active old-candidate approval AND inserts the
 *   correction link in one Postgres transaction
 *   (`commitCandidateCorrectionAtomicallyV1`), and each
 *   `ScopedFactReviewV1Service.review()` call inserts its new approval AND
 *   supersedes any same-scope competitor in one transaction
 *   (`PrismaScopedFactReviewRepositoryV1.insertDecision`). What is NOT
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
 *   observable. That is what this script does.
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
 * database state a re-run can always resume from, never a double-commit
 * and never a lost approval.
 *
 * Usage:
 *   pnpm --filter @capiro/api replace:defense-budget-candidate-approvals-v1 -- \
 *     --old-candidate-id <uuid> --new-candidate-id <uuid> \
 *     --reapproval-manifest <path.json> \
 *     --actor <id> --reviewer-id <id> \
 *     --correction-reason-file <path> \
 *     [--commit]
 *
 * --reapproval-manifest is a JSON array of entries:
 *   { "peCode": string, "fiscalYear": number, "component": string, "rationale": string,
 *     "expectedTotalMillions": string, "expectedPhysicalPage": number }
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
 * `assertionIds` are deliberately NOT part of the manifest: they are the
 * NEW candidate's own artifact-derived identifiers, computed by
 * `evaluateScopedFactReviewEligibilityV1` and bound into the persisted
 * decision's hash (`computeScopedFactReviewDecisionHashV1`) by the
 * unmodified review service itself -- an operator cannot and should not
 * hand-type them.
 *
 * Exit codes:
 *   0 -- fully done: N of M committed this run or already committed before
 *        it, N === M (or a dry run completed with zero writes).
 *   1 -- usage error, the pre-flight manifest-binding check found any entry
 *        whose claimed amount/citation does not match the NEW candidate's
 *        current fact (nothing is written in this case -- not even step 1),
 *        or step 1 (the correction link) refused/failed for a reason a
 *        re-run of THIS script cannot fix on its own (e.g. the old candidate
 *        is already corrected by a DIFFERENT new candidate) -- step 2 is
 *        never attempted in this case.
 *   2 -- partial: step 1 committed (or was already recorded) but some
 *        manifest entries could not be committed (ineligible, or a genuine
 *        per-entry error) -- the ledger below names exactly which; re-run
 *        after resolving them, or leave the remainder for manual
 *        re-approval on the new candidate.
 *
 * Dry-run by default (no --commit): previews step 1's eligibility and, for
 * every manifest entry, previews whether it is already active on the NEW
 * candidate or would be eligible to approve -- ZERO writes.
 */
import * as fs from 'node:fs';
import { CandidateCorrectionV1Service, CandidateCorrectionError } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-v1.service.js';
import { PrismaCandidateCorrectionRepositoryV1 } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-repository-v1.js';
import {
  ScopedFactReviewV1Service,
  ScopedFactReviewError,
  TrustedByteLocatorScopedFactReviewArtifactLoaderV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-v1.service.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  scopedFactReviewScopeKeyV1,
  type ScopedFactReviewProjectionV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-policy-v1.js';
import { PrismaScopedFactReviewRepositoryV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaScopedFactReviewCandidateLocatorReaderV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-prisma-locator-reader-v1.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../src/defense-budget/verification/trusted-proof/trusted-byte-locator-reader.js';
import { SdkS3ProofClient } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

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

interface ManifestEntryV1 {
  peCode: string;
  fiscalYear: number;
  component: string;
  rationale: string;
  /** Operator's claim of the PE-total amount being re-approved, e.g. "10.5" (USD millions, matches `ScopedFactReviewProjectionV1.totalMillions`). */
  expectedTotalMillions: string;
  /** Operator's claim of the R-2 physical page the total is cited on (matches `ScopedFactReviewProjectionV1.source.physicalPage`). */
  expectedPhysicalPage: number;
}

interface Args {
  oldCandidateId: string;
  newCandidateId: string;
  manifestPath: string;
  actor: string;
  reviewerId: string;
  correctionReasonFile: string;
  commit: boolean;
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
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

function loadManifest(path: string): ManifestEntryV1[] {
  if (!fs.existsSync(path)) {
    console.error(`reapproval manifest not found: ${path}`);
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`reapproval manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('reapproval manifest must be a non-empty JSON array');
    process.exit(EXIT_USAGE_OR_STEP1_ERROR);
  }
  const entries: ManifestEntryV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of parsed.entries()) {
    const e = raw as Record<string, unknown>;
    const peCode = typeof e.peCode === 'string' ? e.peCode : null;
    const fiscalYear = typeof e.fiscalYear === 'number' ? e.fiscalYear : null;
    const component = typeof e.component === 'string' ? e.component : null;
    const rationale = typeof e.rationale === 'string' ? e.rationale : null;
    const expectedTotalMillions = typeof e.expectedTotalMillions === 'string' ? e.expectedTotalMillions : null;
    const expectedPhysicalPage = typeof e.expectedPhysicalPage === 'number' ? e.expectedPhysicalPage : null;
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
      expectedPhysicalPage <= 0
    ) {
      console.error(
        `manifest entry [${index}] is malformed (need string peCode/component/rationale, numeric fiscalYear, ` +
          `numeric-string expectedTotalMillions, positive-integer expectedPhysicalPage): ${JSON.stringify(raw)}`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const key = `${component}|${peCode}|FY${fiscalYear}`;
    if (seen.has(key)) {
      console.error(`manifest entry [${index}] duplicates scope ${key} -- each scope may appear at most once per manifest`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    seen.add(key);
    entries.push({ peCode, fiscalYear, component, rationale, expectedTotalMillions, expectedPhysicalPage });
  }
  return entries;
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
function factBindingMismatchV1(entry: ManifestEntryV1, projection: ScopedFactReviewProjectionV1 | null): string | null {
  if (projection == null) {
    return 'candidate is not currently eligible for this scope at all (no projection computed) -- cannot confirm the manifest binds to anything';
  }
  const claimedAmount = Number(entry.expectedTotalMillions);
  const actualAmount = Number(projection.totalMillions);
  if (!Number.isFinite(claimedAmount) || !Number.isFinite(actualAmount) || Math.abs(claimedAmount - actualAmount) > 1e-9) {
    return `expectedTotalMillions ${entry.expectedTotalMillions} != candidate's current totalMillions ${projection.totalMillions}`;
  }
  if (entry.expectedPhysicalPage !== projection.source.physicalPage) {
    return `expectedPhysicalPage ${entry.expectedPhysicalPage} != candidate's current physicalPage ${projection.source.physicalPage}`;
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
  newCandidateId: string,
  runId: string,
  newCandidateHashes: { sourceSha256: string; extractionArtifactSha256: string; manifestContentSha256: string },
): Promise<ManifestBindingRowV1[]> {
  const rows: ManifestBindingRowV1[] = [];
  for (const entry of entries) {
    const scope = { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: entry.peCode, fiscalYear: entry.fiscalYear, fundingField: 'request' as const, component: entry.component };
    const scopeKey = scopedFactReviewScopeKeyV1(scope);
    const preview = await reviewService.review(
      {
        candidateId: newCandidateId,
        runId,
        scope,
        decision: 'approve',
        reviewerId: 'preflight-binding-check', // never committed -- dry-run only, this id is never persisted
        rationale: 'preflight manifest-binding check (dry-run only, never committed)',
        expectedSourceSha256: newCandidateHashes.sourceSha256,
        expectedExtractionArtifactSha256: newCandidateHashes.extractionArtifactSha256,
        expectedManifestContentSha256: newCandidateHashes.manifestContentSha256,
      },
      { commit: false },
    ).catch(() => {
      // Any thrown ScopedFactReviewError (candidate/run not found, artifact
      // unreadable, hash mismatch, etc.) means "cannot confirm eligibility"
      // for this scope -- treated as a binding failure, not a crash.
      return null;
    });
    if (preview == null) {
      rows.push({ scopeKey, ok: false, detail: 'could not evaluate eligibility for this scope on the new candidate (see error above)' });
      continue;
    }
    const mismatch = factBindingMismatchV1(entry, preview.eligibility.projection);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = loadManifest(args.manifestPath);
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

    const { createPrismaBudgetVerificationRepository } = await import(
      '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js'
    );
    const verification = createPrismaBudgetVerificationRepository(prisma);
    const corrections = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
    const correctionService = new CandidateCorrectionV1Service(verification, corrections);

    const byteReader = new CompositeByteLocatorReader(new FilesystemByteLocatorReader(), new S3ByteLocatorReader(s3ProofClient));
    const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    const locators = new PrismaScopedFactReviewCandidateLocatorReaderV1(prisma);
    const artifacts = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(byteReader);
    const reviewService = new ScopedFactReviewV1Service(verification, locators, artifacts, reviews);

    /* ---------------- Step 0: pre-flight manifest-binding validation (BEFORE step 1, zero writes) ---------------- */
    const newCandidateForPreflight = await verification.readCandidate(args.newCandidateId);
    if (newCandidateForPreflight == null) {
      console.error(`new candidate ${args.newCandidateId} not found -- nothing to bind the manifest to`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    if (newCandidateForPreflight.currentRunId == null) {
      console.error(`new candidate ${args.newCandidateId} has no currentRunId -- cannot evaluate eligibility`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const preflightRunId = newCandidateForPreflight.currentRunId;
    const bindingRows = await validateManifestBindingV1(reviewService, entries, args.newCandidateId, preflightRunId, {
      sourceSha256: newCandidateForPreflight.sourceSha256,
      extractionArtifactSha256: newCandidateForPreflight.extractionArtifactSha256,
      manifestContentSha256: newCandidateForPreflight.manifestContentSha256,
    });
    console.error('\n--- pre-flight manifest-binding ledger (what this script intends to do; zero writes so far) ---');
    for (const row of bindingRows) console.error(`${row.ok ? 'BOUND   ' : 'MISMATCH'}  ${row.scopeKey}  ${row.detail}`);
    const unbound = bindingRows.filter((r) => !r.ok);
    if (unbound.length > 0) {
      console.error(
        `\nRefusing to proceed: ${unbound.length} of ${bindingRows.length} manifest entries do not bind to the new candidate's ` +
          `current facts (see MISMATCH lines above). Step 1 (the correction) was NOT attempted. Fix the manifest to match the ` +
          `new candidate's real current amounts/citations, or drop the affected entries, then re-run.`,
      );
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    console.error(`All ${bindingRows.length} manifest entries are bound to the new candidate's current facts.\n`);

    /* ---------------- Step 1: correction link (dry-run preview always printed) ---------------- */
    const correctionPreview = await correctionService.correct(
      { oldCandidateId: args.oldCandidateId, newCandidateId: args.newCandidateId, actor: args.actor, reason: correctionReason },
      { commit: false },
    );
    console.log(JSON.stringify({ step: 'correction', mode: 'dry-run', preview: correctionPreview }, null, 2));

    if (!args.commit) {
      console.error(`\nDry-run complete for ${entries.length} manifest entr${entries.length === 1 ? 'y' : 'ies'} -- no writes performed. Pass --commit to execute.`);
      for (const entry of entries) {
        const scope = { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: entry.peCode, fiscalYear: entry.fiscalYear, fundingField: 'request' as const, component: entry.component };
        console.error(`  [dry-run] ${scopedFactReviewScopeKeyV1(scope)}`);
      }
      process.exit(EXIT_OK);
    }

    /* ---------------- Step 1: commit ---------------- */
    let correctionLinkId: string;
    try {
      const correctionResult = await correctionService.correct(
        { oldCandidateId: args.oldCandidateId, newCandidateId: args.newCandidateId, actor: args.actor, reason: correctionReason },
        { commit: true },
      );
      correctionLinkId = correctionResult.persisted!.id;
      console.error(`Step 1 (correction): ${correctionResult.mode} -- link ${correctionLinkId}, ${correctionResult.supersededScopedFactReviewIds.length} prior scoped approval(s) superseded.`);
    } catch (err) {
      if (err instanceof CandidateCorrectionError) {
        console.error(`Step 1 (correction) refused -- step 2 was NOT attempted: ${err.message} (code: ${err.code})`);
        if (err.existingLink) console.error(`Existing link: ${JSON.stringify(err.existingLink, null, 2)}`);
        process.exit(EXIT_USAGE_OR_STEP1_ERROR);
      }
      throw err;
    }

    /* ---------------- Step 2: replacement approvals, one real service call per manifest entry ---------------- */
    // Re-read rather than trust the pre-flight snapshot: step 1 just committed a
    // real write, and this is a shared production database another process
    // could also be touching -- never assume nothing changed since pre-flight.
    const newCandidate = await verification.readCandidate(args.newCandidateId);
    if (newCandidate == null) {
      console.error(`new candidate ${args.newCandidateId} not found after correction committed -- cannot proceed to step 2`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    if (newCandidate.currentRunId == null) {
      console.error(`new candidate ${args.newCandidateId} has no currentRunId -- cannot proceed to step 2`);
      process.exit(EXIT_USAGE_OR_STEP1_ERROR);
    }
    const runId = newCandidate.currentRunId;

    type LedgerOutcome = 'ALREADY_APPROVED' | 'APPROVED' | 'FAILED';
    const ledger: Array<{ scopeKey: string; outcome: LedgerOutcome; detail: string }> = [];

    for (const entry of entries) {
      const scope = { scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, peCode: entry.peCode, fiscalYear: entry.fiscalYear, fundingField: 'request' as const, component: entry.component };
      const scopeKey = scopedFactReviewScopeKeyV1(scope);
      const reviewInput = {
        candidateId: args.newCandidateId,
        runId,
        scope,
        decision: 'approve' as const,
        reviewerId: args.reviewerId,
        rationale: entry.rationale,
        expectedSourceSha256: newCandidate.sourceSha256,
        expectedExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
        expectedManifestContentSha256: newCandidate.manifestContentSha256,
      };

      // THE DATABASE IS THE LEDGER: ask the real service, fresh, every time
      // -- never a locally cached "did I already do this" file.
      const preview = await reviewService.review(reviewInput, { commit: false });
      const alreadyActive = preview.existingActiveDecisionsForScope.find((d) => d.candidateId === args.newCandidateId && d.decision === 'approve');
      if (alreadyActive != null) {
        ledger.push({ scopeKey, outcome: 'ALREADY_APPROVED', detail: `review ${alreadyActive.id} (from an earlier run)` });
        console.log(`ALREADY_APPROVED  ${scopeKey}  review=${alreadyActive.id}`);
        continue;
      }

      // AT EXECUTION TIME, immediately before committing: re-check this
      // entry's claimed amount/citation against what the fresh dry-run
      // preview (fetched microseconds ago, above) just computed. Pre-flight
      // already checked this once for every entry before step 1 ran, but
      // nothing prevents the underlying fact from changing between then and
      // now on a live database another process can also write to -- commit
      // is refused, never silently allowed through, if it no longer matches.
      const executionTimeMismatch = factBindingMismatchV1(entry, preview.eligibility.projection);
      if (executionTimeMismatch != null) {
        ledger.push({ scopeKey, outcome: 'FAILED', detail: `MANIFEST_FACT_MISMATCH_AT_EXECUTION: ${executionTimeMismatch}` });
        console.log(`FAILED  ${scopeKey}  MANIFEST_FACT_MISMATCH_AT_EXECUTION: ${executionTimeMismatch}`);
        continue;
      }

      try {
        const committed = await reviewService.review(reviewInput, { commit: true });
        const persisted = committed.persisted!;
        ledger.push({ scopeKey, outcome: 'APPROVED', detail: `review ${persisted.id}` });
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

    /* ---------------- Summary ---------------- */
    const doneCount = ledger.filter((l) => l.outcome === 'ALREADY_APPROVED' || l.outcome === 'APPROVED').length;
    const total = ledger.length;
    const remaining = ledger.filter((l) => l.outcome === 'FAILED').map((l) => l.scopeKey);

    console.log('\n--- ledger summary ---');
    for (const l of ledger) console.log(`${l.outcome.padEnd(17)} ${l.scopeKey}  ${l.detail}`);

    if (doneCount === total) {
      console.error(`\ncorrection ${correctionLinkId} committed; ${doneCount} of ${total} replacement approvals committed; all PEs done on candidate ${args.newCandidateId}.`);
      process.exit(EXIT_OK);
    } else {
      console.error(
        `\ncorrection ${correctionLinkId} committed; ${doneCount} of ${total} replacement approvals committed; ` +
          `PEs [${remaining.join(', ')}] still require manual re-approval on candidate ${args.newCandidateId}.`,
      );
      process.exit(EXIT_PARTIAL);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await s3ProofClient.destroy().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_USAGE_OR_STEP1_ERROR);
});
