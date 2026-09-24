/**
 * R5 Action Layer — shared types (contract §Fact shape).
 *
 * Slice 1 defines this; every other R5 slice imports it. The invariant fields
 * (basis, amountStage, geography, freshness, coverage, caveats) are carried
 * through every transition and never invented.
 */

import type { IsoTimestamp, SourceFreshness } from '../district-nexus.types.js';

// ── Fact ────────────────────────────────────────────────────────────────────

export type R5FactBasis = 'verified_client_nexus' | 'public_context';

export type R5FactSection =
  | 'footprint'
  | 'economic'
  | 'opportunities'
  | 'representation'
  | 'cpf_cds'
  | 'changes';

export type R5AmountStage =
  | 'requested'
  | 'enacted'
  | 'obligated'
  | 'awarded'
  | 'forecast';

export type R5GeographyScope = 'district' | 'statewide' | 'national';

export type R5Coverage = 'complete' | 'partial' | 'unknown';

export interface R5Fact {
  /** Stable: `${section}:${sourceType}:${sourceRecordId ?? hash}` */
  id: string;
  section: R5FactSection;
  label: string;
  /** null = UNKNOWN, never coerced to 0 */
  value: string | number | null;
  unit: string | null; // 'USD', 'people', 'sq_ft', ...
  amountStage: R5AmountStage | null;
  basis: R5FactBasis;
  source: {
    type: string;
    label: string;
    recordId: string | null;
    url: string | null;
  };
  asOf: {
    date: string | null;
    fiscalYear: number | null;
    sourceYear: number | null;
  };
  geography: {
    state: string;
    district: string | null;
    scope: R5GeographyScope;
    basis: string | null;
    boundaryCongress: number | null;
  };
  freshness: {
    lastSyncedAt: string | null;
    stale: boolean;
    unavailable: boolean;
  };
  coverage: R5Coverage;
  caveats: string[]; // existing DataQualityWarning codes/labels carried through
}

// ── Gap ──────────────────────────────────────────────────────────────────────

export interface R5Gap {
  section: R5FactSection;
  reason: string;
  source: string | null;
}

// ── District context (the single source of truth for every R5 read) ──────────

export interface R5DistrictContext {
  clientId: string;
  clientName: string;
  state: string;
  district: string;
  facts: R5Fact[];
  gaps: R5Gap[];
  sourceHealth: SourceFreshness[];
  generatedAt: string;
}

// ── Brief ────────────────────────────────────────────────────────────────────

export interface R5BriefSection {
  key: string;
  title: string;
  paragraphs: string[];
  factIds: string[];
}

export interface R5Brief {
  clientId: string;
  clientName: string;
  state: string;
  district: string;
  sections: R5BriefSection[];
  facts: R5Fact[];
  gaps: R5Gap[];
  sourceHealth: SourceFreshness[];
  generatedAt: string;
}

export interface R5BriefExportInput {
  clientId: string;
  state: string;
  district: string;
  sections: Array<{ key: string; title: string; paragraphs: string[] }>;
  factIds: string[];
}

export interface R5BriefSaveInput {
  clientId: string;
  state: string;
  district: string;
  sections: Array<{ key: string; title: string; paragraphs: string[] }>;
  factIds: string[];
}

export interface R5BriefSaveResult {
  attachmentId: string;
  fileName: string;
}