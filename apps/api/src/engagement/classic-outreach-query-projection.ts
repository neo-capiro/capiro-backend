import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { SqlCompilerRelation } from '../meri/analytics/sql-query-compiler.js';

const field = (name: string, type: PublicSqlField['type'], nullable: boolean, description: string,
  parameterType?: 'UUID'): PublicSqlField => Object.freeze({ name, type, nullable, description,
  ...(parameterType ? { parameterType } : {}) });

/** Separate creator-owned Classic source. Never appended to client_records. */
export const CLASSIC_OUTREACH_QUERY_RELATION = Object.freeze({
  name: 'classic_outreach_records', table: 'classic_outreach_records', schema: 'meri_private',
  authorizedUuidField: 'id',
  description: 'Saved Classic OutreachRecord scalars under current creator, client and linked-source access.',
  fields: Object.freeze([
    field('id', 'string', false, 'Canonical OutreachRecord ID, not an EngagementCampaign ID.', 'UUID'),
    field('client_id', 'string', true, 'Saved explicit client association; null is personal Classic.', 'UUID'),
    field('type', 'string', false, 'Saved Classic type; internal outreach_v3 records are excluded.'),
    field('status', 'string', false, 'Saved status, not current provider delivery evidence.'),
    field('title', 'string', false, 'Full saved title.'),
    field('subject', 'string', true, 'Full saved subject.'),
    field('body', 'string', true, 'Full saved body under the canonical linked-source guard.'),
    field('recipient_count', 'integer', false, 'Stored recipient count, not a delivery count.'),
    field('sent_at', 'timestamp', true, 'Saved historical sent time; not permission to send.'),
    field('opened_in_email_at', 'timestamp', true, 'Saved email-open action time, not recipient engagement.'),
    field('created_at', 'timestamp', false, 'Record creation time.'),
    field('updated_at', 'timestamp', false, 'Record update time.'),
  ]),
  primaryKey: Object.freeze(['id']), relationships: Object.freeze([]),
  grain: 'One currently accessible, nondeleted actor-created Classic OutreachRecord per id.',
  coverage: Object.freeze({ basis: 'authorized_classic_outreach', limitations: Object.freeze([
    'Complete candidate authorization is bounded to 100 records; a larger universe refuses before querying and requires a narrower client scope.',
    'Current access to every linked client and the latest meeting prep/debrief sources is required. Ambiguous latest children are excluded by the ordinary Classic reader.',
    'Personal Classic explicitly includes client-less records; this is never a client_records General fallback.',
    'Recipients, metadata, stats, linked source bodies and send authority are not exported. Query filters and limits do not establish delivery or upstream completeness.',
  ]) }),
  freshness: Object.freeze({ field: 'updated_at', sourceAsOf: null, sourceVersion: null }),
} satisfies SqlCompilerRelation & { description: string; grain: string; coverage: object; freshness: object });
