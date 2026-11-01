import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { PrivateSqlRelation } from '../meri/analytics/private-sql-query.js';

/** The DB-owned view implements ownMeetingWhere + clientAssociatedMeetingWhere
 * against current visible_clients. The compiler never substitutes a raw meeting table. */
const field = (
  name: string,
  type: PublicSqlField['type'],
  nullable: boolean,
  description: string,
  parameterType?: 'UUID',
): PublicSqlField => Object.freeze({ name, type, nullable, description,
  ...(parameterType ? { parameterType } : {}) });

export const CLIENT_MEETING_QUERY_RELATION: PrivateSqlRelation = Object.freeze({
  name: 'client_meetings',
  table: 'client_meetings',
  schema: 'meri_private',
  description: 'Saved actor-owned meetings associated with current visible clients by the canonical meeting reader rules.',
  fields: Object.freeze([
    field('client_id', 'string', false, 'Current visible association client ID; include it in client joins.', 'UUID'),
    field('id', 'string', false, 'Saved Meeting row ID, not an external calendar or hearing identifier.', 'UUID'),
    field('subject', 'string', false, 'Full saved meeting subject.'),
    field('starts_at', 'timestamp', false, 'Saved start instant; filter explicitly for the intended window.'),
    field('ends_at', 'timestamp', false, 'Saved end instant.'),
    field('time_zone', 'string', true, 'Saved IANA time zone; null is unspecified.'),
    field('status', 'string', false, 'Saved calendar status; deleted records are excluded, other statuses retained.'),
    field('source', 'string', false, 'Saved meeting source kind, not upstream completeness evidence.'),
    field('is_internal', 'boolean', false, 'Saved internal classification; an explicit client association may still be internal.'),
    field('is_virtual', 'boolean', false, 'Saved virtual classification, not a recording or join permission.'),
    field('provider', 'string', true, 'Saved provider name, not a connected-account grant.'),
    field('created_at', 'timestamp', false, 'Saved record creation instant.'),
    field('updated_at', 'timestamp', false, 'Saved record update instant, not the provider synchronization cursor.'),
  ]),
  primaryKey: Object.freeze(['client_id', 'id']),
  relationships: Object.freeze([Object.freeze({
    fields: Object.freeze(['client_id']),
    referencedRelation: 'client_profiles',
    referencedFields: Object.freeze(['client_id']),
    cardinality: 'many_to_one' as const,
    integrity: 'enforced' as const,
  })]),
  grain: 'One actor-owned saved meeting/client association per client_id and id. One meeting may be associated with multiple visible clients.',
  coverage: Object.freeze({
    basis: 'authorized_client_records' as const,
    limitations: Object.freeze([
      'Current membership and client walls apply. A meeting must be created by the actor or imported through a connection owned by that actor; shared visibility does not grant another actor access here.',
      'Association follows an explicit client assignment, or the existing noninternal, not manually assigned, client-less contact-email association. Personal meetings without a visible-client association are excluded.',
      'COUNT(*) counts associations; COUNT(DISTINCT id) counts saved meeting records. Separate calendar-import rows are not deduplicated into one real-world meeting.',
      'Deleted meetings are excluded; canceled and other saved statuses remain queryable. No default date window or upstream-completeness claim is applied.',
      'Attendee identities, connection credentials, join links, raw metadata, notes, prep/debrief bodies and recordings remain at their current authorized source readers.',
    ]),
  }),
  freshness: Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null }),
});
