/** Wire-safe Research Portfolio contracts shared by the main API and web. */
export type ResearchPortfolioMode = 'manual' | 'rules' | 'hybrid';
export type ResearchPortfolioLifecycle = 'active' | 'archived';
export type ResearchPortfolioGrantRole = 'owner' | 'editor' | 'viewer';
export type ResearchPortfolioMemberKind =
  | 'program'
  | 'program_element'
  | 'project'
  | 'budget_line'
  | 'award';
export type ResearchPortfolioMemberDisposition = 'included' | 'candidate' | 'withdrawn' | 'excluded' | 'unresolved';
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
  | 'rule_published';

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
  revision: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPortfolioEventDto {
  id: string;
  eventKind: ResearchPortfolioEventKind;
  aggregateRevision: number;
  actorUserId: string;
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

export type ResearchPortfolioRuleOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'exists' | 'gte' | 'lte';
export type ResearchPortfolioRuleScalar = string | number | boolean;
export type ResearchPortfolioRuleNode =
  | { kind: 'and' | 'or'; clauses: readonly ResearchPortfolioRuleNode[] }
  | { kind: 'not'; clause: ResearchPortfolioRuleNode }
  | { kind: 'condition'; field: string; operator: ResearchPortfolioRuleOperator; value: ResearchPortfolioRuleScalar | readonly ResearchPortfolioRuleScalar[] };

export interface ResearchPortfolioRuleCandidateDto {
  targetKind: ResearchPortfolioMemberKind;
  targetId: string;
  label?: string | null;
  facts: Readonly<Record<string, unknown>>;
  completeness?: 'complete' | 'partial' | 'unavailable' | 'unresolved' | 'insufficient_qualification';
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
  disposition: 'added' | 'retained' | 'withdrawn' | 'accepted_nonmatch' | 'manual_override' | 'candidate' | 'unknown' | 'not_evaluated';
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
  recompute: { operationId: string; status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled' } | null;
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
