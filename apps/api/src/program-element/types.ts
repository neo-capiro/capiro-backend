import type { MoneyUnit } from '@capiro/shared/money';
import type { CanonicalPeYearField, PeSourceAuthority } from './program-element-field-ownership.js';

export interface PeRecordInput {
  peCode: string;
  service?: string | null;
  serviceCode?: string | null;
  appropriationType?: string | null;
  budgetActivity?: string | null;
  budgetActivityName?: string | null;
  lineNumber?: string | null;
  title: string;
  description?: string | null;
  acatLevel?: string | null;
  programOfRecord?: string | null;
  status?: string | null;
  rDocUrl?: string | null;
  pDocUrl?: string | null;
  oDocUrl?: string | null;
  raw?: unknown;
  firstSeenFy?: number | null;
}

export interface PeYearInput {
  peCode: string;
  fy: number;
  request?: string | number | null;
  hascMark?: string | number | null;
  sascMark?: string | number | null;
  hacDMark?: string | number | null;
  sacDMark?: string | number | null;
  conference?: string | number | null;
  ndaaConference?: string | number | null;
  enacted?: string | number | null;
  reprogrammed?: string | number | null;
  executed?: string | number | null;
  notes?: string | null;
  rDocSection?: string | null;
  raw?: unknown;
}


export interface PeYearWriteContext {
  authority: PeSourceAuthority;
  sourceDocumentId?: string | null;
  parseJobId?: string | null;
  pageNumber?: number | null;
  sourceSpanHash?: string | null;
  extractorVersion?: string | null;
  originalValues?: Partial<
    Record<CanonicalPeYearField, { value: number; unit: MoneyUnit }>
  >;
  dataCorrection?: boolean;
}

export interface PeMilestoneInput {
  peCode: string;
  milestoneType: string;
  plannedDate?: Date | string | null;
  actualDate?: Date | string | null;
  status?: string | null;
  notes?: string | null;
}

export interface FieldDelta {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export const SOURCE_PRIORITY = [
  // capiro_admin reconciliation decision — outranks every ingestion source so an
  // accepted/manual value becomes (and stays) canonical across future syncs (Step 0.2).
  'manual_override',
  'conference_report',
  'hac_d_report',
  'sac_d_report',
  'hasc_report',
  'sasc_report',
  'r_doc',
  'p_doc',
  'public_law',
  'usaspending',
  'bill_text',
  'fixture',
] as const;

export type SourcePriority = (typeof SOURCE_PRIORITY)[number];

/** Source tag written when a capiro_admin resolves a reconciliation conflict. */
export const MANUAL_OVERRIDE_SOURCE = 'manual_override';
