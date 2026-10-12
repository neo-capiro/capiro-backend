/** @cleanup-smoke noArgsExit=2 helpExit=0 */
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
 * Usage: tsx verify-defense-budget-release-qualification-v1.ts <report.json|-> [default|ba4a-r3-repair]
 *   (or pipe the JSON on stdin and omit the argument for the default profile)
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
  /** Optional exact-fixture assertions used by scoped release profiles. */
  readonly expectedTargetPeCode?: string;
  readonly expectedFiscalYear?: number;
  readonly expectedTargetPeFiscalYearTotalMillions?: string;
  readonly expectedIdentityPeCodes?: readonly string[];
  readonly expectedR3PeCode?: string;
  readonly expectedR3DuplicateNaturalKeyConflictCount?: number;
  readonly expectedR3Performers?: readonly ExpectedR3Performer[];
}

export interface ExpectedR3Performer {
  readonly physicalPage: number;
  readonly performerName: string;
  readonly costCategory: string;
  readonly contractMethod: string;
  readonly fiscalYear: number;
  readonly totalCostMillions: string;
}

export const DEFAULT_RELEASE_GATE_POLICY: ReleaseGatePolicy = Object.freeze({
  expectedDecision: 'REVIEW',
  expectedPeTotalsMillions: KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS,
});

const BA4A_IDENTITY_PE_CODES = Object.freeze([
  '0603305A',
  '0603308A',
  '0603327A',
  '0603619A',
  '0603639A',
  '0603645A',
  '0603747A',
  '0603766A',
  '0603774A',
  '0603779A',
  '0603790A',
  '0603801A',
  '0603804A',
  '0603807A',
  '0603827A',
  '0604017A',
  '0604019A',
  '0604020A',
  '0604035A',
]);

/** Reviewed FY2024 Army BA4A profile for the page-399 R-3 parser repair. */
export const BA4A_R3_REPAIR_RELEASE_GATE_POLICY: ReleaseGatePolicy = Object.freeze({
  expectedDecision: 'REVIEW',
  expectedPeTotalsMillions: {},
  expectedTargetPeCode: '0604017A',
  expectedFiscalYear: 2024,
  expectedTargetPeFiscalYearTotalMillions: '3.024',
  expectedIdentityPeCodes: BA4A_IDENTITY_PE_CODES,
  expectedR3PeCode: '0604020A',
  expectedR3DuplicateNaturalKeyConflictCount: 0,
  expectedR3Performers: [
    {
      physicalPage: 399,
      performerName: 'Various : Various',
      costCategory: 'Olympus: Program Management and Capability Transition',
      contractMethod: 'TBD',
      fiscalYear: 2024,
      totalCostMillions: '6.178',
    },
    {
      physicalPage: 399,
      performerName: 'Various : Various.',
      costCategory: 'SBIR & STTR Adjustment',
      contractMethod: 'TBD',
      fiscalYear: 2024,
      totalCostMillions: '2.811',
    },
  ],
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

function normalizeCanonicalDecimal(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match == null) return null;
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction !== '') ? '-' : '';
  return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

/** True only when two canonical decimal strings name the exact same amount, modulo insignificant leading/trailing zero formatting (e.g. '0296.670' vs '296.67'). */
export function decimalStringsEqual(a: string, b: string): boolean {
  const normalizedA = normalizeCanonicalDecimal(a);
  const normalizedB = normalizeCanonicalDecimal(b);
  if (normalizedA == null || normalizedB == null) return a === b;
  return normalizedA === normalizedB;
}

function normalizedText(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
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

  if (policy.expectedTargetPeCode != null && report.targetPeCode !== policy.expectedTargetPeCode) {
    findings.push({
      code: 'target_pe_mismatch',
      message: `expected target PE '${policy.expectedTargetPeCode}', got '${report.targetPeCode}'`,
    });
  }

  if (policy.expectedFiscalYear != null && report.fiscalYear !== policy.expectedFiscalYear) {
    findings.push({
      code: 'fiscal_year_mismatch',
      message: `expected fiscal year ${policy.expectedFiscalYear}, got ${report.fiscalYear}`,
    });
  }

  if (policy.expectedTargetPeFiscalYearTotalMillions != null) {
    const actual = report.targetPeFiscalYearTotalMillions;
    if (actual == null) {
      findings.push({
        code: 'target_pe_total_missing',
        message: `expected target PE FY total ${policy.expectedTargetPeFiscalYearTotalMillions}, but no value was reported`,
      });
    } else if (!decimalStringsEqual(actual, policy.expectedTargetPeFiscalYearTotalMillions)) {
      findings.push({
        code: 'target_pe_total_mismatch',
        message: `expected target PE FY total ${policy.expectedTargetPeFiscalYearTotalMillions}, got ${actual}`,
      });
    }
  }

  if (policy.expectedIdentityPeCodes != null) {
    const expected = [...new Set(policy.expectedIdentityPeCodes)].sort();
    const actual = [...new Set(report.identityPeCodes)].sort();
    if (
      expected.length !== actual.length ||
      expected.some((peCode, index) => peCode !== actual[index]) ||
      report.identityCount !== actual.length
    ) {
      findings.push({
        code: 'identity_set_mismatch',
        message: `expected exactly [${expected.join(', ')}], got [${actual.join(', ')}] (identityCount=${report.identityCount})`,
      });
    }
  }

  if (policy.expectedR3PeCode != null && report.targetR3PeCode !== policy.expectedR3PeCode) {
    findings.push({
      code: 'r3_target_pe_mismatch',
      message: `expected R-3 target PE '${policy.expectedR3PeCode}', got '${report.targetR3PeCode}'`,
    });
  }

  if (
    policy.expectedR3DuplicateNaturalKeyConflictCount != null &&
    report.r3DuplicateNaturalKeyConflictCount !==
      policy.expectedR3DuplicateNaturalKeyConflictCount
  ) {
    findings.push({
      code: 'r3_duplicate_natural_key_conflict_count_mismatch',
      message: `expected ${policy.expectedR3DuplicateNaturalKeyConflictCount} R-3 duplicate natural-key conflicts, got ${report.r3DuplicateNaturalKeyConflictCount}`,
    });
  }

  if (policy.expectedR3Performers != null) {
    const used = new Set<number>();
    const matchedNaturalKeys: string[] = [];
    for (const expected of policy.expectedR3Performers) {
      const matchIndex = report.targetR3Performers.findIndex(
        (actual, index) =>
          !used.has(index) &&
          actual.physicalPage === expected.physicalPage &&
          normalizedText(actual.performerName) === normalizedText(expected.performerName) &&
          normalizedText(actual.costCategory) === normalizedText(expected.costCategory) &&
          normalizedText(actual.contractMethod) === normalizedText(expected.contractMethod) &&
          actual.fiscalYear === expected.fiscalYear &&
          actual.totalCostMillions != null &&
          decimalStringsEqual(actual.totalCostMillions, expected.totalCostMillions),
      );
      if (matchIndex < 0) {
        findings.push({
          code: 'r3_performer_missing',
          message: `missing reviewed R-3 row on physical page ${expected.physicalPage}: ${expected.costCategory} / ${expected.performerName} / ${expected.totalCostMillions}`,
        });
        continue;
      }
      used.add(matchIndex);
      const naturalKey = report.targetR3Performers[matchIndex]?.naturalKey;
      if (naturalKey == null || naturalKey.trim() === '') {
        findings.push({
          code: 'r3_natural_key_missing',
          message: `reviewed R-3 row '${expected.costCategory}' has no natural key`,
        });
      } else {
        matchedNaturalKeys.push(naturalKey);
      }
    }
    if (new Set(matchedNaturalKeys).size !== matchedNaturalKeys.length) {
      findings.push({
        code: 'r3_natural_keys_not_distinct',
        message: 'reviewed R-3 rows did not retain distinct natural keys',
      });
    }
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

export function releaseGatePolicyForProfile(profile: string): ReleaseGatePolicy {
  if (profile === 'default') return DEFAULT_RELEASE_GATE_POLICY;
  if (profile === 'ba4a-r3-repair') return BA4A_R3_REPAIR_RELEASE_GATE_POLICY;
  throw new Error(`unknown release-gate profile '${profile}'`);
}

function main(): void {
  const usage = 'Usage: tsx scripts/verify-defense-budget-release-qualification-v1.ts <report.json|-> [default|ba4a-r3-repair] (or pipe JSON on stdin)';
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 1 && cliArgs[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (cliArgs.length > 2 || cliArgs.some((value) => value.startsWith('--'))) {
    console.error(usage);
    process.exit(2);
  }
  const argPath = cliArgs[0];
  const profileName = cliArgs[1] ?? 'default';
  if (profileName !== 'default' && profileName !== 'ba4a-r3-repair') {
    console.error(`usage error: unknown release-gate profile '${profileName}'`);
    console.error(usage);
    process.exit(2);
  }
  let report: QualificationReport;
  try {
    const raw = argPath && argPath !== '-' ? readFileSync(argPath, 'utf8') : readFileSync(0, 'utf8');
    report = parseReportInput(raw);
  } catch (error) {
    console.error(`usage error: could not read/parse a QUALIFICATION_REPORT from input: ${(error as Error).message}`);
    if (!argPath) console.error(usage);
    process.exit(2);
  }

  let verdict: ReleaseGateVerdict;
  try {
    verdict = evaluateReleaseGate(report, releaseGatePolicyForProfile(profileName));
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
