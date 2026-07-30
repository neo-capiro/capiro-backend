/**
 * Program Elements Phase E — Exact-SHA atomic loader contract (shared).
 *
 * Every PE dollar loader that promotes canonical money must use this helper
 * before mutating the database:
 *
 *   inspect artifact
 *   → calculate exact SHA-256
 *   → quality audit
 *   → require explicit --approved-sha256 that matches the inspected bytes
 *   → only then run the promoting write path
 *
 * Defaults:
 *   - no posture flag  → inspect (no network, no DB write)
 *   - --inspect        → same as default (explicit)
 *   - --commit         → canonical promote; requires valid approved SHA
 *   - --extract-only / deprecated --dry-run → extract-only (no canonical write)
 *
 * A bare `--commit` never authorizes a vendor parse. Vendor LLM calls remain
 * exclusive to the generalized PDF path which requires --allow-vendor-parse
 * and are not expressed here.
 */
import {
  assertApprovedShaMatches,
  assertQualityAuditPassed,
  requireApprovedSha256,
} from './defense-budget-commit.js';

export type PeDollarLoaderPosture = 'inspect' | 'extract_only' | 'commit';

export const PE_EXACT_SHA_DOLLAR_LOADERS = [
  'sync-comptroller-jbooks.ts', // R-1 master list
  'sync-jbook-r2.ts', // R-2 / R-2A
  'sync-jbook-performers.ts', // R-3 performers
  'parse-pdoc-army.ts', // P-1 / P-40 procurement
  'load-pdoc-enrichment.ts', // P-40 narrative enrichment
  'load-om.ts', // O-1
  'load-om-op5.ts', // OP-5
  'parse-hasc-sasc-reports.ts', // HASC / SASC
  'parse-defense-approps-reports.ts', // HAC-D / SAC-D
  'parse-ndaa-conference.ts', // NDAA conference
  'parse-defense-approps-public-law.ts', // enacted public law
  'ingest-defense-budget-pdf.ts', // generalized defense-budget PDF
  'load-defense-budget-package.ts', // reviewed package JSON (topline)
] as const;

export type PeExactShaDollarLoader = (typeof PE_EXACT_SHA_DOLLAR_LOADERS)[number];

const INSPECT = '--inspect';
const EXTRACT_ONLY = '--extract-only';
const DRY_RUN = '--dry-run';
const COMMIT = '--commit';

/** Resolve mutually-exclusive operator posture for PE dollar loaders. */
export function resolvePeDollarLoaderPosture(argv: readonly string[]): PeDollarLoaderPosture {
  const inspect = argv.includes(INSPECT);
  const extractOnly = argv.includes(EXTRACT_ONLY);
  const dryRunAlias = argv.includes(DRY_RUN);
  const commit = argv.includes(COMMIT);
  const selected = [inspect, extractOnly, dryRunAlias, commit].filter(Boolean).length;

  if (selected > 1) {
    throw new Error(
      'Choose exactly one loader posture: default/--inspect, --extract-only, deprecated --dry-run, or --commit.',
    );
  }

  if (commit) return 'commit';
  if (extractOnly || dryRunAlias) return 'extract_only';
  return 'inspect';
}

export function usesDeprecatedDryRunAlias(argv: readonly string[]): boolean {
  return argv.includes(DRY_RUN);
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  const flag = name.startsWith('--') ? name : `--${name}`;
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ArtifactQualityAuditInput {
  /** Loaded parsed row count intended for promotion. */
  rowCount: number;
  /** Hard failures that must block commit (e.g. missing PE codes on all rows). */
  errors?: readonly string[];
  /** Soft anomalies (optional page/title issues). Never upgrade to pass. */
  warnings?: readonly string[];
  /**
   * Explicit fail: any quality gate the loader already knows about
   * (unit anomalies, title truncations, parser status='fail').
   */
  unitsAnomalies?: number;
  titleTruncated?: number;
  status?: 'ok' | 'warn' | 'fail';
  /** Minimum rows required for commit (default 1). Zero-row artifacts fail. */
  minRows?: number;
}

export interface ArtifactQualityAuditResult {
  status: 'ok' | 'warn' | 'fail';
  unitsAnomalies: number;
  titleTruncated: number;
  errors: string[];
  warnings: string[];
  rowCount: number;
}

/** Pure artifact quality audit used before any PE dollar monietization write. */
export function auditArtifactQuality(input: ArtifactQualityAuditInput): ArtifactQualityAuditResult {
  const errors = [...(input.errors ?? [])];
  const warnings = [...(input.warnings ?? [])];
  const unitsAnomalies = input.unitsAnomalies ?? 0;
  const titleTruncated = input.titleTruncated ?? 0;
  const minRows = input.minRows ?? 1;
  const rowCount = input.rowCount;

  if (rowCount < minRows) {
    errors.push(`Artifact quality gate: expected at least ${minRows} row(s); found ${rowCount}`);
  }
  if (unitsAnomalies > 0) {
    errors.push(`Artifact quality gate: unitsAnomalies=${unitsAnomalies}`);
  }

  let status: 'ok' | 'warn' | 'fail' = input.status ?? 'ok';
  if (errors.length > 0 || status === 'fail') status = 'fail';
  else if (warnings.length > 0 || titleTruncated > 0 || status === 'warn') status = 'warn';

  return { status, unitsAnomalies, titleTruncated, errors, warnings, rowCount };
}

/**
 * Fail-closed pre-mutation gate for every PE dollar `--commit`.
 *
 * Order (intentional):
 *   1. parse + validate approved SHA flag shape
 *   2. compare against the exact inspected artifact bytes
 *   3. run quality audit
 *   4. throw before any caller opens a write transaction
 */
export function assertExactShaCommitAllowed(input: {
  actualSha256: string;
  approvedSha256Raw: string | undefined;
  quality: ArtifactQualityAuditInput;
}): { approvedSha256: string; quality: ArtifactQualityAuditResult } {
  const approvedSha256 = requireApprovedSha256(input.approvedSha256Raw);
  assertApprovedShaMatches(input.actualSha256, approvedSha256);
  const quality = auditArtifactQuality(input.quality);
  assertQualityAuditPassed(quality);
  if (quality.errors.length > 0) {
    throw new Error(`Quality audit failed before canonical promotion: ${quality.errors.join('; ')}`);
  }
  return { approvedSha256, quality };
}

/**
 * Build a minimal inspect report shareable across loaders without DB contact.
 * Callers may spread additional domain fields.
 */
export function buildInspectReport(input: {
  loader: string;
  posture: PeDollarLoaderPosture;
  artifactPath: string;
  sha256: string;
  byteSize: number;
  quality: ArtifactQualityAuditResult;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    mode: input.posture === 'inspect' ? 'INSPECT' : input.posture.toUpperCase(),
    loader: input.loader,
    artifact: input.artifactPath,
    sha256: input.sha256,
    byteSize: input.byteSize,
    quality: {
      status: input.quality.status,
      rowCount: input.quality.rowCount,
      unitsAnomalies: input.quality.unitsAnomalies,
      titleTruncated: input.quality.titleTruncated,
      errors: input.quality.errors,
      warnings: input.quality.warnings,
    },
    commitRequirements: {
      flag: '--commit',
      approvedShaFlag: '--approved-sha256',
      approvedSha256MustEqual: input.sha256,
      note:
        'Default invocation never writes. Re-run with --commit --approved-sha256 <sha above> only after inspecting the quality report.',
    },
    ...(input.extra ?? {}),
  };
}

/** Inventory helpers for Phase E verifier scripts (no I/O). */
export function isPeExactShaDollarLoader(fileName: string): boolean {
  return (PE_EXACT_SHA_DOLLAR_LOADERS as readonly string[]).includes(fileName);
}
