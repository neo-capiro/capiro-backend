/**
 * verify-defense-budget-release-qualification-v1.ts
 *
 * Phase 10B-36 continuation: the strict release GATE this program was
 * missing. `qualify-defense-budget-drain-image-v1.ts` (and the integration
 * spec that exercises it) deliberately accept any real, valid verifier
 * decision -- `expect(['PASS', 'REVIEW', 'REJECT']).toContain(result.decision)`
 * -- because pinning that diagnostic test to one decision would make it wrong
 * the moment a real, disclosed pre-existing defect (or its fix) legitimately
 * changes what this fixture decides. That is the right call for a diagnostic
 * test, but it leaves NOTHING that actually fails a release on an unexpected
 * decision. This script is that missing piece: read one real
 * QUALIFICATION_REPORT (this driver's own stdout line, or the equivalent
 * JSON), compare it against the reviewed, expected release profile, and exit
 * non-zero the moment reality disagrees. It never re-runs the qualification
 * itself and never talks to AWS/Postgres/MinIO -- it only judges a report
 * that already exists, so it is trivial to run against a live CloudWatch log
 * line, a saved file, or a unit test fixture alike.
 *
 * Usage: tsx verify-defense-budget-release-qualification-v1.ts <report.json>
 *   (or pipe the JSON on stdin and omit the argument)
 *
 * Exit codes: 0 = RELEASE_IMAGE_QUALIFICATION_PASS. 1 =
 * RELEASE_IMAGE_QUALIFICATION_BLOCKED (the report disagrees with the
 * expected profile in some named way -- see the printed reasons). 2 = usage
 * error (no report given / not parseable JSON).
 */
import { readFileSync } from 'node:fs';
import type { QualificationReport } from './qualify-defense-budget-drain-image-v1.js';
import { KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS } from './qualify-defense-budget-drain-image-v1.js';

export interface ReleaseGatePolicy {
  /** The decision this exact reviewed fixture/policy is expected to produce. Overridable because a future fixture/policy will not always expect 'REVIEW'. */
  readonly expectedDecision: string;
  /** PE code -> expected FY total in millions, compared numerically (never a
   * brittle string-format match -- the real system may emit '296.67' where a
   * reference table says '296.670'; both name the same dollar amount). */
  readonly expectedPeTotalsMillions: Readonly<Record<string, string>>;
}

export const DEFAULT_RELEASE_GATE_POLICY: ReleaseGatePolicy = Object.freeze({
  expectedDecision: 'REVIEW',
  expectedPeTotalsMillions: KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS,
});

export interface ReleaseGateFinding {
  readonly code: string;
  readonly message: string;
}

export interface ReleaseGateVerdict {
  readonly pass: boolean;
  readonly token: 'RELEASE_IMAGE_QUALIFICATION_PASS' | 'RELEASE_IMAGE_QUALIFICATION_BLOCKED';
  readonly findings: readonly ReleaseGateFinding[];
}

/** True when two canonical decimal strings name the same dollar amount, regardless of trailing-zero/precision formatting (e.g. '296.670' vs '296.67'). Not a general numeric-tolerance comparison -- these are always small, human-scale dollar-million figures with a handful of decimal digits, never large enough for float precision loss to matter at comparison time. */
export function decimalStringsEqual(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b;
  return Math.abs(na - nb) < 0.0005;
}

/** Pure: judges one real report against one policy. No I/O, fully unit-testable. */
export function evaluateReleaseGate(
  report: QualificationReport,
  policy: ReleaseGatePolicy = DEFAULT_RELEASE_GATE_POLICY,
): ReleaseGateVerdict {
  const findings: ReleaseGateFinding[] = [];

  if (report.decision !== policy.expectedDecision) {
    findings.push({
      code: 'unexpected_decision',
      message: `expected decision '${policy.expectedDecision}', got '${report.decision}'`,
    });
  }

  if (!report.dbverifyOk) {
    findings.push({
      code: 'dbverify_not_ok',
      message: 'no persisted verification run was found for this candidate -- persist-audit did not write through',
    });
  }

  if (report.dbRunDecision !== null && report.dbRunDecision !== report.decision) {
    findings.push({
      code: 'artifact_db_decision_mismatch',
      message: `artifact decision '${report.decision}' disagrees with the persisted DB run's decision '${report.dbRunDecision}'`,
    });
  }

  for (const [peCode, expectedTotal] of Object.entries(policy.expectedPeTotalsMillions)) {
    const actualTotal = report.allTargetPeFiscalYearTotalsMillions[peCode];
    if (actualTotal == null) {
      findings.push({
        code: 'pe_total_missing',
        message: `PE ${peCode}: expected FY total ${expectedTotal} but the report has no value for it at all (report never reached/asserted this PE)`,
      });
      continue;
    }
    if (!decimalStringsEqual(actualTotal, expectedTotal)) {
      findings.push({
        code: 'pe_total_mismatch',
        message: `PE ${peCode}: expected FY total ${expectedTotal}, got ${actualTotal}`,
      });
    }
    if (!report.identityPeCodes.includes(peCode)) {
      findings.push({
        code: 'pe_identity_missing',
        message: `PE ${peCode}: expected a program_element_identity assertion for it, but identityPeCodes does not contain it`,
      });
    }
  }

  const pass = findings.length === 0;
  return { pass, token: pass ? 'RELEASE_IMAGE_QUALIFICATION_PASS' : 'RELEASE_IMAGE_QUALIFICATION_BLOCKED', findings };
}

/** Accepts either a bare QualificationReport object, or a full CloudWatch-style
 * log line ("QUALIFICATION_REPORT { ... }") -- so this can be pointed
 * directly at a copy-pasted log line without hand-trimming it first. */
export function parseReportInput(raw: string): QualificationReport {
  const trimmed = raw.trim();
  const marker = 'QUALIFICATION_REPORT';
  const jsonText = trimmed.startsWith(marker) ? trimmed.slice(marker.length).trim() : trimmed;
  return JSON.parse(jsonText) as QualificationReport;
}

function main(): void {
  const argPath = process.argv[2];
  let report: QualificationReport;
  try {
    const raw = argPath ? readFileSync(argPath, 'utf8') : readFileSync(0, 'utf8');
    report = parseReportInput(raw);
  } catch (error) {
    console.error(`usage error: could not read/parse a QUALIFICATION_REPORT from input: ${(error as Error).message}`);
    process.exit(2);
  }

  let verdict: ReleaseGateVerdict;
  try {
    verdict = evaluateReleaseGate(report);
  } catch (error) {
    console.error(`usage error: report is not a well-formed QualificationReport: ${(error as Error).message}`);
    process.exit(2);
  }
  console.log(
    verdict.token,
    JSON.stringify(
      {
        runId: report.runId,
        decision: report.decision,
        artifactSha256: report.artifactSha256,
        normalizedArtifactSha256: report.normalizedArtifactSha256,
        findings: verdict.findings,
      },
      null,
      2,
    ),
  );
  process.exit(verdict.pass ? 0 : 1);
}

if (require.main === module) {
  main();
}
