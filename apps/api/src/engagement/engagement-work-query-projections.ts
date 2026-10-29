import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { PrivateSqlRelation } from '../meri/analytics/private-sql-query.js';

// Saved-record descriptions only. No send, planner, source grant or live provider
// operation is exposed. Root composes these into the fixed private owner separately.
type Name =
  | 'client_engagement_tasks'
  | 'client_action_items'
  | 'client_tracked_bills'
  | 'client_outreach_campaigns'
  | 'client_campaign_recipients';
type Relation = Omit<PrivateSqlRelation, 'name' | 'table'> & {
  readonly name: Name;
  readonly table: Name;
};
const field = (
  name: string,
  type: PublicSqlField['type'],
  nullable: boolean,
  description: string,
  parameterType?: 'UUID',
): PublicSqlField =>
  Object.freeze({ name, type, nullable, description, ...(parameterType ? { parameterType } : {}) });
const uuid = (name: string, description: string, nullable = false) =>
  field(name, 'string', nullable, description, 'UUID');
const text = (name: string, description: string, nullable = false) =>
  field(name, 'string', nullable, description);
const timestamp = (name: string, description: string, nullable = false) =>
  field(name, 'timestamp', nullable, description);
const client = () => uuid('client_id', 'Canonical current visible client ID; include it in joins.');
const parent = Object.freeze({
  fields: Object.freeze(['client_id']),
  referencedRelation: 'client_profiles',
  referencedFields: Object.freeze(['client_id']),
  cardinality: 'many_to_one' as const,
  integrity: 'enforced' as const,
});
const coverage = (...limitations: string[]): Relation['coverage'] =>
  Object.freeze({
    basis: 'authorized_client_records',
    limitations: Object.freeze([
      'Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.',
      ...limitations,
    ]),
  });
const freshness = Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null });

const tasks: Relation = Object.freeze({
  name: 'client_engagement_tasks',
  table: 'client_engagement_tasks',
  schema: 'meri_private',
  description:
    'Saved client-associated EngagementTask business fields under the current exact task reader client/wall scope.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical EngagementTask ID; never a PlannerTask ID.'),
    text('title', 'Full saved title.'),
    text('description', 'Full saved task body.', true),
    uuid('owner_user_id', 'Saved assignee UUID; null means unassigned.', true),
    field('due_date', 'date', true, 'Saved due date; null is no deadline.'),
    text('status', 'Saved todo/in_progress/blocked/done/canceled status; no open-only default.'),
    text('source_type', 'Saved origin kind; Research Portfolio source rows are excluded.', true),
    uuid('created_by_user_id', 'Saved creator UUID.', true),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([parent]),
  grain: 'One saved client-associated EngagementTask per id and client_id.',
  coverage: coverage(
    'Selected client is fixed by current Core authority. General queries may cover all currently visible clients; use owner_user_id for assigned-to-me filtering, matching the current reader optional assignment filter.',
    'Null-client General tasks and research_portfolio_action tasks are excluded. Q06 PlannerTask is a separate owner and is never included.',
    'Meeting/contact/mail/source linkage IDs and their bodies are omitted; use the exact task reader for its separately checked links and source-change receipt. Saved descriptions are returned as saved.',
  ),
  freshness,
});

const actions: Relation = Object.freeze({
  name: 'client_action_items',
  table: 'client_action_items',
  schema: 'meri_private',
  description:
    'Saved ActionRecommendation business scalars; evidence remains at the exact action-item reader.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical saved ActionRecommendation ID.'),
    text('district_key', 'Saved district key.', true),
    text('pe_code', 'Saved program-element code.', true),
    uuid('program_id', 'Saved program reference, not a source grant.', true),
    uuid('delta_id', 'Saved change reference, not current evidence.', true),
    text('action_type', 'Saved action type.'),
    text('issue_title', 'Full saved issue title.'),
    text('what_changed', 'Full saved change account.'),
    text('why_it_matters', 'Full saved rationale.'),
    text('recommended_action', 'Full saved recommended action.'),
    text('suggested_artifact_type', 'Saved suggested artifact type.', true),
    field('deadline', 'date', true, 'Saved deadline; null is unknown.'),
    text('deadline_source', 'Saved deadline origin.', true),
    uuid('owner_user_id', 'Saved assignee UUID.', true),
    field('priority', 'integer', false, 'Stored integer priority, transported exactly.'),
    text('uncertainty', 'Full saved uncertainty statement.', true),
    text('status', 'Saved workflow status.'),
    text('dismissal_reason', 'Full saved dismissal reason.', true),
    text('outcome', 'Full saved outcome.', true),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([parent]),
  grain: 'One saved ActionRecommendation per id and client_id.',
  coverage: coverage(
    'Target audience, confidence bands and evidence JSON are not exposed as raw JSON. query_action_items supplies complete typed fields and revalidates current nonsuperseded source documents.',
    'These saved assertions are not fresh source evidence or an execution approval. No source document or artifact access is inferred from program/delta references.',
  ),
  freshness,
});

const tracking: Relation = Object.freeze({
  name: 'client_tracked_bills',
  table: 'client_tracked_bills',
  schema: 'meri_private',
  description:
    'Saved manually tracked bill records owned by IntelligenceManualBillTracking, without public bill hydration.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical saved TrackedBill row ID.'),
    text('bill_id', 'Canonical public bill text ID such as 119-hr-1234; not a UUID.'),
    text('note', 'Full saved tracking note.', true),
    text('source', 'Saved tracking origin, including null for legacy rows.', true),
    text('created_by', 'Saved Clerk creator identifier; never an application user UUID.', true),
    timestamp('created_at', 'Tracking record creation time.'),
    timestamp('updated_at', 'Tracking record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([parent]),
  grain:
    'One saved client/bill tracking record per id; source uniqueness is client_id plus bill_id.',
  coverage: coverage(
    'No public bill text/status join or cross-database bridge. Use the canonical public bill reader for current public evidence.',
    'last_seen_* alert reconciliation state is not exposed or presented as source freshness.',
  ),
  freshness,
});

const campaigns: Relation = Object.freeze({
  name: 'client_outreach_campaigns',
  table: 'client_outreach_campaigns',
  schema: 'meri_private',
  description:
    'Saved EngagementCampaign scalar records, matching listCampaigns/getCampaign client visibility, with full saved body.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical EngagementCampaign ID; not an OutreachRecord ID.'),
    uuid(
      'created_by_user_id',
      'Saved campaign creator UUID. The existing campaign read policy is tenant/client-wall scoped, not creator-only.',
    ),
    text('name', 'Full saved campaign name.'),
    text('type', 'Saved campaign type.'),
    text('status', 'Saved campaign status; not a current provider receipt.'),
    text('subject', 'Full saved subject.', true),
    text('body', 'Full saved campaign body, not a 2000-character excerpt.', true),
    timestamp('sent_at', 'Saved sent timestamp; not proof of current delivery.', true),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([parent]),
  grain: 'One client-associated saved EngagementCampaign per id and client_id.',
  coverage: coverage(
    'Null-client campaigns are excluded. Raw sourceContext/metadata, generated artifacts, send intents and provider receipts remain with their owners.',
    'Classic OutreachRecord is a different creator-only owner with linked meeting/prep/debrief and source-grant checks; it is not included here. This relation never supplies send authority.',
  ),
  freshness,
});

const recipients: Relation = Object.freeze({
  name: 'client_campaign_recipients',
  table: 'client_campaign_recipients',
  schema: 'meri_private',
  description:
    'Saved EngagementCampaignRecipient rows joined through their same-tenant visible campaign.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical campaign recipient row ID.'),
    uuid('campaign_id', 'Canonical parent EngagementCampaign ID; join with client_id.'),
    text('name', 'Saved recipient name.', true),
    text('email', 'Saved recipient email; not a generic identity-directory read.'),
    text('title', 'Saved recipient title.', true),
    text('office', 'Saved recipient office.', true),
    text('status', 'Saved recipient status, not fresh provider delivery evidence.'),
    timestamp('sent_at', 'Saved sent timestamp.', true),
    timestamp('created_at', 'Recipient record creation time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([
    parent,
    Object.freeze({
      fields: Object.freeze(['client_id', 'campaign_id']),
      referencedRelation: 'client_outreach_campaigns',
      referencedFields: Object.freeze(['client_id', 'id']),
      cardinality: 'many_to_one' as const,
      integrity: 'enforced' as const,
    }),
  ]),
  grain: 'One saved recipient row per id within its currently visible campaign and client.',
  coverage: coverage(
    'Same-tenant parent linkage is mandatory. Duplicate email/name rows are preserved. Raw metadata and external contact-directory records are excluded.',
    'Joining recipients expands campaign rows; aggregate parents before joining when counting campaigns. Counts of recipients are not delivery counts.',
  ),
  freshness: Object.freeze({ field: 'created_at', sourceAsOf: null, sourceVersion: null }),
});

export const ENGAGEMENT_WORK_QUERY_RELATIONS = Object.freeze([
  tasks,
  actions,
  tracking,
  campaigns,
  recipients,
]);
