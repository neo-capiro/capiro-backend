/**
 * parser-run-identity-v1 -- the single canonical parser-run identity used by
 * BOTH cache registration (parser-router-v1.service.ts) and proof lookup
 * (filesystem-parser-artifact-proof-resolver.ts). Phase 10B-25.
 *
 * Root cause this module fixes: registration built its cache key from the
 * complete REQUESTED page set for a step (`step.pages`), while proof lookup
 * independently reconstructed a *different* key from `exactPages(run.pageRanges)`
 * -- and `pageRanges` only ever contains pages that were actually SELECTED as
 * evidence in the final composed output (never pages that legitimately
 * returned `no_embedded_text`, e.g. blank pages). Any document with at least
 * one legitimately blank requested page therefore produced two different
 * hashes for the same execution, so proof lookup always missed and
 * `parser_run_proof` failed closed to REJECT even though the parser run was
 * real and correctly recorded.
 *
 * Fix: identity is ALWAYS derived from the immutable execution contract --
 * source SHA, engine, engine version, configuration hash, and the exact
 * REQUESTED page set -- never from which pages happened to succeed or get
 * selected. Coverage (succeeded/failed pages) is tracked and verified
 * separately, as evidence, never as identity.
 *
 * Both callers MUST go through `buildParserRunIdentityV1` /
 * `resolveContributingRunIdentityV1` in this module. Do not independently
 * reconstruct a `ParserRunIdentityV1` anywhere else in the codebase.
 */
import {
  computeParserRunCacheKey,
  computeParserRunId,
  type ParserRunIdentityV1,
} from './parser-runtime-contract-v1.js';
import type { ParserRunV1 } from '../contracts/extraction-artifact-v1.js';

export const PARSER_RUN_RUNTIME_CONTRACT_VERSION_V1 = 'defense_budget_parser_job_v1';

function sortedUniquePositivePages(pages: readonly number[]): number[] {
  const unique = [...new Set(pages)];
  if (unique.some((page) => !Number.isInteger(page) || page <= 0)) {
    throw new Error('parser run identity requires positive integer pages');
  }
  return unique.sort((left, right) => left - right);
}

export interface ParserRunIdentityInputV1 {
  sourceSha256: string;
  method: ParserRunIdentityV1['method'];
  parserVersion: string;
  parserConfigSha256: string;
  /** The complete page set REQUESTED for this execution -- the only lawful identity input. */
  requestedPages: readonly number[];
  runtimeContractVersion?: string;
}

/**
 * The one lawful constructor for a parser-run identity. Both the
 * registration path (executing/caching a parser run) and the proof-lookup
 * path (verifying a persisted artifact's parser lineage) must call this with
 * the run's REQUESTED pages -- never with succeeded-only or evidence-only
 * pages.
 */
export function buildParserRunIdentityV1(input: ParserRunIdentityInputV1): ParserRunIdentityV1 {
  if (input.requestedPages.length === 0) {
    throw new Error('parser run identity requires at least one requested page');
  }
  return {
    sourceSha256: input.sourceSha256,
    method: input.method,
    parserVersion: input.parserVersion,
    parserConfigSha256: input.parserConfigSha256,
    pages: sortedUniquePositivePages(input.requestedPages),
    runtimeContractVersion: input.runtimeContractVersion ?? PARSER_RUN_RUNTIME_CONTRACT_VERSION_V1,
  };
}

export function parserRunCacheKeyV1(input: ParserRunIdentityInputV1): string {
  return computeParserRunCacheKey(buildParserRunIdentityV1(input));
}

export function parserRunIdV1(input: ParserRunIdentityInputV1): string {
  return computeParserRunId(buildParserRunIdentityV1(input));
}

export type ResolvedContributingRunIdentityV1 =
  | { status: 'ok'; identity: ParserRunIdentityV1 }
  | { status: 'legacy_missing_requested_pages' };

/**
 * Reconstruct the proof-lookup identity for a run already embedded in a
 * persisted `DefenseBudgetExtractionArtifactV1`. This MUST read
 * `run.requestedPages` -- never `run.pageRanges` (evidence coverage only).
 *
 * Legacy artifacts persisted before `requestedPages` existed on the contract
 * fail closed: there is no safe way to recover the original requested-page
 * set from evidence alone (a legitimately blank page leaves no trace), so
 * this returns a typed "legacy" status rather than guessing or falling back
 * to a fuzzy lookup.
 */
export function resolveContributingRunIdentityV1(
  run: ParserRunV1,
  runtimeContractVersion: string = PARSER_RUN_RUNTIME_CONTRACT_VERSION_V1,
): ResolvedContributingRunIdentityV1 {
  if (run.requestedPages == null || run.requestedPages.length === 0) {
    return { status: 'legacy_missing_requested_pages' };
  }
  return {
    status: 'ok',
    identity: buildParserRunIdentityV1({
      sourceSha256: run.inputSourceSha256,
      method: run.method,
      parserVersion: run.parserVersion,
      parserConfigSha256: run.parserConfigSha256,
      requestedPages: run.requestedPages,
      runtimeContractVersion,
    }),
  };
}

export interface ParserRunCoverageV1 {
  requestedPages: readonly number[];
  succeededPages: readonly number[];
  failedPages: readonly { page: number; code: string; message: string }[];
}

export interface ParserRunCoverageValidationV1 {
  ok: boolean;
  findings: string[];
}

/**
 * Prove that a run's succeeded/failed coverage evidence is internally
 * consistent with its requested-page identity:
 *   - no page appears in both succeeded and failed;
 *   - the union of succeeded + failed accounts for every requested page
 *     (no unaccounted requested page, no extra page outside the request);
 *   - every typed failure carries a code and message (never silently blank).
 */
export function validateParserRunCoverageV1(
  coverage: ParserRunCoverageV1,
): ParserRunCoverageValidationV1 {
  const findings: string[] = [];
  const requested = new Set(coverage.requestedPages);
  const succeeded = new Set(coverage.succeededPages);
  const failedPageNumbers = coverage.failedPages.map((failure) => failure.page);
  const failed = new Set(failedPageNumbers);

  if (failedPageNumbers.length !== failed.size) {
    findings.push('duplicate page in failedPages');
  }
  if (coverage.succeededPages.length !== succeeded.size) {
    findings.push('duplicate page in succeededPages');
  }

  const overlap = [...succeeded].filter((page) => failed.has(page));
  if (overlap.length > 0) {
    findings.push(`page(s) present in both succeeded and failed sets: ${overlap.join(', ')}`);
  }

  for (const page of succeeded) {
    if (!requested.has(page)) findings.push(`succeeded page ${page} was not requested`);
  }
  for (const page of failed) {
    if (!requested.has(page)) findings.push(`failed page ${page} was not requested`);
  }

  const accountedFor = new Set([...succeeded, ...failed]);
  const unaccounted = [...requested].filter((page) => !accountedFor.has(page));
  if (unaccounted.length > 0) {
    findings.push(`requested page(s) with no succeeded/failed disposition: ${unaccounted.join(', ')}`);
  }

  for (const failure of coverage.failedPages) {
    if (failure.code.trim().length === 0) {
      findings.push(`failed page ${failure.page} has no typed failure code`);
    }
  }

  return { ok: findings.length === 0, findings };
}
