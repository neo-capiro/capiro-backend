import { billStage, type BillStage } from '@capiro/shared';

export interface BillPassageModelInput {
  identifier?: string | null;
  congress?: number | null;
  billType?: string | null;
  billNumber?: string | null;
  introducedDate?: Date | string | null;
  latestActionDate?: Date | string | null;
  latestActionText?: string | null;
  cosponsorsCount?: number | null;
  sponsorParty?: string | null;
}

export interface BillPassagePrediction {
  probability: number | null;
  supported: boolean;
  reason?: string;
}

interface ParsedIdentifier {
  congress: number | null;
  billType: string | null;
  billNumber: string | null;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseIdentifier(identifier: string | null | undefined): ParsedIdentifier {
  const trimmed = (identifier ?? '').trim().toLowerCase();
  const match = /^(\d{3})-([a-z]+)-([0-9]+)$/i.exec(trimmed);
  if (!match) {
    return { congress: null, billType: null, billNumber: null };
  }
  return {
    congress: Number(match[1]),
    billType: match[2] ?? null,
    billNumber: match[3] ?? null,
  };
}

// GAI-07: billStage comes from @capiro/shared (this file previously carried a
// verbatim inline clone that kept the bare /passed|agreed to/ passage test
// after the shared classifier was chamber-qualified).

/**
 * Logistic-style inference model for bill passage probability.
 * Coefficients are calibrated for a 117th/118th-congress style feature space.
 * Returns null for unsupported bills to keep fallback behavior safe.
 */
export function predictBillPassageProbability(input: BillPassageModelInput): BillPassagePrediction {
  const parsedId = parseIdentifier(input.identifier);
  const congress = input.congress ?? parsedId.congress;
  const billType = (input.billType ?? parsedId.billType ?? '').toLowerCase();
  const billNumber = input.billNumber ?? parsedId.billNumber;

  // Supported-bill guard for model safety.
  if (congress == null || congress < 117 || congress > 120) {
    return { probability: null, supported: false, reason: 'unsupported_congress' };
  }

  const actionText = (input.latestActionText ?? '').trim();
  const introducedDate = parseDate(input.introducedDate);
  const latestActionDate = parseDate(input.latestActionDate);

  if (!actionText && !introducedDate && !latestActionDate) {
    return { probability: null, supported: false, reason: 'insufficient_signals' };
  }

  const stage = billStage(actionText);
  const stageWeight: Record<BillStage, number> = {
    introduced: -0.95,
    committee: 0.18,
    passed: 1.44,
    enacted: 4.2,
  };

  const now = Date.now();
  const ageDays = introducedDate
    ? clamp((now - introducedDate.getTime()) / (1000 * 60 * 60 * 24), 0, 3650)
    : 365;
  const actionLagDays = latestActionDate
    ? clamp((now - latestActionDate.getTime()) / (1000 * 60 * 60 * 24), 0, 1825)
    : 180;

  const cosponsors = clamp(Number(input.cosponsorsCount ?? 0), 0, 500);
  const cosponsorSignal = Math.log1p(cosponsors);

  const bipartisanSignal = /bipartisan|co[- ]sponsor/i.test(actionText) ? 1 : 0;
  const appropriationSignal = /appropriation|authorization|ndaa|national defense/i.test(actionText)
    ? 1
    : 0;

  // We treat this as a fixed inferred model with baked coefficients.
  const z =
    -1.28 +
    stageWeight[stage] +
    cosponsorSignal * 0.38 +
    (congress - 118) * 0.08 +
    (billType === 's' ? 0.07 : 0) +
    (billType === 'hr' ? 0.02 : 0) +
    (billNumber && Number(billNumber) < 1000 ? 0.06 : 0) +
    bipartisanSignal * 0.31 +
    appropriationSignal * 0.18 +
    ageDays * -0.0016 +
    actionLagDays * -0.0012 +
    ((input.sponsorParty ?? '').toUpperCase() === 'I' ? 0.04 : 0);

  const probability = clamp(sigmoid(z), 0.01, 0.995);
  return { probability, supported: true };
}
