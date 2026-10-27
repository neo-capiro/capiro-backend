import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { PrivateSqlRelation } from '../meri/analytics/private-sql-query.js';

// Inert owner descriptors. The fixed private registry, grants and RLS prerequisites
// must be composed separately; these descriptions never establish access.
type Name = 'client_profiles' | 'client_profile_codes' | 'client_people' | 'client_contacts';
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
const client = () => uuid('client_id', 'Canonical client ID. Include it in child-record joins.');
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
      'Current nonarchived clients and current wall grants only. SQL filters and row/byte limits do not establish complete client coverage.',
      ...limitations,
    ]),
  });
const freshness = Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null });

const profiles: Relation = Object.freeze({
  name: 'client_profiles',
  table: 'client_profiles',
  schema: 'meri_private',
  description:
    'Saved client business profile scalars from ClientsService.get, with full description and contact text.',
  fields: Object.freeze([
    client(),
    text('name', 'Saved client name.'),
    text('website', 'Saved website; no fetch or verification.', true),
    text('description', 'Full saved description, not a summary.', true),
    text('product_description', 'Full saved product description.', true),
    text('primary_contact_name', 'Saved primary contact name.', true),
    text(
      'primary_contact_email',
      'Saved primary contact email; not an identity-directory lookup.',
      true,
    ),
    text('primary_contact_phone', 'Saved primary contact phone.', true),
    text('status', 'Stored client lifecycle status; archived clients are excluded.'),
    text('sector_tag', 'Stored sector tag.', true),
    text('profile_type', 'Stored profile type, including null.', true),
    text('profile_status', 'Stored profile status, separate from client lifecycle status.'),
    text('uei', 'Stored UEI identifier; leading characters are preserved.', true),
    text('cage_code', 'Stored CAGE identifier.', true),
    uuid(
      'canonical_entity_id',
      'Confirmed saved canonical entity reference; does not grant access to its directory record.',
      true,
    ),
    uuid('created_by_user_id', 'Saved creator UUID; not a joined user profile.', true),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time; not provider freshness.'),
  ]),
  primaryKey: Object.freeze(['client_id']),
  relationships: Object.freeze([]),
  grain: 'One currently visible saved client per client_id.',
  coverage: coverage(
    'Array fields are in client_profile_codes. Empty arrays remain empty; they are not negative eligibility evidence.',
    'Arbitrary intakeData/profileNotes, full capabilities, facilities, submissions and advocacy remain at the existing full paged get_client_context reader. This is not its replacement.',
    'Logo storage/signing and provider sync bookkeeping are not exposed. Saved identity references do not imply a fresh provider match.',
  ),
  freshness,
});

const codes: Relation = Object.freeze({
  name: 'client_profile_codes',
  table: 'client_profile_codes',
  schema: 'meri_private',
  description:
    'Typed saved client array entries, preserving their original order and duplicate entries.',
  fields: Object.freeze([
    client(),
    text(
      'family',
      'One of submission_tracks, issue_codes, naics_codes, psc_codes, applicant_types, set_aside_certifications, lda_client_ids.',
    ),
    field(
      'position',
      'integer',
      false,
      'One-based position within the stored array, transported as an exact integer string.',
    ),
    text(
      'value',
      'Exact saved code/label or decimal-text LDA identifier. No normalization, inference or provider lookup.',
    ),
  ]),
  primaryKey: Object.freeze(['client_id', 'family', 'position']),
  relationships: Object.freeze([parent]),
  grain: 'One stored array element per client_id, family and one-based position.',
  coverage: coverage(
    'Empty arrays yield no child rows; join client_profiles to distinguish visible clients from missing entries. Empty applicant/certification arrays mean unknown, not ineligible.',
    'Codes remain strings; LDA IDs are identifiers, not monetary values. This is saved association state, not current public filing coverage.',
  ),
  freshness: Object.freeze({ field: null, sourceAsOf: null, sourceVersion: null }),
});

const people: Relation = Object.freeze({
  name: 'client_people',
  table: 'client_people',
  schema: 'meri_private',
  description:
    'Saved client people and recorded reporting hierarchy. Read-time title inference remains with ClientPeopleService.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical saved ClientPerson ID.'),
    text('name', 'Full saved name.'),
    text('title', 'Full saved title.', true),
    text('email', 'Saved email.', true),
    text('phone', 'Saved phone.', true),
    text('role', 'Free-text saved relationship role.', true),
    timestamp('last_contact', 'Saved last-contact time.', true),
    text('notes', 'Full saved notes, not an excerpt.', true),
    text(
      'stored_hierarchy_level',
      'Stored hierarchy level; null may mean unplaced or awaiting the existing read-time inference overlay.',
      true,
    ),
    uuid(
      'reports_to_person_id',
      'Saved manager ID within this client; null is no recorded manager.',
      true,
    ),
    text('placement_source', 'Stored auto_title/manual placement source.'),
    field(
      'stored_placement_confidence',
      'decimal',
      true,
      'Stored decimal confidence, preserved exactly; null for a manual placement. Not a current inference score.',
    ),
    field(
      'stored_review_required',
      'boolean',
      false,
      'Saved review flag before any read-time title inference.',
    ),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([
    parent,
    Object.freeze({
      fields: Object.freeze(['client_id', 'reports_to_person_id']),
      referencedRelation: 'client_people',
      referencedFields: Object.freeze(['client_id', 'id']),
      cardinality: 'many_to_one' as const,
      integrity: 'enforced' as const,
    }),
  ]),
  grain:
    'One stored person per canonical id and client_id; duplicate email rows are not deduplicated.',
  coverage: coverage(
    'The canonical people reader overlays never-inferred auto_title rows. Use get_client_context people for that current presentation; stored_* fields deliberately do not claim inferred parity.',
    'No organization-wide identity directory, inferred relationship graph, mail or meeting body access.',
  ),
  freshness,
});

const contacts: Relation = Object.freeze({
  name: 'client_contacts',
  table: 'client_contacts',
  schema: 'meri_private',
  description: 'Saved EngagementContact business fields for currently visible client associations.',
  fields: Object.freeze([
    client(),
    uuid('id', 'Canonical EngagementContact ID; distinct from ClientPerson IDs.'),
    text('full_name', 'Saved full name.', true),
    text('email', 'Saved contact email.', true),
    text('phone', 'Saved phone.', true),
    text('organization', 'Saved organization.', true),
    text('title', 'Saved title.', true),
    text('source', 'Saved contact origin.'),
    text('directory_entry_id', 'Saved external directory identifier; not a UUID or a grant.', true),
    uuid('acquisition_personnel_id', 'Saved acquisition-personnel reference only.', true),
    timestamp('created_at', 'Record creation time.'),
    timestamp('updated_at', 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([parent]),
  grain: 'One saved EngagementContact per id associated with a visible client.',
  coverage: coverage(
    'Null-client contacts are excluded from this client projection. Raw metadata, inferred associations and directory records stay with their existing owners.',
    'No deduplication by display name or email across the two distinct people/contact owners.',
  ),
  freshness,
});

export const CLIENT_PROFILE_QUERY_RELATIONS = Object.freeze([profiles, codes, people, contacts]);
