/** Public original-source procurement; never a complete federal spending population. */
export interface ProcurementScopeRequest {
  awardIdentityKeys: readonly string[];
  knownAt?: string;
  sourceThrough?: string;
  /** Opt-in flag: when true, response includes actionDetails array (cap 2500). When absent or false, actionDetails is omitted. */
  includeActionDetails?: boolean;
}
export interface ProcurementMeasure {
  actions: string;
  obligationUsd: string | null;
  outlayUsd: string | null;
  obligationKnown: string;
  outlayKnown: string;
}
export interface ProcurementFlowGroup extends ProcurementMeasure {
  fiscalYear: number | null;
  awardingAgency: string | null;
  awardingSubTier: string | null;
  contractorName: string | null;
  recipientUei: string | null;
  vendorIdentityState: 'source_uei' | 'unresolved';
  /** Unresolved names never combine different awards into a purported legal entity. */
  vendorKey: string;
  attributeState: 'latest_known_catalog_observation' | 'award_observation_fork' | 'missing_catalog_attributes';
  latestSourceRevision: string;
  latestSourceObservedAt: string;
  latestRecordedAt: string;
  latestAttributeRecordedAt: string | null;
}
export interface ProcurementActionDetail {
  transactionIdentityKey: string;
  awardIdentityKey: string;
  awardUniqueId: string;
  selectedRevisionId: string;
  piid: string;
  submittingAgencyCode: string;
  parentPiid: string | null;
  parentAgencyCode: string | null;
  modificationNumber: string;
  transactionNumber: string;
  awardType: 'A' | 'B' | 'C' | 'D';
  actionDate: string | null;
  fiscalYear: number | null;
  obligationUsd: string;
  outlayUsd: null;
  sourceRevisionOrder: string;
  sourceObservedAt: string;
  recordedAt: string;
  sourceUrl: string | null;
  sourcePayloadHash: string;
  vendorKey: string;
  contractorName: string | null;
  recipientUei: string | null;
  vendorIdentityState: 'source_uei' | 'unresolved';
  attributeState: 'latest_known_catalog_observation' | 'award_observation_fork' | 'missing_catalog_attributes';
  fundingOrganization: {
    department: { code: string | null; name: string | null };
    subtier: { code: string | null; name: string | null };
    office: { code: string | null; name: string | null };
  };
  contractingOrganization: {
    department: { code: string | null; name: string | null };
    subtier: { code: string | null; name: string | null };
    office: { code: string | null; name: string | null };
  };
}
export interface ProcurementMoneyFlow {
  contract: 'defproc-scoped-money-flow/v1';
  state: 'partial' | 'unavailable';
  measure: 'qualified_observed_actions';
  currency: 'USD';
  knownAt: string;
  sourceThrough: string | null;
  scope: { awardIdentityKeys: readonly string[]; includesDescendants: false };
  totals: ProcurementMeasure | null;
  coverage: Readonly<Record<string, string>>;
  groups: readonly ProcurementFlowGroup[];
  /** Optional action details for qualified actions, capped at 2500. Present only when includeActionDetails=true in request. */
  actionDetails?: readonly ProcurementActionDetail[];
  provenance: readonly {
    awardIdentityKey: string; contract: string; producerCommit: string; imageDigest: string; runId: string; targetId: string;
    selectedActions: string; sourceUrl: string | null; catalogRevisionId: string | null;
    catalogSourceUrl: string | null; attributeRecordedAt: string | null;
  }[];
  sources: readonly { system: string; documentationUrl: string; semantics: string }[];
}
export type ProcurementHubSummary = Omit<ProcurementMoneyFlow, 'groups' | 'actionDetails'> & {
  groupCount: number;
};

/** Independently reported File C observations; never added to SAM action measures. */
export type ProcurementAccountScopeRequest = Pick<ProcurementScopeRequest, 'awardIdentityKeys' | 'knownAt'>;
export interface ProcurementAccountReportRow {
  /** Zero-based position in the original single-page API results, not a transaction identity. */
  sourceRowIndex: number;
  federalAccount: string | null;
  accountTitle: string | null;
  /** The funding endpoint does not supply a full Treasury Account Symbol. */
  treasuryAccountSymbol: null;
  programActivityCode: string | null;
  programActivityName: string | null;
  objectClass: string | null;
  objectClassName: string | null;
  disasterEmergencyFundCode: string | null;
  fundingAgencyName: string | null;
  awardingAgencyName: string | null;
  reportingFiscalYear: number | null;
  reportingFiscalQuarter: number | null;
  reportingFiscalMonth: number | null;
  isQuarterlySubmission: boolean | null;
  reportedObligationUsd: string | null;
  reportedGrossOutlayUsd: string | null;
}
export interface ProcurementAccountReport {
  awardIdentityKey: string;
  state: 'reported' | 'unavailable' | 'conflict';
  snapshotId: string | null;
  sourceObservedAt: string | null;
  recordedAt: string | null;
  sourcePayloadSha256: string | null;
  sourceUrl: string;
  /** Preserve source rows, including apparent duplicates. No period or account aggregation. */
  rows: readonly ProcurementAccountReportRow[];
}
export interface ProcurementAccountReports {
  contract: 'defproc-account-reports/v1';
  knownAt: string;
  scope: { awardIdentityKeys: readonly string[]; includesDescendants: false };
  coverage: 'source_reported_rows_only';
  reports: readonly ProcurementAccountReport[];
}
