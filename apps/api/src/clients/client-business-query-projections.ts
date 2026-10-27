import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { PrivateSqlRelation } from '../meri/analytics/private-sql-query.js';

// These three owner descriptions are composed only after the private executor's
// fixed view/source set is reviewed and expanded. They do not register or grant access.
type BusinessRelationName = 'client_team_roster' | 'client_account_owners' | 'client_targets';
type BusinessRelation = Omit<PrivateSqlRelation, 'name' | 'table'> & {
  readonly name: BusinessRelationName;
  readonly table: BusinessRelationName;
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
const coverage = (limitations: string[]): BusinessRelation['coverage'] =>
  Object.freeze({
    basis: 'authorized_client_records',
    limitations: Object.freeze([
      'Only current authorized nonarchived clients are visible. Query limits do not establish tenant-wide completeness.',
      ...limitations,
    ]),
  });
const noFreshness = Object.freeze({ field: null, sourceAsOf: null, sourceVersion: null });

const team: BusinessRelation = Object.freeze({
  name: 'client_team_roster',
  table: 'client_team_roster',
  schema: 'meri_private',
  description:
    'Complete saved account team: ranked owners merged once per user with explicit team memberships, as the account-team reader presents them.',
  fields: Object.freeze([
    uuid('client_id', 'Canonical client ID; include it in roster/owner joins.'),
    uuid('user_id', 'Canonical assigned user ID. Assignment confers no client or wall access.'),
    uuid('membership_id', 'Explicit team membership row ID; null for every ranked owner.', true),
    text('email', 'Current assigned user email, including historical inactive ranked owners.'),
    text('first_name', 'Current assigned user first name.', true),
    text('last_name', 'Current assigned user last name.', true),
    text(
      'role',
      'Full free-text explicit team role; null means no stated role, not a missing row.',
      true,
    ),
    field(
      'is_primary_owner',
      'boolean',
      false,
      'True only for rank 1; other ranked owners are false.',
    ),
    field('added_at', 'timestamp', true, 'Team membership creation time; null for ranked owners.'),
    field(
      'owner_rank',
      'integer',
      true,
      'Rank 1 through 4 for an owner; null for team-only members.',
    ),
    field(
      'owner_available',
      'boolean',
      true,
      'Active tenant membership for owners; null for team-only members.',
    ),
  ]),
  primaryKey: Object.freeze(['client_id', 'user_id']),
  relationships: Object.freeze([]),
  grain:
    'One row per (client_id, user_id), even when an owner also has an explicit team membership.',
  coverage: coverage([
    'Owners retain the explicit membership role but have null membership_id and added_at, matching the account-team owner.',
    'Inactive owner names remain in this roster. The separate ordered-owner projection redacts unavailable person fields.',
    'Not a directory of all tenant users and not an access-grant list. No hidden first-page roster sample.',
  ]),
  freshness: noFreshness,
});

const owners: BusinessRelation = Object.freeze({
  name: 'client_account_owners',
  table: 'client_account_owners',
  schema: 'meri_private',
  description:
    'Current ordered account assignments, preserving unavailable historical owners and the ordered-owner reader’s person redaction.',
  fields: Object.freeze([
    uuid('client_id', 'Canonical client ID; include it in owner/roster joins.'),
    field('rank', 'integer', false, 'Canonical rank 1 through 4; not a score.'),
    uuid('user_id', 'Assigned user ID, retained when the historical owner becomes unavailable.'),
    text('label', 'Primary, Secondary, Tertiary or Quaternary for rank 1 through 4.'),
    field(
      'available',
      'boolean',
      false,
      'True only when the assigned user is an active member and has an email.',
    ),
    uuid('person_id', 'Assigned person ID only when available; otherwise null.', true),
    text('email', 'Assigned person email only when available; otherwise null.', true),
    text('first_name', 'Assigned person first name only when available; otherwise null.', true),
    text('last_name', 'Assigned person last name only when available; otherwise null.', true),
    field(
      'assignment_version',
      'integer',
      false,
      'Observed client account-owner version; not authorization or a current write precondition.',
    ),
  ]),
  primaryKey: Object.freeze(['client_id', 'rank']),
  relationships: Object.freeze([
    Object.freeze({
      fields: Object.freeze(['client_id', 'user_id']),
      referencedRelation: 'client_team_roster',
      referencedFields: Object.freeze(['client_id', 'user_id']),
      cardinality: 'many_to_one' as const,
      integrity: 'enforced' as const,
    }),
  ]),
  grain: 'One row per (client_id, rank); each user has at most one rank for a client.',
  coverage: coverage([
    'No assignments means zero rows. Unavailable historical assignments remain present with all person fields null.',
    'The roster relationship is guaranteed by these paired projections, not a database foreign key to a view.',
    'Ownership grants no client access. A query result is a read snapshot, not permission to replace assignments.',
  ]),
  freshness: noFreshness,
});

const targets: BusinessRelation = Object.freeze({
  name: 'client_targets',
  table: 'client_targets',
  schema: 'meri_private',
  description:
    'Full stored client target records and engagement priorities. Directory attributes are saved snapshots, not current representation or enrichment.',
  fields: Object.freeze([
    uuid('id', 'Canonical saved target row ID.'),
    uuid('client_id', 'Canonical client ID.'),
    text(
      'member_id',
      'Directory identifier; may be a congressional, staff or slash-containing state ID. Not a UUID.',
    ),
    text('member_name', 'Stored directory name snapshot.', true),
    text('source_directory', 'Stored congress, state or staff directory discriminator.'),
    text(
      'party',
      'Stored party snapshot; nullable and not a controlled cross-directory enum.',
      true,
    ),
    text(
      'state',
      'Stored state/district snapshot, possibly a named state district; not a two-letter state filter.',
      true,
    ),
    text('chamber', 'Stored chamber snapshot.', true),
    text('committee', 'Stored committee snapshot.', true),
    text(
      'stored_staff_kind',
      'Saved staff classification only; may differ from the freshly resolved Targets UI.',
      true,
    ),
    field(
      'tier',
      'integer',
      true,
      'Stored engagement priority, 1 highest through 3; null is untiered.',
    ),
    text('source', 'Stored manual or meri attribution; not a claim of verified source evidence.'),
    uuid('added_by_user_id', 'Attributed creator, possibly null; no additional read ACL.', true),
    field(
      'added_at',
      'timestamp',
      false,
      'When the target was saved, not directory freshness or a row version.',
    ),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([]),
  grain: 'One saved target row per (client_id, id); (client_id, member_id) is also unique.',
  coverage: coverage([
    'No fresh staff classification or representedFacilities enrichment is performed. Stored values can be stale.',
    'Missing fresh representation is not evidence that no facility is represented; use the canonical Targets reader for that question.',
    'Manual and Meri-added saved rows are included. Recommendations not yet saved are not targets. No hidden list cap.',
  ]),
  freshness: noFreshness,
});

export const CLIENT_BUSINESS_QUERY_RELATIONS: readonly BusinessRelation[] = Object.freeze([
  team,
  owners,
  targets,
]);
