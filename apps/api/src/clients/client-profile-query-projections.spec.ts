import { CLIENT_PROFILE_QUERY_RELATIONS } from './client-profile-query-projections.js';
import { compilePublicSql, compileScopedSql } from '../meri/analytics/sql-query-compiler.js';
import { normalizeSqlRow } from '../meri/analytics/sql-query-output.js';

const query = (sql: string, parameters: Array<string | number | boolean | null> = []) =>
  compileScopedSql({ sql, parameters, rowLimit: 2 }, CLIENT_PROFILE_QUERY_RELATIONS);

describe('saved client profile SQL descriptions', () => {
  it('supports a real profile/code join with bound string codes and exact row count', () => {
    const result = query(
      'SELECT p.client_id, p.name, COUNT(*) AS matching_codes FROM client_profiles p JOIN client_profile_codes c ON p.client_id=c.client_id WHERE c.family=$1 AND c.value=$2 GROUP BY p.client_id, p.name ORDER BY p.client_id',
      ['naics_codes', '00123'],
    );
    expect(result.sql).toContain('"meri_private"."client_profiles"');
    expect(result.sql).toContain('"meri_private"."client_profile_codes"');
    expect(result.params).toEqual(['naics_codes', '00123']);
    expect(result.columns[2]).toEqual({ name: 'matching_codes', type: 'integer', nullable: false });
    expect(
      normalizeSqlRow(
        { client_id: 'client', name: 'Saved', matching_codes: '9007199254740993' },
        result.columns,
      ).matching_codes,
    ).toBe('9007199254740993');
  });

  it('preserves full Unicode profile and people text and nullable recorded hierarchy', () => {
    const result = query(
      'SELECT p.description, r.notes, r.stored_hierarchy_level, r.stored_placement_confidence FROM client_profiles p LEFT JOIN client_people r ON p.client_id=r.client_id',
    );
    const description = '保存された製品🙂'.repeat(500);
    expect(
      normalizeSqlRow(
        {
          description,
          notes: 'Full notes',
          stored_hierarchy_level: null,
          stored_placement_confidence: null,
        },
        result.columns,
      ),
    ).toEqual({
      description,
      notes: 'Full notes',
      stored_hierarchy_level: null,
      stored_placement_confidence: null,
    });
    expect(() => query('SELECT p.hierarchy_level FROM client_people p')).toThrow();
  });

  it('requires a complete same-client manager join rather than matching names or only IDs', () => {
    const result = query(
      'SELECT p.id, m.name AS manager_name FROM client_people p LEFT JOIN client_people m ON p.client_id=m.client_id AND p.reports_to_person_id=m.id',
    );
    expect(result.columns[1]).toMatchObject({ name: 'manager_name', nullable: true });
    for (const on of ['p.reports_to_person_id=m.id', 'p.name=m.name']) {
      expect(() =>
        query(`SELECT p.id FROM client_people p JOIN client_people m ON ${on}`),
      ).toThrow();
    }
  });

  it('retains exact saved decimal confidence and keeps directory IDs as text', () => {
    const result = query(
      'SELECT p.stored_placement_confidence FROM client_people p WHERE p.stored_placement_confidence=$1',
      ['0.125'],
    );
    expect(result.params).toEqual(['0.125']);
    expect(result.sql).toMatch(/CAST\(\$1 AS NUMERIC\)/i);
    expect(normalizeSqlRow({ stored_placement_confidence: '0.125' }, result.columns)).toEqual({
      stored_placement_confidence: '0.125',
    });
    expect(() => normalizeSqlRow({ stored_placement_confidence: 0.125 }, result.columns)).toThrow();
    const contact = query('SELECT c.id FROM client_contacts c WHERE c.directory_entry_id=$1', [
      'ocd-person/ABC',
    ]);
    expect(contact.sql).toMatch(/CAST\(\$1 AS TEXT\)/i);
  });

  it('supports explicit stable-key continuation for array entries without inventing OFFSET', () => {
    const result = query(
      'SELECT c.client_id, c.family, c.position, c.value FROM client_profile_codes c WHERE c.client_id=$1 AND c.family=$2 AND c.position>$3 ORDER BY c.position',
      ['11111111-1111-4111-8111-111111111111', 'issue_codes', '200'],
    );
    expect(result.sql).toMatch(/CAST\(\$1 AS UUID\)/i);
    expect(result.sql).toMatch(/CAST\(\$3 AS BIGINT\)/i);
    expect(result.sql).toContain('LIMIT 3');
    expect(() => query('SELECT c.value FROM client_profile_codes c LIMIT 2 OFFSET 2')).toThrow();
  });

  it.each([
    'intake_data_jsonb',
    'logo_s3_key',
    'account_owner_version',
    'metadata_jsonb',
    'clerk_user_id',
  ])('does not expose opaque/internal field %s', (name) => {
    for (const relation of CLIENT_PROFILE_QUERY_RELATIONS)
      expect(() => query(`SELECT r.${name} FROM ${relation.name} r`)).toThrow();
  });

  it('leaves public SQL and raw source-table access unchanged', () => {
    expect(() =>
      compilePublicSql({ sql: 'SELECT p.name FROM client_profiles p', parameters: [] }),
    ).toThrow();
    for (const source of ['users', 'clients', 'engagement_contacts', 'visible_clients'])
      expect(() => query(`SELECT p.id FROM ${source} p`)).toThrow();
  });

  it('freezes finite descriptors without claiming live freshness or inferred completeness', () => {
    expect(CLIENT_PROFILE_QUERY_RELATIONS.map((r) => r.name)).toEqual([
      'client_profiles',
      'client_profile_codes',
      'client_people',
      'client_contacts',
    ]);
    for (const relation of CLIENT_PROFILE_QUERY_RELATIONS) {
      expect(relation.schema).toBe('meri_private');
      expect(relation.fields.length).toBeLessThanOrEqual(32);
      expect(relation.freshness.sourceAsOf).toBeNull();
      expect(relation.freshness.sourceVersion).toBeNull();
      expect(() => Object.assign(relation.fields[0]!, { name: 'tenant_id' })).toThrow();
      expect(() => (relation.coverage.limitations as string[]).pop()).toThrow();
    }
  });
});
