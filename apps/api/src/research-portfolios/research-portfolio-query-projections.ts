import type { PublicSqlField } from '../meri/analytics/public-sql-registry.js';
import type { SqlCompilerRelation } from '../meri/analytics/sql-query-compiler.js';

type Relation = SqlCompilerRelation & {
  readonly description: string; readonly grain: string;
  readonly coverage: { readonly basis: 'authorized_research_portfolio'; readonly limitations: readonly string[] };
  readonly freshness: { readonly field: 'updated_at'; readonly sourceAsOf: null; readonly sourceVersion: null };
};
const field = (name: string, type: PublicSqlField['type'], nullable: boolean, description: string,
  parameterType?: 'UUID'): PublicSqlField => Object.freeze({ name, type, nullable, description,
  ...(parameterType ? { parameterType } : {}) });
const uuid = (name: string, description: string) => field(name, 'string', false, description, 'UUID');
const text = (name: string, description: string, nullable = false) => field(name, 'string', nullable, description);
const timestamp = (name: string, description: string, nullable = false) => field(name, 'timestamp', nullable, description);
const portfolioId = () => uuid('portfolio_id', 'The one portfolio captured by the owned conversation; a selector cannot change it.');
const freshness = Object.freeze({ field: 'updated_at' as const, sourceAsOf: null, sourceVersion: null });
const coverage = (...limitations: string[]) => Object.freeze({ basis: 'authorized_research_portfolio' as const,
  limitations: Object.freeze([
    'Requires the owned conversation capture and a current explicit viewer-or-better grant. General/client membership alone does not grant access.',
    'Active and archived portfolios are retained. Captured and current revisions are distinct; an old valid capture is not silently repinned.',
    ...limitations,
  ]) });

/** A separate fixed registry; never mixed into General/client_records. DB-owned
 * views must bind the exact captured portfolio and current actor grant. */
export const RESEARCH_PORTFOLIO_QUERY_RELATIONS: readonly Relation[] = Object.freeze([
  Object.freeze({
    name: 'research_portfolios', table: 'research_portfolios', schema: 'meri_private' as const,
    description: 'Current scalar summary of the conversation-captured Research Portfolio.',
    fields: Object.freeze([
      portfolioId(), text('name', 'Current saved portfolio name.'), text('purpose', 'Full saved purpose.', true),
      text('mode', 'Saved portfolio mode.'), text('lifecycle', 'Current active or archived lifecycle.'),
      field('revision', 'integer', false, 'Current portfolio revision; not the original conversation capture revision.'),
      text('my_role', 'Current actor explicit grant role; no other user grants are exported.'),
      timestamp('archived_at', 'Saved archive instant; null when absent.', true),
      timestamp('created_at', 'Portfolio creation instant.'), timestamp('updated_at', 'Saved last update instant.'),
    ]),
    primaryKey: Object.freeze(['portfolio_id']), relationships: Object.freeze([]),
    grain: 'One current authorized captured portfolio per portfolio_id.',
    coverage: coverage('No arbitrary portfolio discovery, grant-table export, artifacts, private client links or source bodies.'),
    freshness,
  }),
  Object.freeze({
    name: 'research_portfolio_members', table: 'research_portfolio_members', schema: 'meri_private' as const,
    description: 'Saved membership scalars in the conversation-captured Research Portfolio.',
    fields: Object.freeze([
      portfolioId(), uuid('id', 'Canonical saved membership row ID.'), text('target_kind', 'Saved target domain kind.'),
      text('target_id', 'Canonical domain identifier as text; public bill identifiers are not coerced to UUID.'),
      text('label', 'Saved membership label.', true), text('disposition', 'Saved included, excluded or unresolved disposition.'),
      text('origin', 'Saved membership origin.'), text('reason', 'Full saved membership reason.', true),
      timestamp('resolved_at', 'Saved resolution instant, not a fresh target lookup.', true),
      field('revision', 'integer', false, 'Current saved membership revision.'),
      uuid('created_by_user_id', 'Saved creator UUID.'), uuid('updated_by_user_id', 'Saved last editor UUID.'),
      timestamp('created_at', 'Membership creation instant.'), timestamp('updated_at', 'Saved last update instant.'),
    ]),
    primaryKey: Object.freeze(['portfolio_id', 'id']),
    relationships: Object.freeze([Object.freeze({ fields: Object.freeze(['portfolio_id']),
      referencedRelation: 'research_portfolios', referencedFields: Object.freeze(['portfolio_id']),
      cardinality: 'many_to_one' as const, integrity: 'enforced' as const })]),
    grain: 'One saved membership per portfolio_id and id; distinct targets retain their target_kind and target_id.',
    coverage: coverage('All current dispositions remain explicit. A saved target reference is not access to its body or proof of current target resolution.',
      'Evidence/unresolved-input JSON, rules, decisions and artifacts are not projected. Any later hydration uses its current source owner.'),
    freshness,
  }),
]);
