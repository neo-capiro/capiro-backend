import type { PublishedRelation, SqlColumnType } from './sql-reader-connection.js';
import { SqlQueryError } from './sql-statement-gate.js';
import { CLIENT_MEETING_QUERY_RELATION } from '../../engagement/meeting-query-projection.js';
import { CLASSIC_OUTREACH_QUERY_RELATION } from '../../engagement/classic-outreach-query-projection.js';
import { RESEARCH_PORTFOLIO_QUERY_RELATIONS } from '../../research-portfolios/research-portfolio-query-projections.js';

/** Descriptive domain facts only. SQL text, parameter binding and actual column
 * types remain owned by the single statement gate and PostgreSQL reader. */
export interface PrivateSqlDomainField {
  readonly name: string;
  readonly type: SqlColumnType;
  readonly nullable: boolean;
  readonly description: string;
  readonly parameterType?: 'UUID';
}
export interface PrivateSqlDomainRelation {
  readonly name: string;
  readonly table: string;
  readonly schema: string;
  readonly authorizedUuidField?: string;
  readonly fields: readonly PrivateSqlDomainField[];
  readonly primaryKey: readonly string[];
  readonly relationships: readonly {
    readonly fields: readonly string[];
    readonly referencedRelation: string;
    readonly referencedFields: readonly string[];
    readonly cardinality: 'many_to_one';
    readonly integrity: 'enforced' | 'soft';
  }[];
  readonly description: string;
  readonly grain: string;
  readonly coverage: { readonly basis: string; readonly limitations: readonly string[] };
  readonly freshness: {
    readonly field: string | null;
    readonly sourceAsOf: null;
    readonly sourceVersion: null;
  };
}

const descriptions: readonly PrivateSqlDomainRelation[] = [
  CLIENT_MEETING_QUERY_RELATION,
  CLASSIC_OUTREACH_QUERY_RELATION,
  ...RESEARCH_PORTFOLIO_QUERY_RELATIONS,
];

export function describePrivateSqlDomains(
  surface: readonly PublishedRelation[],
): PublishedRelation[] {
  return surface.map((relation) => {
    const domain = descriptions.find((item) => item.name === relation.name);
    if (!domain) return relation;
    if (
      relation.fields.length !== domain.fields.length ||
      relation.fields.some((field) => !domain.fields.some((item) => item.name === field.name))
    )
      throw new SqlQueryError(
        'SOURCE_UNAVAILABLE',
        'The private source catalog does not match its published domain.',
      );
    return {
      ...relation,
      description: domain.description,
      grain: domain.grain,
      fields: relation.fields.map((field) => ({
        ...field,
        description: domain.fields.find((item) => item.name === field.name)!.description,
      })),
      primaryKey: [...domain.primaryKey],
      relationships: domain.relationships.map((link) => ({
        ...link,
        fields: [...link.fields],
        referencedFields: [...link.referencedFields],
      })),
      coverage: { basis: domain.coverage.basis, limitations: [...domain.coverage.limitations] },
      freshness: { ...domain.freshness },
    };
  });
}
