/** Wire-safe Research Portfolio contracts shared by the main API and web. */
export type ResearchPortfolioMode = 'manual' | 'rules' | 'hybrid';
export type ResearchPortfolioLifecycle = 'active' | 'archived';
export type ResearchPortfolioGrantRole = 'owner' | 'editor' | 'viewer';
export type ResearchPortfolioMemberKind =
  | 'program'
  | 'program_element'
  | 'project'
  | 'budget_line'
  | 'award'
  /** Federal bill: congress + bill type + number (congress_bill.id). */
  | 'federal_bill'
  /** State bill: jurisdiction + legislative session + type/number (state_bill.id). */
  | 'state_bill';
/** Bills are portfolio subjects, not funding bases; they carry legislative facts. */
export type ResearchPortfolioBillMemberKind = 'federal_bill' | 'state_bill';
export const RESEARCH_PORTFOLIO_BILL_MEMBER_KINDS: readonly ResearchPortfolioBillMemberKind[] = [
  'federal_bill',
  'state_bill',
];
export function isResearchPortfolioBillKind(
  kind: string | null | undefined,
): kind is ResearchPortfolioBillMemberKind {
  return kind === 'federal_bill' || kind === 'state_bill';
}
export type ResearchPortfolioMemberDisposition =
  'included' | 'candidate' | 'withdrawn' | 'excluded' | 'unresolved';
export type ResearchPortfolioMemberOrigin = 'manual' | 'rule' | 'import';
export type ResearchPortfolioEventKind =
  | 'created'
  | 'updated'
  | 'archived'
  | 'restored'
  | 'grant_upserted'
  | 'grant_removed'
  | 'client_linked'
  | 'client_unlinked'
  | 'member_added'
  | 'member_decided'
  | 'member_excluded'
  | 'member_reinstated'
  | 'member_resolved'
  | 'rule_published'
  | 'review_updated'
  | 'annual_reopened'
  | 'import_created'
  | 'import_action'
  | 'review_note_added'
  | 'share_enabled'
  | 'share_disabled'
  | 'share_pin_changed'
  | 'share_design_saved'
  | 'share_link_published'
  | 'share_link_revoked'
  | 'bill_changed';

export interface ResearchPortfolioSummaryDto {
  id: string;
  name: string;
  purpose: string | null;
  mode: ResearchPortfolioMode;
  lifecycle: ResearchPortfolioLifecycle;
  revision: number;
  ownerUserId: string;
  memberCount: number;
  clientLinkCount: number;
  myRole: ResearchPortfolioGrantRole;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioGrantDto {
  id: string;
  principalType: 'user';
  principalUserId: string;
  role: ResearchPortfolioGrantRole;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioClientLinkDto {
  id: string;
  clientId: string;
  clientName: string;
  linkedByUserId: string;
  createdAt: string;
}

export interface ResearchPortfolioMemberDto {
  id: string;
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label: string | null;
  disposition: ResearchPortfolioMemberDisposition;
  origin?: ResearchPortfolioMemberOrigin;
  reason: string | null;
  unresolvedInput: Readonly<Record<string, unknown>> | null;
  resolvedAt: string | null;
  /**
   * Canonical source facts captured when the member was added. Bill members carry
   * legislative facts here (jurisdiction, session, status, latest action, source
   * revision) so a snapshot freezes the state it was taken from. Absent on members
   * stored before fact capture; never infer a bill's current state from a label.
   */
  facts?: Readonly<Record<string, unknown>> | null;
  revision: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** One legislative subject as discovery returns it, with enough context to disambiguate. */
export interface ResearchPortfolioBillMatchDto {
  targetKind: ResearchPortfolioBillMemberKind;
  targetId: string;
  /** Human identifier, e.g. "H.R. 8800" or "HB 1234". */
  identifier: string;
  title: string;
  /** 'US' for federal; the two-letter state code for state bills. */
  jurisdiction: string;
  /** Congress number for federal bills, legislative session name for state bills. */
  session: string | null;
  status: string | null;
  latestActionDate: string | null;
  latestActionText: string | null;
  sourceUrl: string | null;
  matchReason: 'exact_identifier' | 'title' | 'subject';
}

export interface ResearchPortfolioBillSearchResponseDto {
  items: readonly ResearchPortfolioBillMatchDto[];
  nextCursor: string | null;
  /** Families actually queried and whether each answered; never imply full state coverage. */
  coverage: {
    federal: 'searched' | 'empty' | 'unavailable';
    state: 'searched' | 'empty' | 'unavailable';
    statesWithData: readonly string[];
    note: string;
  };
}

export interface ResearchPortfolioBillDetailDto {
  targetKind: ResearchPortfolioBillMemberKind;
  targetId: string;
  identifier: string;
  title: string;
  jurisdiction: string;
  session: string | null;
  status: string | null;
  statusAt: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  sourceUrl: string | null;
  /** Canonical source revision this detail was read from. */
  sourceRevision: string | null;
  sponsors: readonly { name: string; party: string | null; state: string | null; role: string }[];
  committees: readonly { name: string; chamber: string | null; role: string }[];
  textVersions: readonly {
    label: string;
    date: string | null;
    url: string | null;
    revision: string | null;
  }[];
  votes: readonly { date: string | null; chamber: string | null; question: string; result: string }[];
  relatedBills: readonly { identifier: string; relation: string }[];
  /** Fields the source family does not provide for this bill. */
  unavailable: readonly string[];
  coverage: {
    source: string;
    note: string;
    available: boolean;
  };
}

export interface ResearchPortfolioEventDto {
  id: string;
  eventKind: ResearchPortfolioEventKind;
  aggregateRevision: number;
  /** null when the event was recorded by a source ingestion owner. */
  actorUserId: string | null;
  /** 'system' marks source-owned legislative events; user mutations omit/default to 'user'. */
  actorKind?: 'user' | 'system';
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface ResearchPortfolioDetailDto extends ResearchPortfolioSummaryDto {
  grants: readonly ResearchPortfolioGrantDto[];
  clientLinks: readonly ResearchPortfolioClientLinkDto[];
  members: readonly ResearchPortfolioMemberDto[];
  recentEvents: readonly ResearchPortfolioEventDto[];
}

export interface ResearchPortfolioListResponseDto {
  items: readonly ResearchPortfolioSummaryDto[];
  nextCursor: string | null;
}

export interface ResearchPortfolioMutationMetaDto {
  idempotencyKey: string;
  expectedRevision?: number;
}

export interface CreateResearchPortfolioDto extends ResearchPortfolioMutationMetaDto {
  name: string;
  purpose?: string | null;
  mode?: ResearchPortfolioMode;
}

export interface UpdateResearchPortfolioDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  name?: string;
  purpose?: string | null;
  mode?: ResearchPortfolioMode;
}

export interface ChangeResearchPortfolioLifecycleDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
}

export interface PutResearchPortfolioGrantDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  principalType: 'user';
  role: ResearchPortfolioGrantRole;
}

export interface CreateResearchPortfolioClientLinkDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  clientId: string;
}

export interface CreateResearchPortfolioMemberDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label?: string | null;
  unresolvedInput?: Readonly<Record<string, unknown>> | null;
}

export interface DecideResearchPortfolioMemberDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  memberId: string;
  disposition: 'included' | 'excluded';
  reason: string;
}

export interface ResearchPortfolioMemberDecisionDto {
  memberId: string;
  disposition: 'included' | 'excluded';
  reason: string;
}

export interface DecideResearchPortfolioMembersDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  decisions: readonly ResearchPortfolioMemberDecisionDto[];
}

export interface ResolveResearchPortfolioMemberDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label?: string | null;
}

export interface ResearchPortfolioMutationOutcomeDto {
  targetId: string;
  targetType: 'portfolio' | 'grant' | 'client_link' | 'member' | 'rule';
  status: 'created' | 'updated' | 'deleted' | 'unchanged';
  id: string | null;
  message?: string;
}

export interface ResearchPortfolioMutationReceiptDto {
  portfolioId: string;
  eventId: string;
  actorUserId: string;
  occurredAt: string;
  resultingRevision: number;
  replayed: boolean;
  outcomes: readonly ResearchPortfolioMutationOutcomeDto[];
}

export type ResearchPortfolioRuleOperator =
  'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'exists' | 'gte' | 'lte';
export type ResearchPortfolioRuleScalar = string | number | boolean;
export type ResearchPortfolioRuleNode =
  | { kind: 'and' | 'or'; clauses: readonly ResearchPortfolioRuleNode[] }
  | { kind: 'not'; clause: ResearchPortfolioRuleNode }
  | {
      kind: 'condition';
      field: string;
      operator: ResearchPortfolioRuleOperator;
      value: ResearchPortfolioRuleScalar | readonly ResearchPortfolioRuleScalar[];
    };

export interface ResearchPortfolioRuleCandidateDto {
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label?: string | null;
  facts: Readonly<Record<string, unknown>>;
  completeness?:
    'complete' | 'partial' | 'unavailable' | 'unresolved' | 'insufficient_qualification';
  unknownReasons?: readonly string[];
}

export interface PreviewResearchPortfolioRuleDto {
  expectedRevision: number;
  schemaVersion: 1;
  expression: ResearchPortfolioRuleNode;
  readableExpression: string;
  mode: Exclude<ResearchPortfolioMode, 'manual'>;
  qualificationPolicy: Readonly<Record<string, unknown>>;
  taxonomyVersionId?: string | null;
  templateVersionId?: string | null;
  candidates: readonly ResearchPortfolioRuleCandidateDto[];
}

export interface ResearchPortfolioRulePreviewItemDto {
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label: string | null;
  result: 'match' | 'nonmatch' | 'unknown';
  disposition:
    | 'added'
    | 'retained'
    | 'withdrawn'
    | 'accepted_nonmatch'
    | 'manual_override'
    | 'candidate'
    | 'unknown'
    | 'not_evaluated';
  reasons: readonly string[];
}

export interface ResearchPortfolioRulePreviewDto {
  previewId: string;
  previewHash: string;
  portfolioRevision: number;
  expiresAt: string;
  complete: boolean;
  counts: Readonly<Record<ResearchPortfolioRulePreviewItemDto['disposition'], number>>;
  items: readonly ResearchPortfolioRulePreviewItemDto[];
}

export interface PublishResearchPortfolioRuleDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  previewId: string;
  previewHash: string;
}

export interface ResearchPortfolioRuleVersionDto {
  id: string;
  version: number;
  schemaVersion: 1;
  expression: ResearchPortfolioRuleNode;
  readableExpression: string;
  mode: ResearchPortfolioMode;
  qualificationPolicy: Readonly<Record<string, unknown>>;
  taxonomyVersionId: string | null;
  templateVersionId: string | null;
  previewHash: string;
  authorUserId: string;
  predecessorId: string | null;
  publishedAt: string;
  recompute: {
    operationId: string;
    status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
  } | null;
}

export interface ResearchTaxonomyConceptDto {
  id: string;
  stableKey: string;
  name: string;
  kind: string;
  parentKey: string | null;
  aliases: readonly string[];
  provenance: Readonly<Record<string, unknown>>;
  qualification: string;
}

export interface ResearchTaxonomyVersionDto {
  id: string;
  version: number;
  label: string;
  vocabulary: 'official_current' | 'official_historical' | 'capiro' | 'tenant';
  source: string | null;
  provenance: Readonly<Record<string, unknown>>;
  publishedAt: string;
  concepts: readonly ResearchTaxonomyConceptDto[];
}

export interface ResearchPortfolioTemplateVersionDto {
  id: string;
  version: number;
  schemaVersion: 1;
  expression: ResearchPortfolioRuleNode;
  readableExpression: string;
  mode: ResearchPortfolioMode;
  qualificationPolicy: Readonly<Record<string, unknown>>;
  taxonomyVersionId: string | null;
  publishedAt: string;
}

export interface ResearchPortfolioTemplateDto {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  versions: readonly ResearchPortfolioTemplateVersionDto[];
}

export interface CreateResearchPortfolioTemplateDto extends ResearchPortfolioMutationMetaDto {
  name: string;
  description?: string | null;
  schemaVersion: 1;
  expression: ResearchPortfolioRuleNode;
  readableExpression: string;
  mode: ResearchPortfolioMode;
  qualificationPolicy: Readonly<Record<string, unknown>>;
  taxonomyVersionId?: string | null;
}

export interface CreateResearchPortfolioTemplateVersionDto extends ResearchPortfolioMutationMetaDto {
  schemaVersion: 1;
  expression: ResearchPortfolioRuleNode;
  readableExpression: string;
  mode: ResearchPortfolioMode;
  qualificationPolicy: Readonly<Record<string, unknown>>;
  taxonomyVersionId?: string | null;
}

export type ResearchPortfolioReviewStatus =
  'open' | 'assigned' | 'deferred' | 'resolved' | 'cancelled';
export type ResearchPortfolioReviewTrigger =
  'rule_change' | 'annual_continuity' | 'import' | 'dispute' | 'manual';
export type ResearchPortfolioReviewTargetKind = ResearchPortfolioMemberKind | 'rule' | 'portfolio';
export type ResearchPortfolioDecisionType = 'include' | 'exclude' | 'defer' | 'reopen' | 'dispute';
export type ResearchPortfolioContinuityStatus =
  | 'unchanged'
  | 'changed'
  | 'expired'
  | 'renamed'
  | 'renumbered'
  | 'split'
  | 'merged'
  | 'unresolved'
  | 'new';
export type ResearchPortfolioImportJobStatus =
  | 'created'
  | 'mapped'
  | 'previewed'
  | 'applying'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'needs_reconciliation'
  | 'compensated';
export type ResearchPortfolioImportWorksheetKind = 'membership' | 'rules' | 'reviews';
export type ResearchPortfolioImportRowOutcome =
  'applied' | 'skipped' | 'conflict' | 'failed' | 'unknown';
export type ResearchPortfolioImportRowPreviewClassification =
  'resolved' | 'duplicate' | 'invalid' | 'ambiguous' | 'unresolved' | 'inaccessible';

export interface ResearchPortfolioReviewEvidenceDto {
  sourceRevisionId: string;
  locator: Readonly<Record<string, unknown>>;
  quote: string | null;
  stance: 'for' | 'against';
}

export interface ResearchPortfolioReviewDto {
  id: string;
  tenantId: string;
  portfolioId: string;
  targetKind: ResearchPortfolioReviewTargetKind;
  targetId: string;
  trigger: ResearchPortfolioReviewTrigger;
  triggerIdentity: string;
  dependencyIdentity: string | null;
  assigneeUserId: string | null;
  reason: string;
  evidenceFor: readonly ResearchPortfolioReviewEvidenceDto[];
  evidenceAgainst: readonly ResearchPortfolioReviewEvidenceDto[];
  revision: number;
  triggerFingerprint: string;
  status: ResearchPortfolioReviewStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ResearchPortfolioDecisionDto {
  id: string;
  tenantId: string;
  portfolioId: string;
  targetKind: ResearchPortfolioReviewTargetKind;
  targetId: string;
  decisionType: ResearchPortfolioDecisionType;
  reason: string;
  authorUserId: string;
  decisionTime: string;
  priorDecisionId: string | null;
  supersedesId: string | null;
  evidenceFor: readonly ResearchPortfolioReviewEvidenceDto[];
  evidenceAgainst: readonly ResearchPortfolioReviewEvidenceDto[];
  reviewId: string | null;
  createdAt: string;
}

export interface ResearchPortfolioContinuityLedgerDto {
  /** False for a current readonly projection that has not been persisted. */
  persisted?: boolean;
  id: string;
  tenantId: string;
  portfolioId: string;
  priorDecisionId: string | null;
  currentDecisionId: string | null;
  continuityKey: string;
  priorDependencyFingerprint: string | null;
  dependencyFingerprint: string;
  status: ResearchPortfolioContinuityStatus;
  identityMapping: Readonly<Record<string, unknown>>;
  changedDependencies: Readonly<Record<string, unknown>>;
  originalEvidence: Readonly<Record<string, unknown>>;
  sourceEdition: string | null;
  relevantPeriodStart: string | null;
  relevantPeriodEnd: string | null;
  expiryDate: string | null;
  reopeningReason: string | null;
  reopeningReviewId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioImportJobDto {
  id: string;
  tenantId: string;
  portfolioId: string;
  operationKey: string;
  worksheetKind: ResearchPortfolioImportWorksheetKind;
  status: ResearchPortfolioImportJobStatus;
  originalHash: string;
  originalSize: number;
  fileName: string;
  mediaType: string;
  originalStorageKey: string | null;
  fileMetadata: Readonly<Record<string, unknown>>;
  parserVersion: string;
  schemaVersion: string;
  targetRevision: number;
  checkpoint: Readonly<Record<string, unknown>> | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  rowCount: number;
  appliedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioImportRowDto {
  id: string;
  tenantId: string;
  portfolioId: string;
  importJobId: string;
  worksheetKind: ResearchPortfolioImportWorksheetKind;
  sheetName: string | null;
  rowNumber: number;
  rowIdentity: string;
  rawCells: Readonly<Record<string, unknown>>;
  parsedData: Readonly<Record<string, unknown>>;
  repairs: Readonly<Record<string, unknown>>;
  validationIssues: readonly string[];
  selected: boolean;
  previewClassification: ResearchPortfolioImportRowPreviewClassification | null;
  previewReason: string | null;
  finalOutcome: ResearchPortfolioImportRowOutcome | null;
  finalReason: string | null;
  finalDisposition: Readonly<Record<string, unknown>>;
  expectedRevision: number | null;
  canonicalTargetKey: string | null;
  targetKind: string | null;
  targetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssignResearchPortfolioReviewDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  expectedPortfolioRevision: number;
  assigneeUserId: string | null;
  reason: string;
}

export interface DecideResearchPortfolioReviewDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  expectedPortfolioRevision: number;
  decisionType: ResearchPortfolioDecisionType;
  reason: string;
  priorDecisionId?: string | null;
  evidenceFor?: readonly ResearchPortfolioReviewEvidenceDto[];
  evidenceAgainst?: readonly ResearchPortfolioReviewEvidenceDto[];
}

export interface ResearchPortfolioReviewBulkItemDto {
  reviewId: string;
  expectedRevision: number;
  decisionType: ResearchPortfolioDecisionType;
  reason: string;
  evidenceFor?: readonly ResearchPortfolioReviewEvidenceDto[];
  evidenceAgainst?: readonly ResearchPortfolioReviewEvidenceDto[];
}

export interface BulkResearchPortfolioReviewsDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  items: readonly ResearchPortfolioReviewBulkItemDto[];
}

export interface ResearchPortfolioReviewMutationReceiptDto {
  portfolioId: string;
  actorUserId: string;
  occurredAt: string;
  outcomes: readonly {
    reviewId: string | null;
    status: 'assigned' | 'decided' | 'unchanged' | 'conflict' | 'failed' | 'note_added';
    revision: number | null;
    decisionId?: string | null;
    noteId?: string | null;
    message: string | null;
  }[];
}

export interface ReopenResearchPortfolioAnnualReviewDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  continuityIds: readonly string[];
  reason?: string;
}

export interface RefreshResearchPortfolioAnnualReviewDto extends ResearchPortfolioMutationMetaDto {
  expectedRevision: number;
  asOfFiscalYear?: number;
  knownAt?: string;
  decisionIds?: readonly string[];
}

export interface ResearchPortfolioAnnualReviewDto {
  items: readonly ResearchPortfolioContinuityLedgerDto[];
  counts: Readonly<Record<ResearchPortfolioContinuityStatus, number>>;
  knownAtSupport?: 'current_projection_with_temporal_identity';
  limitations?: readonly string[];
}

export interface ResearchPortfolioImportMappingVersionDto {
  id: string;
  version: number;
  mapping: Readonly<Record<string, unknown>>;
  schemaVersion: string;
  authorUserId: string;
  createdAt: string;
}

export interface ResearchPortfolioImportAttemptDto {
  id: string;
  operationKey: string;
  action:
    'preview' | 'apply' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile' | 'compensate';
  outcome: 'succeeded' | 'known_failure' | 'unknown';
  checkpoint: Readonly<Record<string, unknown>>;
  errorCode: string | null;
  receipt: Readonly<Record<string, unknown>>;
  actorUserId: string;
  createdAt: string;
}

export interface ResearchPortfolioImportEffectDto {
  id: string;
  importRowId: string;
  effectFingerprint: string;
  effectKind: string;
  canonicalTargetKey: string;
  targetId: string;
  targetRevisionAtApply: number | null;
  payload: Readonly<Record<string, unknown>>;
  appliedAt: string;
}

export interface ResearchPortfolioImportCompensationReceiptDto {
  id: string;
  operationKey: string;
  previewHash: string;
  status: 'previewed' | 'committed' | 'failed';
  effects: readonly Readonly<Record<string, unknown>>[];
  actorUserId: string;
  createdAt: string;
}

export interface ResearchPortfolioImportDetailDto extends ResearchPortfolioImportJobDto {
  rows: readonly ResearchPortfolioImportRowDto[];
  mappings: readonly ResearchPortfolioImportMappingVersionDto[];
  attempts: readonly ResearchPortfolioImportAttemptDto[];
  effects: readonly ResearchPortfolioImportEffectDto[];
  compensationReceipts: readonly ResearchPortfolioImportCompensationReceiptDto[];
}

export interface CreateResearchPortfolioImportDto {
  operationKey: string;
  expectedRevision: number;
  worksheetKind: ResearchPortfolioImportWorksheetKind;
  fileName: string;
  mediaType: 'text/csv' | 'application/vnd.ms-excel';
  contentBase64: string;
  schemaVersion: string;
  mapping: Readonly<Record<string, string>>;
}

export interface ResearchPortfolioImportActionDto {
  operationKey: string;
  expectedRevision?: number;
  selectedRowIds?: readonly string[];
  repairs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  compensationPreviewHash?: string;
}

// Phase 9 — personal change state, qualified analytics, immutable snapshots,
// and durable output delivery.

export type ResearchPortfolioEventStateAction = 'seen' | 'acknowledged' | 'dismissed' | 'undo';

export interface ResearchPortfolioEventRecipientStateDto {
  eventId: string;
  recipientUserId: string;
  revision: number;
  seenAt: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  updatedAt: string;
}

export interface ResearchPortfolioChangeDto extends ResearchPortfolioEventDto {
  state: ResearchPortfolioEventRecipientStateDto | null;
}

export interface UpdateResearchPortfolioEventStateDto {
  action: ResearchPortfolioEventStateAction;
  expectedRevision?: number;
}

export type ResearchPortfolioSubscriptionTargetKind =
  'portfolio' | ResearchPortfolioMemberKind | 'client' | 'rule' | 'review';
export type ResearchPortfolioSubscriptionChannel = 'in_app' | 'email';
export type ResearchPortfolioSubscriptionCadence = 'immediate' | 'daily' | 'weekly';

export interface ResearchPortfolioSubscriptionDto {
  id: string;
  portfolioId: string;
  subscriberUserId: string;
  targetKind: ResearchPortfolioSubscriptionTargetKind;
  targetId: string;
  channel: ResearchPortfolioSubscriptionChannel;
  cadence: ResearchPortfolioSubscriptionCadence;
  active: boolean;
  baselineEventId: string | null;
  baselineRevision: number;
  baselineCompletedAt: string;
  checkpoint: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioSubscriptionDeliveryDto {
  id: string;
  subscriptionId: string;
  eventId: string;
  recipientUserId: string;
  channel: 'in_app' | 'email';
  status:
    'queued' | 'delivered' | 'partial' | 'failed' | 'withheld' | 'cancelled' | 'outcome_unknown';
  attemptNumber: number;
  checkpoint: Readonly<Record<string, unknown>>;
  receipt: Readonly<Record<string, unknown>>;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateResearchPortfolioSubscriptionDto {
  targetKind: ResearchPortfolioSubscriptionTargetKind;
  targetId: string;
  channel: ResearchPortfolioSubscriptionChannel;
  cadence: ResearchPortfolioSubscriptionCadence;
}

export interface UpdateResearchPortfolioSubscriptionDto {
  active?: boolean;
  channel?: ResearchPortfolioSubscriptionChannel;
  cadence?: ResearchPortfolioSubscriptionCadence;
}

export interface ResearchPortfolioFinancialBasisDto {
  requestEdition: string | null;
  fundingFiscalYear: number;
  stage: string;
  metric: 'funding' | 'quantity' | 'unit_cost';
  unit: 'usd_millions' | 'units' | 'usd_millions_per_unit';
  currency: 'USD';
  priceBasis: string | null;
  knownAt: string | null;
}

export type ResearchPortfolioContributionDisposition =
  | 'included'
  | 'excluded'
  | 'overlap'
  | 'incompatible'
  | 'missing'
  | 'unavailable'
  | 'withheld'
  /**
   * The subject has no funding basis at all (a tracked bill). Distinct from
   * 'unavailable' (a funding reader failed) and from a zero figure.
   */
  | 'not_applicable';

export interface ResearchPortfolioContributionDto {
  contributionId: string;
  memberId: string;
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label: string | null;
  basis: ResearchPortfolioFinancialBasisDto | null;
  value: string | null;
  disposition: ResearchPortfolioContributionDisposition;
  /** Absent in legacy v1 snapshots; never infer qualification from value alone. */
  sourceDisposition?: 'observed' | 'missing' | 'partial' | 'unavailable' | 'withheld' | null;
  reason: string;
  sourceObservationId: string | null;
  sourceRevisionIds: readonly string[];
  evidence: readonly Readonly<Record<string, unknown>>[];
  dedupKey: string | null;
  overlapsContributionId: string | null;
}

export interface ResearchPortfolioCompatibleTotalDto {
  basis: ResearchPortfolioFinancialBasisDto;
  value: string;
  contributionCount: number;
}

export interface ResearchPortfolioAnalyticsDto {
  portfolioId: string;
  portfolioRevision: number;
  calculationVersion: 'research-portfolio-analytics-v1' | 'research-portfolio-analytics-v2';
  availability: 'available' | 'partial' | 'unavailable';
  totals: readonly ResearchPortfolioCompatibleTotalDto[];
  contributions: readonly ResearchPortfolioContributionDto[];
  coverage: {
    eligibleMembers: number;
    supportedMembers: number;
    includedContributions: number;
    excludedContributions: number;
    overlapContributions: number;
    unavailableMembers: number;
    /** Included subjects with no funding basis (bills). Never counted as zero or unavailable. */
    notApplicableMembers?: number;
  };
  limitations: readonly string[];
  observedAt: string;
  readAt: string;
}

export interface CreateResearchPortfolioSnapshotDto {
  operationKey: string;
  name: string;
  expectedRevision: number;
  basis?: Partial<ResearchPortfolioFinancialBasisDto>;
}

export interface ResearchPortfolioSnapshotSummaryDto {
  id: string;
  portfolioId: string;
  operationKey: string;
  contentHash: string;
  name: string;
  portfolioRevision: number;
  createdByUserId: string;
  calculationVersion: string;
  capturedAt: string;
}

export interface ResearchPortfolioSnapshotDto extends ResearchPortfolioSnapshotSummaryDto {
  basis: Readonly<Record<string, unknown>>;
  membership: readonly ResearchPortfolioMemberDto[];
  projection: ResearchPortfolioAnalyticsDto;
  versions: {
    structure: Readonly<Record<string, unknown>>;
    rules: readonly Readonly<Record<string, unknown>>[];
    decisions: readonly Readonly<Record<string, unknown>>[];
    templates: readonly Readonly<Record<string, unknown>>[];
    taxonomy: readonly Readonly<Record<string, unknown>>[];
    labels: readonly Readonly<Record<string, unknown>>[];
    sources: readonly Readonly<Record<string, unknown>>[];
  };
  limitations: readonly string[];
  clientAccessRequirements: readonly string[];
  observedAt: string;
  readAt: string;
}

export type ResearchPortfolioOutputStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'outcome_unknown';

export interface CreateResearchPortfolioOutputDto {
  operationKey: string;
  snapshotId?: string | null;
  selectedSections?: readonly string[];
  includeSourceAppendix?: boolean;
  format: 'csv';
  deadlineAt?: string | null;
}

export interface ResearchPortfolioOutputRequestDto {
  id: string;
  portfolioId: string;
  snapshotId: string | null;
  operationKey: string;
  requestHash: string;
  selectedSections: readonly string[];
  includeSourceAppendix: boolean;
  format: 'csv';
  status: ResearchPortfolioOutputStatus;
  requestedByUserId: string;
  requestedAt: string;
  deadlineAt: string | null;
}

export interface ResearchPortfolioOutputAttemptDto {
  id: string;
  attemptNumber: number;
  operationKey: string;
  action: 'process' | 'cancel' | 'retry' | 'reconcile';
  outcome: ResearchPortfolioOutputStatus;
  checkpoint: Readonly<Record<string, unknown>>;
  receipt: Readonly<Record<string, unknown>>;
  errorCode: string | null;
  actorUserId: string;
  startedAt: string;
  completedAt: string | null;
}

export interface ResearchPortfolioOutputArtifactDto {
  id: string;
  contentHash: string;
  byteSize: number;
  mediaType: 'text/csv';
  fileName: string;
  createdAt: string;
  downloadPath: string;
}

export interface ResearchPortfolioOutputJobDto {
  id: string;
  requestId: string;
  operationKey: string;
  status: ResearchPortfolioOutputStatus;
  attemptCount: number;
  deadlineAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  request: ResearchPortfolioOutputRequestDto;
  attempts: readonly ResearchPortfolioOutputAttemptDto[];
  artifact: ResearchPortfolioOutputArtifactDto | null;
}

export interface ResearchPortfolioClientFileReceiptDto {
  /** Original caller operation identity; legacy receipts may omit it. */
  operationKey?: string;
  id: string;
  artifactId: string;
  clientId: string;
  attachmentId: string;
  attachmentName: string;
  lifecycleStatus: string | null;
  scanStatus: string | null;
  indexedAt: string | null;
  openPath: string;
  createdAt: string;
}

export interface SaveResearchPortfolioOutputToClientDto {
  operationKey: string;
  clientId: string;
}

// Phase 11 — bookmarks, fit, review notes, watch-conversion, operations, tour state

export type ResearchPortfolioBookmarkTargetKind =
  'member' | 'snapshot' | 'evidence' | 'review' | 'import' | 'output' | 'other';

export interface ResearchPortfolioBookmarkDto {
  id: string;
  portfolioId: string;
  userId: string;
  targetKind: ResearchPortfolioBookmarkTargetKind;
  targetId: string;
  label: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResearchPortfolioBookmarkDto {
  idempotencyKey: string;
  targetKind: ResearchPortfolioBookmarkTargetKind;
  targetId: string;
  label?: string | null;
  note?: string | null;
}

export interface UpdateResearchPortfolioBookmarkDto {
  label?: string | null;
  note?: string | null;
}

export type ResearchPortfolioFitAvailability = 'available' | 'partial' | 'unavailable';

export interface ResearchPortfolioFitBasisDto {
  calculationVersion: string;
  scoreBasis: 'direct_qualified_pe_association_share';
  portfolioRevision: number;
  ruleVersionIds: readonly string[];
  capabilityFingerprint: string;
  sourceBasisFingerprint: string;
  basisFingerprint: string;
  totalIncludedMemberCount: number;
  supportedMemberCount: number;
  matchedMemberCount: number;
  limitations: readonly string[];
}

export interface ResearchPortfolioFitResultDto {
  portfolioId: string;
  clientId: string;
  clientName: string;
  fitScore: number | null;
  /** Percentage (0..100) under the explicitly supported direct PE basis. */
  availability?: ResearchPortfolioFitAvailability;
  versionId?: string;
  basis?: ResearchPortfolioFitBasisDto;
  memberMatches?: readonly {
    memberId: string;
    targetKind: ResearchPortfolioMemberKind;
    targetId: string;
    matched: boolean | null;
    capabilityIds: readonly string[];
    reasons: readonly string[];
    sourceDocumentIds: readonly string[];
  }[];
  ruleMatches: readonly {
    ruleVersionId: string;
    matched: boolean;
    reason: string;
    result?: 'match' | 'nonmatch' | 'unknown';
  }[];
  refreshedAt: string | null;
}

export interface ResearchPortfolioFitDto {
  portfolioId: string;
  clientFits: readonly ResearchPortfolioFitResultDto[];
  availability?: ResearchPortfolioFitAvailability;
  limitations?: readonly string[];
  calculatedAt: string;
}

export interface ResearchPortfolioReviewNoteDto {
  id: string;
  reviewId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

export interface CreateResearchPortfolioReviewNoteDto {
  idempotencyKey: string;
  expectedRevision: number;
  body: string;
}

export interface ApplyResearchPortfolioWatchConversionDto {
  idempotencyKey: string;
  expectedRevision: number;
  previewHash: string;
  selectedWatchIds: readonly string[];
}

export interface ResearchPortfolioWatchConversionPreviewDto {
  portfolioId: string;
  expectedRevision: number;
  previewHash: string;
  legacyWatches: number;
  convertibleWatches: number;
  alreadyConverted: number;
  limitations: readonly string[];
  previewItems: readonly {
    watchId: string;
    userId: string;
    channel: string;
    legacyKind: string;
    targetKind: 'program_element';
    targetId: string;
    active: false;
    reason: 'convertible' | 'already_subscribed' | 'not_included_member';
    willConvert: boolean;
  }[];
}

export interface ResearchPortfolioWatchConversionResultDto {
  portfolioId: string;
  idempotencyKey: string;
  revision: number;
  convertedCount: number;
  skippedCount: number;
  limitations: readonly string[];
}

export type ResearchPortfolioOperationKind =
  'import' | 'recompute' | 'output' | 'snapshot' | 'client_filing';
export type ResearchPortfolioOperationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown'
  | 'paused';

export interface ReconcileResearchPortfolioOperationDto {
  /** Required only for an original actor's client-filing checkpoint. */
  operationKey?: string;
}

export interface ResearchPortfolioOperationDto {
  id: string;
  portfolioId: string;
  kind: ResearchPortfolioOperationKind;
  status: ResearchPortfolioOperationStatus;
  actorUserId: string | null;
  domainStatus: string;
  limitations: readonly string[];
  label: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioTourStateDto {
  tourVersion: string;
  status: 'active' | 'dismissed' | 'completed';
  completedAt: string | null;
}

export interface ResearchPortfolioDraftDto {
  artifactId: string;
  portfolioId: string;
  conversationId: string;
  parentArtifactId: string | null;
  title: string;
  kind: 'research_portfolio_brief' | 'research_portfolio_meeting';
  contentType: 'text/markdown';
  bodyText: string;
  reviewStatus: 'unreviewed_draft' | 'unreviewed_edit';
  createdAt: string;
  childVersions: readonly {
    artifactId: string;
    title: string;
    createdAt: string;
    reviewStatus: 'unreviewed_draft' | 'unreviewed_edit';
  }[];
  childVersionsHasMore: boolean;
}

// ---------------------------------------------------------------------------
// Client share links: PIN-protected, one-week, frozen dashboard at a Capiro link.
// ---------------------------------------------------------------------------

export type ResearchPortfolioDashboardWidgetKind =
  | 'header'
  | 'key_totals'
  | 'funding_table'
  | 'client_fit'
  | 'changes'
  | 'subjects'
  | 'sources'
  | 'snapshot_comparison'
  | 'commentary'
  | 'image';

/** One widget on the 12-column grid. Positions and sizes are grid units. */
export interface ResearchPortfolioDashboardWidgetDto {
  id: string;
  kind: ResearchPortfolioDashboardWidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  settings: Readonly<Record<string, unknown>>;
}

export interface ResearchPortfolioDashboardLayoutDto {
  columns: 12;
  widgets: readonly ResearchPortfolioDashboardWidgetDto[];
  /** Widget ids in the order a phone (single column) shows them. */
  phoneOrder: readonly string[];
}

export interface ResearchPortfolioDashboardDesignDto {
  id: string;
  portfolioId: string;
  name: string;
  version: number;
  layout: ResearchPortfolioDashboardLayoutDto;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveResearchPortfolioDashboardDesignDto {
  name: string;
  layout: ResearchPortfolioDashboardLayoutDto;
  /** Required when updating an existing design; the save is refused if it is stale. */
  expectedVersion?: number;
}

export interface ResearchPortfolioShareSettingsDto {
  portfolioId: string;
  enabled: boolean;
  /** The workspace-wide switch (FR-16.42); when off, nothing can be published or opened. */
  tenantEnabled: boolean;
  pinSet: boolean;
  pinUpdatedAt: string | null;
  activeLinkCount: number;
  updatedAt: string | null;
}

export interface EnableResearchPortfolioSharingDto {
  /** 6 to 12 digits. Stored only as a salted hash. */
  pin: string;
}

export interface ChangeResearchPortfolioSharePinDto {
  pin: string;
}

export type ResearchPortfolioShareLinkStatus = 'active' | 'expired' | 'revoked';

export interface ResearchPortfolioShareLinkDto {
  id: string;
  portfolioId: string;
  clientId: string;
  clientName: string;
  snapshotId: string;
  snapshotName: string;
  designId: string | null;
  designVersion: number;
  branding: boolean;
  status: ResearchPortfolioShareLinkStatus;
  publishedByUserId: string;
  publishedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
  failedPinAttempts: number;
  lockedUntil: string | null;
}

export interface PreviewResearchPortfolioShareDto {
  snapshotId: string;
  designId: string;
  clientId: string;
  branding: boolean;
}

export interface PublishResearchPortfolioShareLinkDto extends PreviewResearchPortfolioShareDto {
  operationKey: string;
  previewHash: string;
  expectedDesignVersion: number;
}

export interface ResearchPortfolioSharePreviewDto {
  dashboard: ResearchPortfolioShareDashboardDto;
  previewHash: string;
  designVersion: number;
  logoUrl: string | null;
}

/** The token is returned once; the server keeps only its hash. */
export interface ResearchPortfolioShareLinkPublishedDto {
  link: ResearchPortfolioShareLinkDto;
  token: string | null;
  replayed: boolean;
}

/** Everything a recipient can see. Built at publish time and never recomputed. */
export interface ResearchPortfolioShareDashboardDto {
  schemaVersion: 1;
  portfolioName: string;
  portfolioPurpose: string | null;
  asOf: string;
  preparedFor: { clientName: string };
  branding: { firmName: string; logoAvailable: boolean } | null;
  layout: ResearchPortfolioDashboardLayoutDto;
  data: {
    totals: readonly ResearchPortfolioCompatibleTotalDto[];
    contributions: readonly ResearchPortfolioContributionDto[];
    coverage: ResearchPortfolioAnalyticsDto['coverage'];
    limitations: readonly string[];
    subjects: readonly {
      id: string;
      targetKind: ResearchPortfolioMemberKind;
      targetId: string;
      label: string | null;
      disposition: ResearchPortfolioMemberDisposition;
    }[];
    sources: readonly ({ id: string } & Partial<
      import('./defense-research.js').DefenseEvidenceRefDto
    >)[];
    clientFit: {
      availability: ResearchPortfolioFitAvailability;
      fitScore: number | null;
      basis: ResearchPortfolioFitBasisDto | null;
      refreshedAt: string | null;
    } | null;
    changes: readonly {
      id: string;
      eventKind: string;
      occurredAt: string;
      summary: string;
    }[];
    comparison: {
      snapshotId: string;
      snapshotName: string;
      capturedAt: string;
      totals: readonly ResearchPortfolioCompatibleTotalDto[];
    } | null;
  };
  snapshot: {
    id: string;
    name: string;
    capturedAt: string;
    portfolioRevision: number;
    calculationVersion: string;
  };
  publishedAt: string;
  expiresAt: string;
}

export interface ResearchPortfolioSharePinDto {
  pin: string;
}

export interface ResearchPortfolioShareViewSessionDto {
  viewToken: string;
  expiresAt: string;
}

export interface ResearchPortfolioShareAvailabilityDto {
  available: boolean;
}

export interface ResearchPortfolioShareViewDto {
  viewToken: string;
}

/** Workspace-wide client sharing switch, administered by tenant administrators. */
export interface ResearchPortfolioTenantSharingDto {
  enabled: boolean;
  activeLinkCount: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export interface SetResearchPortfolioTenantSharingDto {
  enabled: boolean;
}

/** A short-lived signed address of the firm logo for a recipient; null when branding is off or no logo exists. */
export interface ResearchPortfolioShareLogoDto {
  url: string | null;
}
