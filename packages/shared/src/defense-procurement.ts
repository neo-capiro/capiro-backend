/** Public original-source procurement; never a complete federal spending population. */
export interface ProcurementScopeRequest {
  awardIdentityKeys: readonly string[];
  knownAt?: string;
  sourceThrough?: string;
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
  provenance: readonly {
    awardIdentityKey: string; contract: string; producerCommit: string; imageDigest: string; runId: string; targetId: string;
    selectedActions: string; sourceUrl: string | null; catalogRevisionId: string | null;
    catalogSourceUrl: string | null; attributeRecordedAt: string | null;
  }[];
  sources: readonly { system: string; documentationUrl: string; semantics: string }[];
}
export type ProcurementHubSummary = Omit<ProcurementMoneyFlow, 'groups'> & {
  groupCount: number;
};
