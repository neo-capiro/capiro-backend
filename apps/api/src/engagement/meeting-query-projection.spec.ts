import { CLIENT_MEETING_QUERY_RELATION } from './meeting-query-projection.js';
import { CLIENT_PROFILE_QUERY_RELATIONS } from '../clients/client-profile-query-projections.js';
import { compilePublicSql, compileScopedSql } from '../meri/analytics/sql-query-compiler.js';
import { normalizeSqlRow } from '../meri/analytics/sql-query-output.js';

const relations = [...CLIENT_PROFILE_QUERY_RELATIONS, CLIENT_MEETING_QUERY_RELATION];
const query = (sql: string, parameters: Array<string | number | boolean | null> = []) =>
  compileScopedSql({ sql, parameters, rowLimit: 2 }, relations);

describe('client meeting projection compiler boundary', () => {
  it('compiles a client/time window with exact UUID and timestamp parameters', () => {
    const compiled = query(
      'SELECT m.client_id, m.status, COUNT(*) AS associations FROM client_meetings m WHERE m.client_id=$1 AND m.starts_at>=$2 AND m.starts_at<$3 GROUP BY m.client_id,m.status',
      ['11111111-1111-4111-8111-111111111111', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    );
    expect(compiled.sql).toContain('"meri_private"."client_meetings"');
    expect(compiled.sql).toMatch(/CAST\(\$1 AS UUID\)/i);
    expect(compiled.sql).toMatch(/CAST\(\$2 AS TIMESTAMPTZ\)/i);
    expect(compiled.params).toHaveLength(3);
    expect(compiled.columns[2]).toEqual({ name: 'associations', type: 'integer', nullable: false });
  });

  it('supports distinct saved meeting counts across client associations', () => {
    const compiled = query('SELECT COUNT(DISTINCT m.id) AS meetings FROM client_meetings m');
    expect(normalizeSqlRow({ meetings: '9007199254740993' }, compiled.columns)).toEqual({ meetings: '9007199254740993' });
    expect(() => normalizeSqlRow({ meetings: 9007199254740992 }, compiled.columns)).toThrow();
  });

  it('joins only the declared current client key', () => {
    expect(query('SELECT m.subject,c.client_id FROM client_meetings m JOIN client_profiles c ON m.client_id=c.client_id').relationsUsed)
      .toEqual(['client_profiles', 'client_meetings']);
    expect(() => query('SELECT m.id FROM client_meetings m JOIN client_profiles c ON m.id=c.client_id')).toThrow();
  });

  it('preserves full subject text, boolean and nullable saved fields', () => {
    const compiled = query('SELECT m.subject,m.is_virtual,m.time_zone,m.provider FROM client_meetings m');
    const row = { subject: 'Saved meeting subject 🙂 '.repeat(120), is_virtual: false, time_zone: null, provider: null };
    expect(normalizeSqlRow(row, compiled.columns)).toEqual(row);
    expect(() => normalizeSqlRow({ ...row, is_virtual: 'false' }, compiled.columns)).toThrow();
  });

  it.each(['transcript_s3_key', 'join_link', 'organizer_email', 'raw_jsonb', 'association_signals_jsonb', 'connection_id'])(
    'does not expose separately authorized meeting field %s', field => {
      expect(() => query(`SELECT m.${field} FROM client_meetings m`)).toThrow();
    },
  );

  it.each(['meetings', 'engagement_connections', 'meeting_attendees', 'meeting_notes', 'meeting_preps', 'meeting_debriefs'])(
    'never turns source table %s into a queryable relation', table => {
      expect(() => query(`SELECT m.id FROM ${table} m`)).toThrow();
    },
  );

  it('keeps the new projection private and retains write/system-function refusals', () => {
    expect(() => compilePublicSql({ sql: 'SELECT m.id FROM client_meetings m', parameters: [] })).toThrow();
    expect(() => query('DELETE FROM client_meetings')).toThrow();
    expect(() => query("SELECT set_config('app.current_user','someone',true) FROM client_meetings")).toThrow();
  });
});
