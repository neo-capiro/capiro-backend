import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { PrivateSqlRelation } from '../meri/analytics/private-sql-query.js';

// The reviewed database views enforce current tenant/member/client/wall scope.
// This metadata describes their business projection; it is not an access policy.
const field = (
  name: string,
  type: PublicSqlField['type'],
  nullable: boolean,
  description: string,
  parameterType?: 'UUID',
): PublicSqlField =>
  Object.freeze({ name, type, nullable, description, ...(parameterType ? { parameterType } : {}) });
const text = (name: string, description: string, nullable = false) =>
  field(name, 'string', nullable, description);
const uuid = (name: string, description: string, nullable = false) =>
  field(name, 'string', nullable, description, 'UUID');
const time = (name: string, description: string, nullable = false) =>
  field(name, 'timestamp', nullable, description);
const flag = (name: string, description: string) => field(name, 'boolean', false, description);

const objective: PrivateSqlRelation = Object.freeze({
  name: 'client_objectives',
  table: 'client_objectives',
  schema: 'meri_private',
  description:
    'Current nondeleted standalone client objectives, including complete stored business fields and readiness. Independent of Strategy goals and advocacy history.',
  fields: Object.freeze([
    uuid('id', 'Canonical client Objective ID; never a Strategy goal or task ID.'),
    uuid('client_id', 'Canonical client ID. Include it when joining activity to an Objective.'),
    uuid(
      'request_id',
      'Original create-request correlation ID, not an approval, permission or current version.',
    ),
    text('outcome', 'Full stored desired outcome, including an empty draft value.'),
    text('government_problem', 'Full stored government problem, including an empty draft value.'),
    text(
      'ask_type',
      'funding, policy_authority, both, protect_funding or meri_propose; null when unselected.',
      true,
    ),
    text('minimum_win', 'Full stored minimum win, including an empty draft value.'),
    text('limits', 'Full stored limits; not a required readiness field.'),
    uuid(
      'owner_user_id',
      'Attributed Objective owner; ownership does not narrow the read ACL.',
      true,
    ),
    uuid('created_by_user_id', 'Attributed creator, not an additional read ACL.'),
    text(
      'status',
      'Stored draft, in_review or ready lifecycle state; independent of the computed readiness checklist.',
    ),
    field(
      'version',
      'integer',
      false,
      'Current Objective optimistic-concurrency version, not a source-universe version.',
    ),
    time('ready_at', 'Stored ready transition time.', true),
    time('review_requested_at', 'Stored review-request transition time.', true),
    time('created_at', 'Stored Objective creation time.'),
    time('updated_at', 'Stored Objective modification time; not proof of source freshness.'),
    flag(
      'readiness_outcome',
      'Outcome has content after the canonical ECMAScript whitespace trim.',
    ),
    flag(
      'readiness_government_problem',
      'Government problem has content after the canonical whitespace trim.',
    ),
    flag('readiness_ask_type', 'Ask type is one of the five supported Objective ask types.'),
    flag('readiness_minimum_win', 'Minimum win has content after the canonical whitespace trim.'),
    field(
      'readiness_completed_fields',
      'integer',
      false,
      'Number of true readiness checklist fields, from zero through four.',
    ),
    field(
      'readiness_required_fields',
      'integer',
      false,
      'Four, matching objectiveReadiness; limits and attribution are not required.',
    ),
    flag(
      'readiness_is_ready',
      'All four checklist fields are complete. This does not change the stored lifecycle status.',
    ),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([]),
  grain: 'One current nondeleted standalone Objective per canonical id, within its client_id.',
  coverage: Object.freeze({
    basis: 'authorized_client_records' as const,
    limitations: Object.freeze([
      'Only currently authorized, nonarchived clients and nondeleted Objectives. General covers the current visible client roster; selected-client scope cannot broaden it.',
      'No automatic-context three-item sample or hidden list cap. Explicit SQL filters/limits and output bounds still apply; returned rows do not establish source-universe completeness.',
      'Create-request hashes, revision history and operational plans/ledgers are not exposed. Current Objective version and readiness do not authorize a write.',
    ]),
  }),
  freshness: Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null }),
});

const activity: PrivateSqlRelation = Object.freeze({
  name: 'client_activity',
  table: 'client_activity',
  schema: 'meri_private',
  description:
    'Recorded client activity rows with complete stored business fields and validated Quick Log details. This is not the mixed Timeline union.',
  fields: Object.freeze([
    uuid('id', 'Canonical recorded activity ID, not a derived Timeline synthetic ID.'),
    uuid('client_id', 'Canonical client ID; use with objective_id for the Objective relationship.'),
    text('kind', 'Stored activity kind, including note, request, decision and commitment.'),
    time('occurred_at', 'Recorded occurrence time; may differ from insertion time.'),
    text('title', 'Full stored title, without an excerpt limit.'),
    text('body', 'Full stored body; null and empty text remain distinct.', true),
    uuid('actor_user_id', 'Attributed actor, not an additional read ACL.', true),
    uuid(
      'person_id',
      'Stored person reference; not evidence of current Directory visibility.',
      true,
    ),
    text(
      'source_type',
      'Stored underlying-record type; does not grant access to that record.',
      true,
    ),
    text(
      'source_id',
      'Stored underlying-record identity; does not grant access to that record.',
      true,
    ),
    flag('pinned', 'Stored activity pin.'),
    time('due_at', 'Stored due time.', true),
    time('settled_at', 'Stored settlement time; null does not imply a due date.', true),
    uuid('created_by_user_id', 'Attributed creator, not an additional read ACL.', true),
    time('created_at', 'Stored row creation time.'),
    time(
      'updated_at',
      'Stored row modification observation; this is not a version or concurrency token.',
    ),
    text(
      'origin',
      'Always recorded. Derived meeting, document, outreach and mail Timeline items are excluded.',
    ),
    text('direction', 'Validated Quick Log we_owe or they_owe, otherwise null.', true),
    text(
      'counterparty',
      'Validated manually entered label, preserved verbatim; not a Directory identity.',
      true,
    ),
    uuid('objective_id', 'Validated historical Objective reference; may be unavailable now.', true),
    field(
      'objective_version',
      'integer',
      true,
      'Validated historical Objective version selected when the activity was recorded.',
    ),
    uuid(
      'objective_revision_id',
      'Validated historical Objective revision ID; not a current revision or read authorization.',
      true,
    ),
    text(
      'objective_availability',
      'current when the visible nondeleted same-client Objective has the recorded version; changed for a different version; unavailable when absent; null without a valid reference.',
      true,
    ),
  ]),
  primaryKey: Object.freeze(['id']),
  relationships: Object.freeze([
    Object.freeze({
      fields: Object.freeze(['client_id', 'objective_id']),
      referencedRelation: 'client_objectives',
      referencedFields: Object.freeze(['client_id', 'id']),
      cardinality: 'many_to_one' as const,
      integrity: 'soft' as const,
    }),
  ]),
  grain: 'One stored client activity row per canonical id, within its client_id.',
  coverage: Object.freeze({
    basis: 'authorized_client_records' as const,
    limitations: Object.freeze([
      'Stored client_activity rows only. No derived Timeline meetings, attachments, outreach drafts or mail threads, and no hidden first-500 Timeline union.',
      'Malformed or legacy Quick Log metadata yields null detail fields as in projectActivityDetails; unrelated metadata is never exposed.',
      'Objective linkage is historical and soft. Use a LEFT JOIN on both client_id and objective_id to retain unavailable references; never infer current status from a recorded version.',
      'Underlying person/source IDs are references only. Their owners still enforce their own visibility. Query filters, row limits and byte truncation do not establish complete client history.',
    ]),
  }),
  freshness: Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null }),
});

/** Fixed two-view catalog; callers cannot add fields, relations or policy predicates. */
export const CLIENT_QUERY_RELATIONS: readonly PrivateSqlRelation[] = Object.freeze([
  objective,
  activity,
]);
