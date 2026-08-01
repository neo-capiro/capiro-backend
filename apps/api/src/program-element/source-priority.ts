/**
 * Human-readable source labels and base-key normalization.
 *
 * Canonical winner selection no longer uses a global priority. Field ownership
 * lives in program-element-field-ownership.ts. sourceRank remains only as a
 * deprecated compatibility/tie-break helper for legacy reporting code.
 */
import { SOURCE_PRIORITY } from './types.js';

export const SOURCE_LABEL: Record<string, string> = {
  manual_override: 'Manual override (admin)',
  conference_report: 'NDAA conference',
  approps_conference_report: 'Defense Appropriations conference / JES',
  hac_d_report: 'HAC-D report',
  sac_d_report: 'SAC-D report',
  hasc_report: 'HASC report',
  sasc_report: 'SASC report',
  r_doc: "President's Budget (R-2)",
  p_doc: "President's Budget (P-1)",
  pdoc: "President's Budget (P-1/P-40)",
  o1: "President's Budget (O-1)",
  dod_comptroller: "President's Budget (DoD Comptroller)",
  public_law: 'Enacted public law',
  reprogramming: 'DoD reprogramming',
  execution: 'Budget execution',
  usaspending: 'USAspending',
  bill_text: 'Bill text',
  fixture: 'Seed fixture',
};

const BASE_KEYS = [
  'manual_override',
  'approps_conference_report',
  'conference_report',
  'hac_d_report',
  'sac_d_report',
  'hasc_report',
  'sasc_report',
  'dod_comptroller',
  'r_doc',
  'p_doc',
  'pdoc',
  'o1',
  'public_law',
  'reprogramming',
  'execution',
  'usaspending',
  'bill_text',
  'fixture',
] as const;

export function sourceBaseKey(source: string): string {
  const normalized = source.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return BASE_KEYS.find((key) => normalized === key || normalized.startsWith(`${key}_`)) ?? normalized;
}

/** @deprecated Canonical winner selection must use field ownership, not rank. */
export function sourceRank(source: string): number {
  const base = sourceBaseKey(source);
  const idx = SOURCE_PRIORITY.indexOf(base as (typeof SOURCE_PRIORITY)[number]);
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

export function sourceLabel(source: string): string {
  const base = sourceBaseKey(source);
  return SOURCE_LABEL[base] ?? base;
}
