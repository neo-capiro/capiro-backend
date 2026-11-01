import { ForbiddenException, Injectable } from '@nestjs/common';
import { privateSqlNormalizationRuntimeAdmitted } from './private-sql-normalization-runtime.js';
import { PRIVATE_SQL_NORMALIZATION_PINS } from './private-sql-normalization-pins.js';
import { PrismaClient } from '@prisma/client';
import { PublicSqlError, type CompiledPublicSql } from './sql-query-compiler.js';
import { normalizeSqlRow, type SqlResultRow } from './sql-query-output.js';

export const PRIVATE_SQL_VIEW_NAMES = Object.freeze([
  'client_objectives',
  'client_activity',
  'client_team_roster',
  'client_account_owners',
  'client_targets',
  'client_profiles',
  'client_profile_codes',
  'client_people',
  'client_contacts',
  'client_engagement_tasks',
  'client_action_items',
  'client_tracked_bills',
  'client_outreach_campaigns',
  'client_campaign_recipients',
  'client_meetings',
] as const);
type Scope =
  | { readonly scopeKind: 'general'; readonly clientId: null }
  | { readonly scopeKind: 'client'; readonly clientId: string }
  | {
      readonly scopeKind: 'research_portfolio';
      readonly clientId: null;
      readonly researchPortfolioId: string;
    }
  | {
      readonly scopeKind: 'classic_outreach';
      readonly clientId: string | null;
      readonly classicOutreachIds: readonly string[];
    };
/** Internal input from the canonical current owner, never a model/HTTP authorization claim.
 * assertCurrent closes over that owner's admitted receipt and checks its current expect fields. */
export type PrivateSqlExecutionContext = Readonly<{
  tenantId: string;
  actorId: string;
  deadlineMs: number;
  assertCurrent(): Promise<void>;
}> &
  Scope;

const unavailable = () =>
  new PublicSqlError('SOURCE_UNAVAILABLE', 'Private data is currently unavailable.');
const timeout = () =>
  new PublicSqlError(
    'QUERY_TIMEOUT',
    'The private query exceeded its execution time limit. Narrow the query.',
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy selectors before any await. This validates an internal contract; UUIDs do not establish authority. */
export function capturePrivateSqlContext(
  context: PrivateSqlExecutionContext,
): PrivateSqlExecutionContext {
  if (!context) throw new ForbiddenException('Private query access unavailable');
  const { tenantId, actorId, deadlineMs, assertCurrent, scopeKind, clientId } = context;
  const selectors = context as PrivateSqlExecutionContext & {
    researchPortfolioId?: unknown;
    classicOutreachIds?: unknown;
  };
  const portfolioId = selectors.researchPortfolioId;
  const ids = selectors.classicOutreachIds;
  const canonicalUuid = (value: unknown): value is string =>
    typeof value === 'string' && uuid.test(value);
  const validScope =
    (scopeKind === 'general' &&
      clientId === null &&
      portfolioId === undefined &&
      ids === undefined) ||
    (scopeKind === 'client' &&
      canonicalUuid(clientId) &&
      portfolioId === undefined &&
      ids === undefined) ||
    (scopeKind === 'research_portfolio' &&
      clientId === null &&
      canonicalUuid(portfolioId) &&
      ids === undefined) ||
    (scopeKind === 'classic_outreach' &&
      (clientId === null || canonicalUuid(clientId)) &&
      portfolioId === undefined &&
      Array.isArray(ids) &&
      ids.length <= 100 &&
      Array.from(ids).every(canonicalUuid) &&
      new Set(ids).size === ids.length);
  if (
    !canonicalUuid(tenantId) ||
    !canonicalUuid(actorId) ||
    !Number.isSafeInteger(deadlineMs) ||
    typeof assertCurrent !== 'function' ||
    !validScope
  )
    throw new ForbiddenException('Private query access unavailable');
  const common = { tenantId, actorId, deadlineMs, assertCurrent };
  if (scopeKind === 'research_portfolio')
    return Object.freeze({
      ...common,
      scopeKind,
      clientId: null,
      researchPortfolioId: portfolioId as string,
    });
  if (scopeKind === 'classic_outreach')
    return Object.freeze({
      ...common,
      scopeKind,
      clientId,
      classicOutreachIds: Object.freeze([...(ids as string[])]),
    });
  return Object.freeze({ ...common, scopeKind, clientId }) as PrivateSqlExecutionContext;
}

// Fixed DB admission, independent of model SQL. View definitions remain the schema owner's
// reviewed migration; this checks their required owner/options and effective privilege boundary.
const PRIVATE_SQL_ROLE_CHECK = `WITH reader AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'capiro_private_query_ro'
), owner AS (
  SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'capiro_private_projection_owner'
), views AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'meri_private' AND c.relname IN ('visible_clients','client_objectives','client_activity','client_team_roster','client_account_owners','client_targets','client_profiles','client_profile_codes','client_people','client_contacts','client_engagement_tasks','client_action_items','client_tracked_bills','client_outreach_campaigns','client_campaign_recipients','client_meetings','research_portfolios','research_portfolio_members','classic_outreach_records')
), sources AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN
    ('tenants','tenant_memberships','clients','client_memory_access','client_objectives','client_activity',
     'client_ordered_owners','client_team_members','client_targets','client_people','engagement_contacts','engagement_tasks','action_recommendation','tracked_bill','engagement_campaigns','engagement_campaign_recipients','meetings','engagement_connections','meeting_attendees','research_portfolios','research_portfolio_grants','research_portfolio_members','outreach_records')
), source_columns (table_name, columns) AS (
  VALUES ('action_recommendation', ARRAY['action_type','client_id','created_at','deadline','deadline_source','delta_id','dismissal_reason','district_key','id','issue_title','outcome','owner_user_id','pe_code','priority','program_id','recommended_action','status','suggested_artifact_type','tenant_id','uncertainty','updated_at','what_changed','why_it_matters']::text[]),
    ('client_activity', ARRAY['actor_user_id','body','client_id','created_at','created_by_user_id','due_at','id','kind','metadata_jsonb','occurred_at','person_id','pinned','settled_at','source_id','source_type','tenant_id','title','updated_at']::text[]),
    ('client_memory_access', ARRAY['client_id','tenant_id','user_id']::text[]),
    ('client_objectives', ARRAY['ask_type','client_id','client_request_id','created_at','created_by_user_id','deleted_at','government_problem','id','limits','minimum_win','outcome','owner_user_id','ready_at','review_requested_at','status','tenant_id','updated_at','version']::text[]),
    ('client_ordered_owners', ARRAY['client_id','rank','tenant_id','user_id']::text[]),
    ('client_people', ARRAY['client_id','created_at','email','hierarchy_level','id','last_contact','name','notes','phone','placement_confidence','placement_source','reports_to_person_id','review_required','role','tenant_id','title','updated_at']::text[]),
    ('client_targets', ARRAY['added_at','added_by_user_id','chamber','client_id','committee','id','member_id','member_name','party','source','source_directory','staff_kind','state','tenant_id','tier']::text[]),
    ('client_team_members', ARRAY['client_id','created_at','id','role','tenant_id','user_id']::text[]),
    ('clients', ARRAY['account_owner_version','applicant_types','cage_code','canonical_entity_id','created_at','created_by_user_id','description','id','issue_codes','lda_client_ids','memory_wall','naics_codes','name','primary_contact_email','primary_contact_name','primary_contact_phone','product_description','profile_status','profile_type','psc_codes','sector_tag','set_aside_certifications','status','submission_tracks','tenant_id','uei','updated_at','website']::text[]),
    ('engagement_campaign_recipients', ARRAY['campaign_id','created_at','email','id','name','office','sent_at','status','tenant_id','title']::text[]),
    ('engagement_campaigns', ARRAY['body','client_id','created_at','created_by_user_id','id','name','sent_at','status','subject','tenant_id','type','updated_at']::text[]),
    ('engagement_connections', ARRAY['created_by_user_id','id','tenant_id']::text[]),
    ('engagement_contacts', ARRAY['acquisition_personnel_id','client_id','created_at','directory_entry_id','email','full_name','id','organization','phone','source','tenant_id','title','updated_at']::text[]),
    ('engagement_tasks', ARRAY['client_id','created_at','created_by_user_id','description','due_date','id','owner_user_id','source_type','status','tenant_id','title','updated_at']::text[]),
    ('meeting_attendees', ARRAY['email','meeting_id','tenant_id']::text[]),
    ('meetings', ARRAY['association_signals_jsonb','client_id','connection_id','created_at','created_by_user_id','ends_at','id','is_internal','is_virtual','organizer_email','provider','source','starts_at','status','subject','tenant_id','time_zone','updated_at']::text[]),
    ('outreach_records', ARRAY['body','client_id','created_at','created_by_user_id','deleted_at','id','opened_in_email_at','recipient_count','sent_at','status','subject','tenant_id','title','type','updated_at']::text[]),
    ('research_portfolio_grants', ARRAY['portfolio_id','principal_user_id','role','tenant_id']::text[]),
    ('research_portfolio_members', ARRAY['created_at','created_by_user_id','disposition','id','label','origin','portfolio_id','reason','resolved_at','revision','target_id','target_kind','tenant_id','updated_at','updated_by_user_id']::text[]),
    ('research_portfolios', ARRAY['archived_at','created_at','id','lifecycle','mode','name','purpose','revision','tenant_id','updated_at']::text[]),
    ('tenant_memberships', ARRAY['role','status','tenant_id','user_id']::text[]),
    ('tenants', ARRAY['id','status']::text[]),
    ('tracked_bill', ARRAY['bill_id','client_id','created_at','created_by','id','note','source','tenant_id','updated_at']::text[])
), normalization_function AS (
  SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'meri_private' AND p.proname = 'ecmascript_contact_key_u17_v1'
), identity_sources AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'users'
)
SELECT (
  current_user = reader.rolname AND session_user = reader.rolname
  AND current_setting('transaction_read_only') = 'on'
  AND current_setting('app.bypass_rls', true) = 'off'
  AND reader.rolcanlogin AND NOT owner.rolcanlogin
  AND NOT reader.rolsuper AND NOT reader.rolbypassrls AND NOT reader.rolcreaterole
  AND NOT reader.rolcreatedb AND NOT reader.rolreplication AND NOT reader.rolinherit
  AND NOT owner.rolsuper AND NOT owner.rolbypassrls AND NOT owner.rolcreaterole
  AND NOT owner.rolcreatedb AND NOT owner.rolreplication AND NOT owner.rolinherit
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member IN (reader.oid, owner.oid))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba IN (reader.oid, owner.oid))
  AND NOT pg_catalog.has_database_privilege(reader.oid, current_database(), 'CREATE')
  AND NOT pg_catalog.has_database_privilege(owner.oid, current_database(), 'CREATE')
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'meri_private'
    AND n.nspowner = owner.oid AND pg_catalog.has_schema_privilege(reader.oid, n.oid, 'USAGE'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
    WHERE n.nspowner = reader.oid OR (n.nspowner = owner.oid AND n.nspname <> 'meri_private')
      OR pg_catalog.has_schema_privilege(reader.oid, n.oid, 'CREATE')
      OR (n.nspname <> 'meri_private' AND pg_catalog.has_schema_privilege(owner.oid, n.oid, 'CREATE')))
  AND pg_catalog.current_setting('server_encoding') = 'UTF8'
  AND (SELECT count(*) FROM normalization_function) = 1
  AND NOT EXISTS (SELECT 1 FROM normalization_function f
    JOIN pg_catalog.pg_language l ON l.oid = f.prolang
    WHERE f.proowner <> owner.oid OR f.prokind <> 'f' OR l.lanname <> 'plpgsql'
      OR f.proargtypes <> '25'::pg_catalog.oidvector OR f.prorettype <> 25
      OR f.pronargs <> 1 OR f.pronargdefaults <> 0 OR f.provariadic <> 0
      OR f.proargnames IS DISTINCT FROM ARRAY['input']::text[]
      OR f.proargmodes IS NOT NULL OR f.proallargtypes IS NOT NULL OR f.prosupport <> 0
      OR f.probin IS NOT NULL OR f.prosqlbody IS NOT NULL
      OR f.prosecdef OR f.proleakproof OR f.proretset OR NOT f.proisstrict
      OR f.provolatile <> 'i' OR f.proparallel <> 's'
      OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex')
        <> '${PRIVATE_SQL_NORMALIZATION_PINS.functionBodySha256}'
      OR NOT pg_catalog.has_function_privilege(reader.oid, f.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
        WHERE a.grantee NOT IN (reader.oid, owner.oid) OR a.privilege_type <> 'EXECUTE'
          OR (a.grantee = reader.oid AND a.is_grantable)))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = reader.oid
    OR (p.proowner = owner.oid AND p.oid NOT IN (SELECT oid FROM normalization_function)))
  AND (SELECT count(*) FROM views) = 19
  AND NOT EXISTS (SELECT 1 FROM views v WHERE v.relkind <> 'v' OR v.relowner <> owner.oid
    OR NOT coalesce(v.reloptions @> ARRAY['security_barrier=true'], false)
    OR coalesce(v.reloptions @> ARRAY['security_invoker=true'], false)
    OR (v.relname <> 'visible_clients' AND NOT pg_catalog.has_table_privilege(reader.oid, v.oid, 'SELECT')))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = reader.oid
    OR (c.relowner = owner.oid AND c.oid NOT IN (SELECT oid FROM views)))
  AND (SELECT count(*) FROM sources) = 23
  AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.relkind NOT IN ('r','p')
    OR NOT s.relrowsecurity OR NOT s.relforcerowsecurity OR s.relowner IN (reader.oid, owner.oid)
    OR pg_catalog.has_table_privilege(owner.oid, s.oid, 'SELECT')
    OR NOT EXISTS (SELECT 1 FROM source_columns expected WHERE expected.table_name = s.relname
      AND (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = s.oid
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY(expected.columns)
        AND pg_catalog.has_column_privilege(owner.oid, s.oid, a.attnum, 'SELECT')) = pg_catalog.cardinality(expected.columns)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = s.oid
        AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attname = ANY(expected.columns)
        AND pg_catalog.has_column_privilege(owner.oid, s.oid, a.attnum, 'SELECT'))))
  -- users is global, without tenant RLS. The view owner receives only the four
  -- identity columns required by assigned-client roster/owner projections.
  AND (SELECT count(*) FROM identity_sources) = 1
  AND NOT EXISTS (SELECT 1 FROM identity_sources s WHERE s.relkind <> 'r'
    OR s.relrowsecurity OR s.relowner IN (reader.oid, owner.oid)
    OR pg_catalog.has_table_privilege(owner.oid, s.oid, 'SELECT')
    OR (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = s.oid
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN ('id','email','first_name','last_name')
      AND pg_catalog.has_column_privilege(owner.oid, s.oid, a.attnum, 'SELECT')) <> 4
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = s.oid
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname NOT IN ('id','email','first_name','last_name')
      AND pg_catalog.has_column_privilege(owner.oid, s.oid, a.attnum, 'SELECT')))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    AND (pg_catalog.has_table_privilege(reader.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(reader.oid, c.oid, 'INSERT,UPDATE,REFERENCES')
      OR (c.oid NOT IN (SELECT oid FROM views) AND
        (pg_catalog.has_table_privilege(owner.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(owner.oid, c.oid, 'INSERT,UPDATE,REFERENCES')))
      OR ((pg_catalog.has_table_privilege(reader.oid, c.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege(reader.oid, c.oid, 'SELECT'))
        AND c.oid NOT IN (SELECT oid FROM views WHERE relname <> 'visible_clients'))
      OR ((pg_catalog.has_table_privilege(owner.oid, c.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege(owner.oid, c.oid, 'SELECT'))
        AND c.oid NOT IN (SELECT oid FROM views UNION ALL SELECT oid FROM sources UNION ALL SELECT oid FROM identity_sources)))
  )
) AS allowed FROM reader CROSS JOIN owner`;

function remaining(context: PrivateSqlExecutionContext): number {
  const ms = context.deadlineMs - Date.now();
  if (ms <= 0) throw timeout();
  return ms;
}

function databaseFailure(error: unknown): PublicSqlError {
  if (error instanceof PublicSqlError)
    return error.code === 'SOURCE_UNAVAILABLE' ? unavailable() : error;
  const code = (error as { code?: unknown; meta?: { code?: unknown } } | null)?.code;
  const dbCode = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
  if (code === 'P2028' || ['57014', '55P03'].includes(String(dbCode ?? code))) return timeout();
  if (
    ['42803', '42804', '42883', '42P08', '42P18', '22P02', '22003', '22007', '22008', '22023'].includes(
      String(dbCode ?? code),
    )
  )
    return new PublicSqlError(
      'INVALID_QUERY',
      'Check field and parameter types, supported aggregates, and GROUP BY fields.',
    );
  return unavailable();
}

@Injectable()
export class PrivateSqlDbService {
  private client: PrismaClient | null = null;

  private getClient(): PrismaClient {
    if (this.client) return this.client;
    const env = process.env;
    const host = env.PRIVATE_QUERY_DB_HOST,
      port = env.PRIVATE_QUERY_DB_PORT;
    const user = env.PRIVATE_QUERY_DB_USER,
      password = env.PRIVATE_QUERY_DB_PASSWORD,
      name = env.PRIVATE_QUERY_DB_NAME;
    const sslmode = env.PRIVATE_QUERY_DB_SSLMODE ?? 'require';
    if (
      !host ||
      /[\s/?#@]/.test(host) ||
      !port ||
      !/^\d+$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65535 ||
      user !== 'capiro_private_query_ro' ||
      !password ||
      password === '***' ||
      !name ||
      !/^[a-zA-Z0-9_-]+$/.test(name) ||
      !['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)
    )
      throw unavailable();
    // No app, public analytics or promoter credential fallback. No connection is created at import.
    const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}?schema=meri_private&sslmode=${sslmode}&connection_limit=3`;
    this.client = new PrismaClient({ datasources: { db: { url } } });
    return this.client;
  }

  async assertAvailable(context: PrivateSqlExecutionContext): Promise<void> {
    await this.runChecked(null, context);
  }

  /** Only the private compiler wrapper supplies SQL; context comes from the canonical current owner. */
  async runPrivateSql(
    compiled: CompiledPublicSql,
    context: PrivateSqlExecutionContext,
  ): Promise<SqlResultRow[]> {
    return this.runChecked(compiled, context);
  }

  private async runChecked(
    compiled: CompiledPublicSql | null,
    supplied: PrivateSqlExecutionContext,
  ): Promise<SqlResultRow[]> {
    const context = capturePrivateSqlContext(supplied);
    const allowedRelations: readonly string[] =
      context.scopeKind === 'research_portfolio'
        ? ['research_portfolios', 'research_portfolio_members']
        : context.scopeKind === 'classic_outreach'
          ? ['classic_outreach_records']
          : PRIVATE_SQL_VIEW_NAMES;
    if (
      compiled &&
      (!compiled.relationsUsed.length ||
        compiled.relationsUsed.some((name) => !allowedRelations.includes(name)))
    )
      throw unavailable();
    remaining(context);
    if (!privateSqlNormalizationRuntimeAdmitted()) throw unavailable();
    remaining(context);
    await context.assertCurrent();
    const budget = remaining(context);
    let result: SqlResultRow[];
    try {
      const rows = await this.getClient().$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog');
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = '${Math.min(8000, remaining(context))}ms'`,
          );
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
          await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
          await tx.$executeRawUnsafe("SET LOCAL timezone = 'UTC'");
          await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls = 'off'");
          await tx.$executeRawUnsafe(
            `SELECT pg_catalog.set_config('app.current_tenant', $1, true),
          pg_catalog.set_config('app.current_user', $2, true), pg_catalog.set_config('app.meri_query_scope', $3, true),
          pg_catalog.set_config('app.meri_query_client', $4, true),
          pg_catalog.set_config('app.meri_query_portfolio', $5, true),
          pg_catalog.set_config('app.meri_query_classic_ids', $6, true)`,
            context.tenantId,
            context.actorId,
            context.scopeKind,
            context.clientId ?? '',
            context.scopeKind === 'research_portfolio' ? context.researchPortfolioId : '',
            context.scopeKind === 'classic_outreach' ? context.classicOutreachIds.join(',') : '',
          );
          const admitted = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(PRIVATE_SQL_ROLE_CHECK);
          if (admitted.length !== 1 || admitted[0]?.allowed !== true) throw unavailable();
          remaining(context);
          return compiled
            ? tx.$queryRawUnsafe<Record<string, unknown>[]>(compiled.sql, ...compiled.params)
            : [];
        },
        { timeout: Math.min(10000, budget), maxWait: Math.min(2000, budget) },
      );
      result = compiled ? rows.map((row) => normalizeSqlRow(row, compiled.columns)) : [];
    } catch (error) {
      throw databaseFailure(error);
    }
    // Fresh owner observation after the read transaction, never its older MVCC snapshot.
    remaining(context);
    await context.assertCurrent();
    remaining(context);
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
      this.client = null;
    }
  }
}
