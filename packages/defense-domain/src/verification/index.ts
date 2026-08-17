export type DefenseVerificationSeverity = 'info' | 'warning' | 'blocking';
export type DefenseVerificationStatus = 'passed' | 'failed' | 'blocked' | 'not_run';

export interface DefenseVerificationFinding {
  readonly code: string;
  readonly severity: DefenseVerificationSeverity;
  readonly message: string;
  readonly entityKind?: string;
  readonly entityId?: string;
  readonly fiscalYear?: number;
  readonly sourceDocumentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DefenseVerificationReport {
  readonly runId: string;
  readonly snapshotId?: string;
  readonly status: DefenseVerificationStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly findings: readonly DefenseVerificationFinding[];
  readonly verifierVersions: Readonly<Record<string, string>>;
}

export function hasBlockingFindings(
  findings: readonly DefenseVerificationFinding[],
): boolean {
  return findings.some((finding) => finding.severity === 'blocking');
}

export class DefenseVerificationBlockedError extends Error {
  constructor(readonly findings: readonly DefenseVerificationFinding[]) {
    super(
      `Defense verification is blocked by ${
        findings.filter((finding) => finding.severity === 'blocking').length
      } finding(s).`,
    );
    this.name = 'DefenseVerificationBlockedError';
  }
}

export function assertVerificationPassed(report: DefenseVerificationReport): void {
  if (report.status !== 'passed' || hasBlockingFindings(report.findings)) {
    throw new DefenseVerificationBlockedError(report.findings);
  }
}
