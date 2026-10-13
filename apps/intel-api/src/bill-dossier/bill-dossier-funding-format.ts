import type { FundingAmountTreatment } from './bill-dossier.types.js';
export function versionedValueSource(
  label: string,
  value: number | null,
  sourceKey: string | null | undefined,
  sha256: string | null | undefined,
): string | null {
  if (value == null) return null;
  if (!sourceKey && !sha256) return `${label} source version not verified`;
  return `${label} source ${sourceKey ?? 'document'}${sha256 ? `@${sha256.slice(0, 12)}` : ''}`;
}

export function fmtMillions(m: number): string {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

export function fmtSignedMillions(m: number): string {
  if (m === 0) return 'flat';
  return `${m > 0 ? '+' : '−'}${fmtMillions(Math.abs(m))}`;
}

export function amountTreatmentFor(track: string | null | undefined): FundingAmountTreatment {
  switch (track) {
    case 'request':
      return 'request';
    case 'authorization':
      return 'proposed_authorization';
    case 'appropriation':
      return 'appropriated_funding';
    case 'interim_funding':
      return 'interim_funding';
    case 'supplemental':
      return 'supplemental';
    case 'reconciliation':
      return 'reconciliation';
    default:
      return 'unknown';
  }
}

export function fundingStageTrackLabel(stage: string, track: string): string {
  const stageLabel =
    stage === 'president'
      ? "President's"
      : stage === 'house'
        ? 'House'
        : stage === 'senate'
          ? 'Senate'
          : stage === 'conference'
            ? 'Conference'
            : stage === 'enacted'
              ? 'Enacted'
              : stage;
  const trackLabel =
    track === 'authorization'
      ? 'authorization'
      : track === 'appropriation'
        ? 'appropriation'
        : track === 'request'
          ? 'request'
          : track.replaceAll('_', ' ');
  return `${stageLabel} ${trackLabel}`;
}
