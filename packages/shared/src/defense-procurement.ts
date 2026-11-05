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
