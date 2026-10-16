import type {
  ObjectiveOperationalOwnerVersion,
  ObjectiveOperationalResourceKind,
  ObjectiveOperationalSelection,
  ObjectiveOperationalStrategyType,
} from '@capiro/shared';

/** Decoded public wire types. Tenant, actor and authority never come from a request. */
export type OperationalSelection = ObjectiveOperationalSelection;
export type OperationalOwnerVersion = ObjectiveOperationalOwnerVersion;
export type OperationalResourceKind = Exclude<
  ObjectiveOperationalResourceKind,
  'budget_package' | 'defense_budget_cycle'
>;
export interface OperationalRevision {
  id: string;
  version: number;
}

export interface OperationalCycle {
  fiscalYear: number;
  authorityTrack: string | null;
  basis: 'human_annotation';
  context: { kind: 'budget_package' | 'defense_budget_cycle'; id: string } | null;
}

interface OperationalCommandBase {
  schemaVersion: 1;
  requestId: string;
  clientId: string;
  objectiveId: string;
  expectedObjectiveVersion: number;
  expectedAssociationSetVersion: number;
}
export interface OperationalLinkCommand extends OperationalCommandBase {
  action: 'link';
  resource: { kind: OperationalResourceKind; id: string };
  cycles: OperationalCycle[];
}
export interface OperationalUnlinkCommand extends OperationalCommandBase {
  action: 'unlink';
  associationId: string;
}
export type OperationalCommand = OperationalLinkCommand | OperationalUnlinkCommand;

export type OperationalSectionName = 'strategies' | 'projects' | 'decisions' | 'engagements';
export interface OperationalReadRequest {
  schemaVersion: 1;
  clientId: string;
  objectiveId: string;
  limit: number;
  cursors: Record<OperationalSectionName, string | null>;
}
export interface OperationalReceiptRequest {
  schemaVersion: 1;
  requestId: string;
  clientId: string;
  objectiveId: string;
}
export interface OperationalScope {
  clientId: string;
  objectiveId: string;
  currentRevisionId: string;
  objectiveVersion: number;
  objectiveStatus: 'draft' | 'in_review' | 'ready';
  ownerUserId: string | null;
}

export type OperationalAssociationReceipt = {
  schemaVersion: 1;
  requestId: string;
  clientId: string;
  objectiveId: string;
  commandRevision: OperationalRevision;
  associationLinkedRevision: OperationalRevision;
  associationId: string;
  resultSetVersion: number;
  payloadDigest: string;
  committedAt: string;
} & (
  | { action: 'link'; outcome: 'linked' | 'unchanged' }
  | { action: 'unlink'; outcome: 'unlinked' | 'unchanged' }
);

export type OperationalProvenance =
  | {
      kind: 'manual';
      associationId: string;
      linkedRevision: OperationalRevision;
      linkedAt: string;
      via: OperationalSelection;
    }
  | { kind: 'application_receipt'; receiptId: string; sourceRevision: OperationalRevision };

export interface OperationalResource<
  Kind extends ObjectiveOperationalResourceKind = ObjectiveOperationalResourceKind,
> {
  selection: { kind: Kind; id: string };
  title: string | null;
  ownerVersion: OperationalOwnerVersion;
  observedAt: string;
}
export type OperationalReason =
  | 'association_reader_missing'
  | 'membership_not_established'
  | 'owner_unavailable'
  | 'authorization_limited'
  | 'pagination_drift'
  | 'unsupported_question_lifecycle'
  | 'unsupported_window_metric'
  | 'unsupported_feasibility_metric'
  | 'source_unverifiable';
export type OperationalCoverage =
  'complete' | 'partial' | 'unbound' | 'unavailable' | 'not_implemented';

export interface OperationalStrategyRow {
  resource: OperationalResource<'strategy'>;
  provenance: OperationalProvenance[];
  cycles: OperationalCycle[];
  savedVersions: Array<{
    receiptId: string;
    sourceRevision: OperationalRevision;
    id: string;
    digest: string;
    generatedJobId: string | null;
  }>;
  strategyType: ObjectiveOperationalStrategyType;
}
export interface OperationalProjectRow {
  resource: OperationalResource<'planner_project'>;
  provenance: OperationalProvenance[];
}
export interface OperationalMeetingRow {
  resource: OperationalResource<'meeting'>;
  provenance: OperationalProvenance[];
  startsAt: string;
  endsAt: string | null;
}
export type OperationalDecisionRow =
  | {
      kind: 'planner_approval';
      task: OperationalResource<'planner_task'>;
      approval: 'pending';
      provenance: OperationalProvenance[];
    }
  | {
      kind: 'outreach_proposal';
      session: OperationalResource<'outreach_session'>;
      proposalId: string;
      state: 'pending';
      title: string;
      provenance: OperationalProvenance[];
    };

export type OperationalSection<Row> = { observedAt: string } & (
  | {
      coverage: 'complete';
      snapshotId: string;
      reasons: [];
      total: number;
      nextCursor: string | null;
      items: Row[];
    }
  | {
      coverage: 'partial';
      snapshotId: string | null;
      reasons: OperationalReason[];
      total: null;
      nextCursor: string | null;
      items: Row[];
    }
  | {
      coverage: 'unbound' | 'unavailable' | 'not_implemented';
      snapshotId: null;
      reasons: OperationalReason[];
      total: null;
      nextCursor: null;
      items: [];
    }
);
export interface OperationalQuestionSection {
  observedAt: string;
  snapshotId: null;
  coverage: 'not_implemented' | 'unbound' | 'unavailable';
  reasons: OperationalReason[];
  total: null;
  nextCursor: null;
  items: [];
}
export interface OperationalPlannerMetrics {
  observedAt: string;
  asOf: string;
  coverage: OperationalCoverage;
  reasons: OperationalReason[];
  taskCount: number | null;
  doneCount: number | null;
  overdueCount: number | null;
}
export type OperationalAction =
  | {
      kind: 'edit_objective' | 'request_review' | 'confirm_ready';
      expectedObjectiveVersion: number;
    }
  | {
      kind: 'open_resource';
      resource: OperationalSelection;
      ownerVersion: OperationalOwnerVersion;
      contentView: 'current';
    }
  | { kind: 'review_planner_approval'; taskId: string; taskVersion: number }
  | {
      kind: 'review_outreach_proposal';
      sessionId: string;
      proposalId: string;
      expectedStateVersion: number;
    }
  | {
      kind: 'open_generated_strategy';
      strategyId: string;
      generatedJobId: string;
      strategyVersionId: string;
      strategyVersionDigest: string;
      sourceRevision: OperationalRevision;
      contentView: 'current';
    };

/** The separately owned composite reader is not implemented by this increment. */
export interface OperationalAutomation {
  availability: 'not_implemented' | 'unavailable';
  projection: null;
}
export interface OperationalReadResponse {
  schemaVersion: 1;
  observedAt: string;
  asOf: string;
  projectionDigest: string;
  scope: OperationalScope;
  associationSetVersion: number | null;
  automation: OperationalAutomation;
  sections: {
    strategies: OperationalSection<OperationalStrategyRow>;
    projects: OperationalSection<OperationalProjectRow>;
    decisions: OperationalSection<OperationalDecisionRow>;
    questions: OperationalQuestionSection;
    engagements: OperationalSection<OperationalMeetingRow>;
  };
  plannerMetrics: OperationalPlannerMetrics;
  actions: OperationalAction[];
}

export type OperationalErrorCode =
  | 'MALFORMED_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_AVAILABLE'
  | 'RECEIPT_NOT_AVAILABLE'
  | 'OBJECTIVE_VERSION_CONFLICT'
  | 'ASSOCIATION_VERSION_CONFLICT'
  | 'CURSOR_STALE'
  | 'REQUEST_CONFLICT'
  | 'UNSUPPORTED_RESOURCE'
  | 'OWNER_UNAVAILABLE'
  | 'RECEIPT_UNVERIFIABLE';
export type OperationalError = { schemaVersion: 1; requestId: string | null } & (
  | { status: 400; code: 'MALFORMED_REQUEST'; outcome: 'rejected' }
  | { status: 401; code: 'UNAUTHENTICATED'; outcome: 'rejected' }
  | { status: 403; code: 'FORBIDDEN'; outcome: 'rejected' }
  | { status: 404; code: 'NOT_AVAILABLE' | 'RECEIPT_NOT_AVAILABLE'; outcome: 'unknown' }
  | {
      status: 409;
      code:
        | 'OBJECTIVE_VERSION_CONFLICT'
        | 'ASSOCIATION_VERSION_CONFLICT'
        | 'CURSOR_STALE'
        | 'REQUEST_CONFLICT';
      outcome: 'rejected';
    }
  | { status: 422; code: 'UNSUPPORTED_RESOURCE'; outcome: 'rejected' }
  | { status: 503; code: 'OWNER_UNAVAILABLE' | 'RECEIPT_UNVERIFIABLE'; outcome: 'unknown' }
);
