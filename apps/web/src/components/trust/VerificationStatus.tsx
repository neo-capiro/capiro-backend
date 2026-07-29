export type VerificationDisplayState =
  | 'verified'
  | 'partially_verified'
  | 'not_verified'
  | 'unavailable';

export interface ClaimVerificationSummary {
  totalCount?: number;
  unsupportedCount?: number;
  unsupportedRatio?: number;
  claims?: Array<{ claim: string; supported: boolean; sourceIds?: number[] }>;
}

export interface VerificationFinding {
  check?: string;
  severity?: string;
  detail: string;
  section?: string;
}

export interface VerificationDisplay {
  state: VerificationDisplayState;
  label: string;
  detail: string;
  supportedCount: number;
  unsupportedCount: number;
  findings: VerificationFinding[];
}

function severe(findings: VerificationFinding[]): VerificationFinding[] {
  return findings.filter((finding) =>
    ['critical', 'high'].includes(String(finding.severity ?? '').toLowerCase()),
  );
}

export function deriveVerificationDisplay(input: {
  verification?: ClaimVerificationSummary | null;
  findings?: VerificationFinding[] | null;
  ran?: boolean;
  unavailableReason?: string | null;
}): VerificationDisplay {
  const findings = input.findings ?? [];
  const total = Math.max(0, input.verification?.totalCount ?? input.verification?.claims?.length ?? 0);
  const unsupported = Math.min(
    total,
    Math.max(
      0,
      input.verification?.unsupportedCount ??
        input.verification?.claims?.filter((claim) => !claim.supported).length ??
        0,
    ),
  );
  const supported = Math.max(0, total - unsupported);

  if (input.unavailableReason) {
    return {
      state: 'unavailable',
      label: 'Verification unavailable',
      detail: input.unavailableReason,
      supportedCount: supported,
      unsupportedCount: unsupported,
      findings,
    };
  }

  const didRun = input.ran ?? Boolean(input.verification);
  if (!didRun) {
    return {
      state: 'not_verified',
      label: 'Not verified',
      detail: 'Verification did not run for this content.',
      supportedCount: 0,
      unsupportedCount: 0,
      findings,
    };
  }

  if (total === 0) {
    return {
      state: 'not_verified',
      label: 'Not verified',
      detail: 'Verification ran but found no source-backed factual claims to check.',
      supportedCount: 0,
      unsupportedCount: 0,
      findings,
    };
  }

  if (unsupported > 0 || severe(findings).length > 0) {
    return {
      state: 'partially_verified',
      label: 'Partially verified',
      detail: `${supported} supported · ${unsupported} unsupported`,
      supportedCount: supported,
      unsupportedCount: unsupported,
      findings,
    };
  }

  return {
    state: 'verified',
    label: 'Verified',
    detail: `${supported} factual claim${supported === 1 ? '' : 's'} supported by retrieved evidence.`,
    supportedCount: supported,
    unsupportedCount: 0,
    findings,
  };
}

export function VerificationStatus({
  display,
  compact = false,
  acknowledged = false,
  onAcknowledge,
}: {
  display: VerificationDisplay;
  compact?: boolean;
  acknowledged?: boolean;
  onAcknowledge?: (checked: boolean) => void;
}) {
  const critical = severe(display.findings);
  return (
    <div
      className={`verification-status verification-status--${display.state}${compact ? ' verification-status--compact' : ''}`}
      role={critical.length > 0 ? 'alert' : 'status'}
    >
      <div className="verification-status__heading">
        <span className="verification-status__badge">{display.label}</span>
        <span>{display.detail}</span>
      </div>

      {!compact && display.findings.length > 0 && (
        <ul className="verification-status__findings">
          {display.findings.map((finding, index) => (
            <li key={`${finding.check ?? 'finding'}-${index}`}>
              <strong>{String(finding.severity ?? 'warning').toUpperCase()}</strong>
              {finding.section ? ` · ${finding.section}` : ''}: {finding.detail}
            </li>
          ))}
        </ul>
      )}

      {!compact && critical.length > 0 && onAcknowledge && (
        <label className="verification-status__acknowledge">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.currentTarget.checked)}
          />
          I reviewed the high-risk verification findings.
        </label>
      )}
    </div>
  );
}
