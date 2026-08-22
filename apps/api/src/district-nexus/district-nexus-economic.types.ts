import type { IsoTimestamp, Money } from './district-nexus.types.js';

export const DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE = 'district_nexus_external_context';
export const DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE = 'district_nexus_supplier_footprint';
export const DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE = 'district_nexus_footprint_import';

export type DistrictNexusEconomicFeature =
  | typeof DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE
  | typeof DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE
  | typeof DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE;

export type FootprintImportFormat = 'csv' | 'xlsx' | 'manual' | 'meri_structured';
export type FootprintImportStatus = 'preview' | 'committed' | 'failed' | 'superseded';
export type FootprintReviewStatus = 'pending_review' | 'approved' | 'rejected';
export type FootprintVerificationStatus =
  | 'source_verified'
  | 'geocode_verified'
  | 'user_provided'
  | 'inferred';

export type FootprintEvidenceType =
  | 'facility'
  | 'employee'
  | 'payroll'
  | 'capital_investment'
  | 'taxes'
  | 'supplier'
  | 'supplier_spend'
  | 'partner'
  | 'beneficiary'
  | 'beneficiary_count'
  | 'project_site'
  | 'other';

export interface FootprintImportRowInput {
  evidenceType?: FootprintEvidenceType | string | null;
  name?: string | null;
  subjectName?: string | null;
  subjectId?: string | null;
  facilityName?: string | null;
  supplierName?: string | null;
  partnerName?: string | null;
  projectName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  congressionalDistrict?: string | null;
  employeeCount?: number | string | null;
  payroll?: number | string | null;
  capitalInvestment?: number | string | null;
  taxes?: number | string | null;
  supplierSpend?: number | string | null;
  beneficiaryCount?: number | string | null;
  numericValue?: number | string | null;
  unit?: string | null;
  currency?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  observedAt?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FootprintImportPreviewRequest {
  filename: string;
  format: FootprintImportFormat;
  /** Base64 file content for csv/xlsx. Not accepted for manual/meri_structured. */
  contentBase64?: string;
  /** Structured rows for manual entry or a reviewed Meri extraction. */
  rows?: FootprintImportRowInput[];
  /** Optional source-to-canonical column map; keys are source headers. */
  columnMap?: Record<string, string>;
  effectiveDate?: string | null;
  externalUseApproved?: boolean;
}

export interface FootprintPreviewEvidence {
  previewId: string;
  rowOrdinal: number;
  evidenceType: FootprintEvidenceType;
  subjectName: string | null;
  subjectId: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string;
  };
  geography: {
    state: string | null;
    congressionalDistrict: string | null;
    boundaryCongress: number | null;
    latitude: number | null;
    longitude: number | null;
    districtSource: 'provided' | 'census_geocoder' | 'unresolved';
  };
  numericValue: number | null;
  unit: string | null;
  currency: string | null;
  verificationStatus: FootprintVerificationStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  observedAt: string | null;
  warnings: string[];
  sourceRecordId: string;
  metadata: Record<string, unknown>;
}

export interface FootprintImportPreviewResponse {
  importId: string;
  clientId: string;
  filename: string;
  format: FootprintImportFormat;
  status: 'preview';
  rowCount: number;
  evidenceCount: number;
  acceptedCount: number;
  rejectedCount: number;
  warnings: string[];
  evidence: FootprintPreviewEvidence[];
  createdAt: IsoTimestamp;
}

export interface FootprintImportSummary {
  id: string;
  filename: string;
  format: FootprintImportFormat;
  status: FootprintImportStatus;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  effectiveDate: string | null;
  externalUseApproved: boolean;
  createdAt: IsoTimestamp;
  committedAt: IsoTimestamp | null;
  warnings: string[];
}

export interface FootprintEvidenceRecord {
  id: string;
  importId: string | null;
  rowOrdinal: number | null;
  evidenceType: FootprintEvidenceType;
  subjectName: string | null;
  subjectId: string | null;
  state: string | null;
  congressionalDistrict: string | null;
  boundaryCongress: number | null;
  numericValue: number | null;
  unit: string | null;
  currency: string | null;
  verificationStatus: FootprintVerificationStatus;
  reviewStatus: FootprintReviewStatus;
  externalUseApproved: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  observedAt: IsoTimestamp | null;
  promotedFacilityId: string | null;
  createdAt: IsoTimestamp;
  reviewedAt: IsoTimestamp | null;
  metadata: Record<string, unknown>;
}

export interface FootprintEvidenceDecisionRequest {
  externalUseApproved?: boolean;
}

export interface ClientEconomicDistrictSummary {
  districtKey: string;
  state: string;
  districtCode: string;
  approvedEvidenceCount: number;
  pendingEvidenceCount: number;
  facilityCount: number;
  employeeCount: number | null;
  payroll: Money;
  capitalInvestment: Money;
  taxes: Money;
  supplierCount: number;
  supplierSpend: Money;
  partnerCount: number;
  beneficiaryCount: number | null;
  projectSiteCount: number;
  boundaryCongresses: number[];
  externalUseApprovedCount: number;
}

export interface ClientEconomicFootprintResponse {
  clientId: string;
  districts: ClientEconomicDistrictSummary[];
  imports: FootprintImportSummary[];
  evidence: FootprintEvidenceRecord[];
  coverage: {
    percent: number;
    measured: string[];
    missing: string[];
  };
  totals: {
    approvedEvidenceCount: number;
    pendingEvidenceCount: number;
    facilityCount: number;
    employeeCount: number | null;
    payroll: Money;
    capitalInvestment: Money;
    taxes: Money;
    supplierCount: number;
    supplierSpend: Money;
    partnerCount: number;
    beneficiaryCount: number | null;
    projectSiteCount: number;
  };
  warnings: string[];
  generatedAt: IsoTimestamp;
}

export type DistrictEconomicSource = 'acs' | 'cbp' | 'lodes';

export interface DistrictEconomicMetric {
  source: DistrictEconomicSource;
  dataset: string;
  sourceYear: number;
  boundaryCongress: number | null;
  metricKey: string;
  value: number | null;
  unit: string | null;
  marginOfError: number | null;
  naicsCode: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  observedAt: IsoTimestamp | null;
  lastSyncedAt: IsoTimestamp;
  metadata: Record<string, unknown>;
}

export interface DistrictEconomicSourceStatus {
  source: DistrictEconomicSource;
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  status: 'running' | 'success' | 'success_with_errors' | 'failed' | 'unavailable';
  lastAttemptAt: IsoTimestamp;
  lastCompletedAt: IsoTimestamp | null;
  rowsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  error: string | null;
  annual: true;
}

export interface DistrictEconomicContextResponse {
  districtKey: string;
  state: string;
  districtCode: string;
  metrics: DistrictEconomicMetric[];
  sources: DistrictEconomicSourceStatus[];
  warnings: string[];
  generatedAt: IsoTimestamp;
}

export interface EconomicSourceSyncResult {
  source: DistrictEconomicSource;
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  dryRun: boolean;
  rowsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  warnings: string[];
  status: 'success' | 'success_with_errors' | 'unavailable';
}
