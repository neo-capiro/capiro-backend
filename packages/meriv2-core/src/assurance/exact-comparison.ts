import { FUNDING_CLAIM_STAGE_LABEL } from '@capiro/shared/funding-claim';
import type { EvidencePassage } from '../jev/evidence-envelope';

export type ExactValueKind = 'amount' | 'date' | 'fiscal_year' | 'funding_stage' | 'identifier';
export interface ExactValue {
  kind: ExactValueKind;
  raw: string;
  normalized: string | number;
  precision?: number;
}
export interface ExactComparison {
  kind: ExactValueKind | 'none';
  claimValue: ExactValue | null;
  evidenceValues: ExactValue[];
  result: 'match' | 'mismatch' | 'absent' | 'not_comparable';
  detail: string;
}

const STAGE_ALIASES = Object.entries(FUNDING_CLAIM_STAGE_LABEL).flatMap(([stage, label]) => [
  [stage.replace(/_/g, ' '), stage], [label, stage],
] as const).sort((a, b) => b[0].length - a[0].length);
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function extractExactValues(text: string): ExactValue[] {
  const found: Array<ExactValue & { index: number }> = [];
  const occupied: Array<[number, number]> = [];
  const add = (value: ExactValue, index: number, length: number) => {
    if (occupied.some(([start, end]) => index < end && index + length > start)) return;
    occupied.push([index, index + length]);
    found.push({ ...value, index });
  };

  for (const match of text.matchAll(/\$\s*([0-9][\d,]*(?:\.\d+)?)\s*(billion|million|thousand|bn|mm|[bmk])?\b/gi)) {
    const number = Number(match[1]!.replace(/,/g, ''));
    const unit = (match[2] ?? '').toLowerCase();
    const multiplier = /^(?:b|bn|billion)$/.test(unit) ? 1e9
      : /^(?:m|mm|million)$/.test(unit) ? 1e6 : /^(?:k|thousand)$/.test(unit) ? 1e3 : 1;
    add({ kind: 'amount', raw: match[0], normalized: number * multiplier,
      precision: multiplier / (10 ** decimalPlaces(match[1]!)) }, match.index!, match[0].length);
  }
  for (const match of text.matchAll(/\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/g)) {
    add({ kind: 'date', raw: match[0], normalized: match[0] }, match.index!, match[0].length);
  }
  for (const match of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    const month = MONTHS[match[1]!.toLowerCase()]!;
    add({ kind: 'date', raw: match[0], normalized: `${match[3]}-${pad(month)}-${pad(Number(match[2]))}` }, match.index!, match[0].length);
  }
  for (const match of text.matchAll(/\bFY\s*[-']?\s*(20)?(\d{2})\b/gi)) {
    const year = match[1] ? Number(`${match[1]}${match[2]}`) : Number(`20${match[2]}`);
    add({ kind: 'fiscal_year', raw: match[0], normalized: String(year) }, match.index!, match[0].length);
  }
  const lower = text.toLowerCase();
  for (const [alias, stage] of STAGE_ALIASES) {
    const re = new RegExp(`\\b${escapeRegex(alias).replace(/\\ /g, '[ _-]+')}\\b`, 'gi');
    for (const match of text.matchAll(re)) add({ kind: 'funding_stage', raw: match[0], normalized: stage }, match.index!, match[0].length);
  }
  for (const match of text.matchAll(/\b(?:H\.?\s*R\.?|S\.?|H\.?\s*J\.?\s*Res\.?|S\.?\s*J\.?\s*Res\.?)\s*\d{1,5}\b|\b\d{7}[A-Z][A-Z0-9]*\b/gi)) {
    add({ kind: 'identifier', raw: match[0], normalized: match[0].replace(/[.\s-]/g, '').toUpperCase() }, match.index!, match[0].length);
  }
  return found.sort((a, b) => a.index - b.index).map(({ index: _index, ...value }) => value);
}

export function compareExactValues(input: { claim: string; evidencePassages: readonly (EvidencePassage | string)[] }): ExactComparison {
  const claimValues = extractExactValues(input.claim);
  if (!claimValues.length) return { kind: 'none', claimValue: null, evidenceValues: [], result: 'not_comparable', detail: 'The claim contains no deterministic exact value.' };
  const priority: ExactValueKind[] = ['amount', 'date', 'fiscal_year', 'funding_stage', 'identifier'];
  const claimValue = [...claimValues].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))[0]!;
  const evidenceValues = input.evidencePassages.flatMap((passage) => extractExactValues(typeof passage === 'string' ? passage : passage.text))
    .filter((value) => value.kind === claimValue.kind);
  if (!evidenceValues.length) return { kind: claimValue.kind, claimValue, evidenceValues, result: 'absent', detail: 'No comparable value appears in the evidence passages.' };
  const matched = evidenceValues.some((value) => valuesMatch(claimValue, value));
  return { kind: claimValue.kind, claimValue, evidenceValues, result: matched ? 'match' : 'mismatch',
    detail: matched ? 'The normalized claim value appears in the evidence.' : 'Comparable evidence values differ from the claim value.' };
}

export function houseSenateComparisonComplete(input: { claimText: string; evidence: readonly (EvidencePassage | string)[] }): boolean {
  if (!/\b(?:house|HASC|HAC-?D)\b/i.test(input.claimText) || !/\b(?:senate|SASC|SAC-?D)\b/i.test(input.claimText)) return true;
  const corpus = input.evidence.map((item) => typeof item === 'string' ? item : item.text).join('\n');
  return /\b(?:house|HASC|HAC-?D)\b[^\n$]*\$\s*\d|\$\s*\d[^\n]*\b(?:house|HASC|HAC-?D)\b/i.test(corpus)
    && /\b(?:senate|SASC|SAC-?D)\b[^\n$]*\$\s*\d|\$\s*\d[^\n]*\b(?:senate|SASC|SAC-?D)\b/i.test(corpus);
}

function valuesMatch(claim: ExactValue, evidence: ExactValue): boolean {
  if (claim.kind !== 'amount') return claim.normalized === evidence.normalized;
  const quantum = claim.precision ?? 1;
  return Math.round(Number(claim.normalized) / quantum) === Math.round(Number(evidence.normalized) / quantum);
}
function decimalPlaces(value: string): number { return value.includes('.') ? value.split('.')[1]!.length : 0; }
function pad(value: number): string { return String(value).padStart(2, '0'); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
