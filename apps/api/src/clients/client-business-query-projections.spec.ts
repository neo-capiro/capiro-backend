import { CLIENT_BUSINESS_QUERY_RELATIONS } from './client-business-query-projections.js';
import { compilePublicSql, compileScopedSql } from '../meri/analytics/sql-query-compiler.js';
import { normalizeSqlRow } from '../meri/analytics/sql-query-output.js';

const query = (sql: string, parameters: Array<string | number | boolean | null> = []) =>
  compileScopedSql({ sql, parameters, rowLimit: 2 }, CLIENT_BUSINESS_QUERY_RELATIONS);

describe('saved client business projections', () => {
  it('compiles useful roster counts with the canonical scoped relation and exact count type', () => {
    const compiled = query(
      'SELECT t.client_id, COUNT(*) AS people FROM client_team_roster t GROUP BY t.client_id ORDER BY t.client_id',
    );
    expect(compiled.sql).toContain('"meri_private"."client_team_roster"');
    expect(compiled.sql).toContain('::text');
    expect(compiled.relationsUsed).toEqual(['client_team_roster']);
    expect(compiled.columns).toEqual([
      { name: 'client_id', type: 'string', nullable: false },
      { name: 'people', type: 'integer', nullable: false },
    ]);
    expect(
      normalizeSqlRow({ client_id: 'client', people: '9007199254740993' }, compiled.columns),
    ).toEqual({ client_id: 'client', people: '9007199254740993' });
    expect(() => normalizeSqlRow({ client_id: 'client', people: 2 }, compiled.columns)).toThrow();
  });

  it('requires the complete declared owner/roster composite join in either predicate order', () => {
    const compiled = query(
      'SELECT o.client_id, o.rank, t.role FROM client_account_owners o LEFT JOIN client_team_roster t ON o.user_id=t.user_id AND o.client_id=t.client_id ORDER BY o.client_id, o.rank',
    );
    expect(compiled.relationsUsed).toEqual(['client_team_roster', 'client_account_owners']);
    expect(compiled.columns.find((column) => column.name === 'role')?.nullable).toBe(true);
    for (const on of ['o.user_id=t.user_id', 'o.client_id=t.client_id']) {
      expect(() =>
        query(`SELECT o.rank FROM client_account_owners o JOIN client_team_roster t ON ${on}`),
      ).toThrow();
    }
  });

  it('binds real UUID assignment keys but keeps external directory IDs as text', () => {
    const owner = query(
      'SELECT o.rank FROM client_account_owners o WHERE o.client_id=$1 AND o.user_id=$2',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    );
    expect(owner.sql).toMatch(/CAST\(\$1 AS UUID\)/i);
    expect(owner.sql).toMatch(/CAST\(\$2 AS UUID\)/i);
    const target = query('SELECT t.id FROM client_targets t WHERE t.member_id=$1', [
      'ocd-person/11111111-1111-4111-8111-111111111111',
    ]);
    expect(target.sql).toMatch(/CAST\(\$1 AS TEXT\)/i);
    expect(target.params[0]).toContain('ocd-person/');
  });

  it('preserves null untiered targets and full stored text without inventing fresh enrichment', () => {
    const compiled = query(
      'SELECT t.member_name, t.state, t.stored_staff_kind, t.tier FROM client_targets t',
    );
    expect(
      normalizeSqlRow(
        { member_name: 'Saved name', state: 'Named district', stored_staff_kind: null, tier: null },
        compiled.columns,
      ),
    ).toEqual({
      member_name: 'Saved name',
      state: 'Named district',
      stored_staff_kind: null,
      tier: null,
    });
    for (const name of ['staff_kind', 'represented_facilities', 'directory_freshness'])
      expect(() => query(`SELECT t.${name} FROM client_targets t`)).toThrow();
  });

  it('keeps the distinct owner/roster nullability and attribution semantics', () => {
    const [team, owners] = CLIENT_BUSINESS_QUERY_RELATIONS;
    const lookup = (relation: typeof team, name: string) =>
      relation!.fields.find((field) => field.name === name)!;
    expect(lookup(team, 'email').nullable).toBe(false);
    expect(lookup(owners, 'email').nullable).toBe(true);
    expect(lookup(team, 'membership_id').nullable).toBe(true);
    expect(lookup(team, 'added_at').nullable).toBe(true);
    expect(lookup(team, 'owner_available').nullable).toBe(true);
    expect(lookup(owners, 'available').nullable).toBe(false);
    expect(lookup(owners, 'assignment_version')).toMatchObject({
      type: 'integer',
      nullable: false,
    });
    const compiled = query(
      'SELECT o.user_id, o.available, o.person_id, o.email FROM client_account_owners o',
    );
    expect(
      normalizeSqlRow(
        { user_id: 'historical', available: false, person_id: null, email: null },
        compiled.columns,
      ),
    ).toEqual({ user_id: 'historical', available: false, person_id: null, email: null });
  });

  it.each(['users', 'client_ordered_owners', 'client_team_members', 'visible_clients'])(
    'does not grant model access to source relation %s',
    (table) => expect(() => query(`SELECT u.id FROM ${table} u`)).toThrow(),
  );

  it.each(['tenant_id', 'clerk_user_id', 'email_signature_html', 'added_by', 'metadata_jsonb'])(
    'does not advertise internal or unrelated source field %s',
    (name) => {
      for (const relation of CLIENT_BUSINESS_QUERY_RELATIONS)
        expect(() => query(`SELECT r.${name} FROM ${relation.name} r`)).toThrow();
    },
  );

  it('does not widen the public registry', () => {
    expect(() =>
      compilePublicSql({ sql: 'SELECT t.id FROM client_targets t', parameters: [] }),
    ).toThrow();
  });

  it('supports bounded keyset continuation without introducing an offset or a cursor owner', () => {
    const compiled = query(
      'SELECT t.client_id, t.user_id FROM client_team_roster t WHERE t.client_id>$1 OR (t.client_id=$1 AND t.user_id>$2) ORDER BY t.client_id, t.user_id',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    );
    expect(compiled.rowLimit).toBe(2);
    expect(compiled.sql).toContain('LIMIT 3');
    expect(() => query('SELECT t.id FROM client_targets t LIMIT 2 OFFSET 1')).toThrow();
  });

  it('deeply freezes the finite owner metadata and publishes no invented freshness', () => {
    expect(CLIENT_BUSINESS_QUERY_RELATIONS.map((relation) => relation.name)).toEqual([
      'client_team_roster',
      'client_account_owners',
      'client_targets',
    ]);
    for (const relation of CLIENT_BUSINESS_QUERY_RELATIONS) {
      expect(relation.table).toBe(relation.name);
      expect(relation.schema).toBe('meri_private');
      expect(relation.fields.length).toBeLessThanOrEqual(32);
      expect(relation.coverage.basis).toBe('authorized_client_records');
      expect(relation.freshness).toEqual({ field: null, sourceAsOf: null, sourceVersion: null });
      expect(Object.hasOwn(relation, 'predicate')).toBe(false);
      expect(() => Object.assign(relation.fields[0]!, { name: 'secret' })).toThrow();
      expect(() => (relation.primaryKey as string[]).pop()).toThrow();
      expect(() => (relation.coverage.limitations as string[]).pop()).toThrow();
      expect(() => Object.assign(relation.freshness, { sourceVersion: 'invented' })).toThrow();
    }
    expect(() => (CLIENT_BUSINESS_QUERY_RELATIONS as unknown[]).pop()).toThrow();
    expect(() =>
      (CLIENT_BUSINESS_QUERY_RELATIONS[1]!.relationships[0]!.fields as string[]).pop(),
    ).toThrow();
  });
});
