import type { SourceFundingPosition } from '../sourcedata/source-data.repository.js';
import type {
  FundingPositionView,
  FundingVehicleContext,
  FundingComparison,
} from './bill-dossier.types.js';
import { STAGE_ORDER, OVERRIDE_RECONCILIATION_MARKER } from './bill-dossier-funding.constants.js';
export function pickPrimaryPosition(
  positions: Array<FundingPositionView & { id: string }>,
  vehicle: FundingVehicleContext | null,
): (FundingPositionView & { id: string }) | null {
  if (!vehicle) return null;
  const eligible = positions.filter(
    (position) =>
      isReviewedVerification(position.verification) &&
      position.vehicleId === vehicle.id &&
      position.fiscalYear === vehicle.fiscalYear &&
      position.stage === vehicle.stage &&
      position.vehicleClass === vehicle.track &&
      position.vehicleTrack === vehicle.track &&
      position.sourceDocumentCurrent !== false,
  );
  if (!eligible.length) return null;
  const rank = (p: FundingPositionView) =>
    (STAGE_ORDER[p.stage] ?? -1) * 100 +
    (p.vehicleClass === 'appropriation' ? 20 : p.vehicleClass === 'authorization' ? 10 : 0) +
    (p.verification === 'verified' ? 5 : p.verification === 'reviewed' ? 3 : 0);
  return [...eligible].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export function isOverrideReconciled(position: FundingPositionView): boolean {
  return (
    position.verification === 'verified' &&
    (position.note ?? '').toLowerCase().includes(OVERRIDE_RECONCILIATION_MARKER)
  );
}

export function isReviewedVerification(verification: string): boolean {
  return verification === 'reviewed' || verification === 'verified';
}

export function buildRequestComparison(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison | null {
  const request = raw.find(
    (r) =>
      r.stage === 'president' &&
      r.vehicleClass === 'request' &&
      isReviewedVerification(r.verificationStatus) &&
      r.sourceDocumentCurrent !== false &&
      r.scope === primary.scope &&
      r.fiscalYear === fiscalYearOf(raw, primary.id),
  );
  if (!request) return null;
  const requestAmount = Number(request.amountMillions);
  const delta = primary.amountMillions - requestAmount;
  return {
    scope: primary.scope,
    label: "President's request",
    amountMillions: requestAmount,
    deltaMillions: delta,
    pct: requestAmount === 0 ? null : Number(((delta / requestAmount) * 100).toFixed(2)),
    billId: null,
    comparable: true,
  };
}

export function buildSenateComparison(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison | null {
  const fy = fiscalYearOf(raw, primary.id);
  const senate = raw.find(
    (r) =>
      r.stage === 'senate' &&
      r.vehicleClass === primary.vehicleClass &&
      isReviewedVerification(r.verificationStatus) &&
      r.sourceDocumentCurrent !== false &&
      r.scope === primary.scope &&
      r.fiscalYear === fy,
  );
  if (!senate || senate.id === primary.id) return null;
  return {
    scope: primary.scope,
    label: senate.vehicleLabel ?? 'Senate',
    amountMillions: Number(senate.amountMillions),
    deltaMillions: null,
    pct: null,
    billId: null,
    comparable: true,
  };
}

export function buildLikeForLikeComparisons(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison[] {
  const fy = fiscalYearOf(raw, primary.id);
  return raw
    .filter(
      (r) =>
        r.id !== primary.id &&
        (r.vehicleClass === 'request' || r.vehicleClass === primary.vehicleClass) &&
        isReviewedVerification(r.verificationStatus) &&
        r.sourceDocumentCurrent !== false &&
        r.scope === primary.scope &&
        r.fiscalYear === fy,
    )
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 99) - (STAGE_ORDER[b.stage] ?? 99))
    .map((r) => {
      const amount = Number(r.amountMillions);
      const delta = amount - primary.amountMillions;
      return {
        scope: primary.scope,
        label: r.vehicleLabel ?? `${r.stage} ${r.vehicleClass}`,
        amountMillions: amount,
        deltaMillions: delta,
        pct:
          primary.amountMillions === 0
            ? null
            : Number(((delta / primary.amountMillions) * 100).toFixed(2)),
        billId: null,
        comparable: true,
      };
    });
}

export function fiscalYearOf(raw: SourceFundingPosition[], id: string): number {
  return raw.find((r) => r.id === id)?.fiscalYear ?? -1;
}
