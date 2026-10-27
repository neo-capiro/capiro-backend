import { ENGAGEMENT_WORK_QUERY_RELATIONS } from './engagement-work-query-projections.js';
import { CLIENT_PROFILE_QUERY_RELATIONS } from '../clients/client-profile-query-projections.js';
import { compilePublicSql, compileScopedSql } from '../meri/analytics/sql-query-compiler.js';
import { normalizeSqlRow } from '../meri/analytics/sql-query-output.js';

const relations = [...CLIENT_PROFILE_QUERY_RELATIONS, ...ENGAGEMENT_WORK_QUERY_RELATIONS];
const query = (sql: string, parameters: Array<string | number | boolean | null> = []) =>
  compileScopedSql({ sql, parameters, rowLimit: 2 }, relations);

describe('saved engagement work SQL descriptions', () => {
  it('supports task workload grouping with optional assignee and date filters', () => {
    const result = query(
      'SELECT t.client_id, t.status, COUNT(*) AS tasks FROM client_engagement_tasks t WHERE t.owner_user_id=$1 AND t.due_date<$2 GROUP BY t.client_id, t.status',
      ['11111111-1111-4111-8111-111111111111', '2026-10-27'],
    );
    expect(result.params).toEqual(['11111111-1111-4111-8111-111111111111', '2026-10-27']);
    expect(result.sql).toMatch(/CAST\(\$1 AS UUID\)/i);
    expect(result.sql).toMatch(/CAST\(\$2 AS DATE\)/i);
    expect(result.columns[2]).toEqual({ name: 'tasks', type: 'integer', nullable: false });
  });

  it('returns full task and action text with exact priority/null semantics', () => {
    const task = query(
      'SELECT t.description, t.owner_user_id, t.due_date FROM client_engagement_tasks t',
    );
    const description = 'Follow through with full source-owned text. '.repeat(300);
    expect(
      normalizeSqlRow({ description, owner_user_id: null, due_date: null }, task.columns),
    ).toEqual({ description, owner_user_id: null, due_date: null });
    const action = query(
      'SELECT a.recommended_action, a.priority, a.uncertainty FROM client_action_items a',
    );
    expect(
      normalizeSqlRow(
        { recommended_action: description, priority: '0', uncertainty: null },
        action.columns,
      ),
    ).toEqual({ recommended_action: description, priority: '0', uncertainty: null });
    expect(() =>
      normalizeSqlRow(
        { recommended_action: description, priority: 0, uncertainty: null },
        action.columns,
      ),
    ).toThrow();
  });

  it('enforces the complete campaign/recipient relationship and preserves full body', () => {
    const result = query(
      'SELECT c.id, c.body, COUNT(r.id) AS recipients FROM client_outreach_campaigns c LEFT JOIN client_campaign_recipients r ON r.client_id=c.client_id AND r.campaign_id=c.id GROUP BY c.id, c.body',
    );
    expect(result.sql).toContain('"meri_private"."client_campaign_recipients"');
    const body = '🙂 longer than the old outreach excerpt '.repeat(100);
    expect(normalizeSqlRow({ id: 'campaign', body, recipients: '2' }, result.columns).body).toBe(
      body,
    );
    expect(() =>
      query(
        'SELECT c.id FROM client_outreach_campaigns c JOIN client_campaign_recipients r ON r.campaign_id=c.id',
      ),
    ).toThrow();
    expect(() =>
      query(
        'SELECT c.id FROM client_outreach_campaigns c JOIN client_campaign_recipients r ON r.email=c.name',
      ),
    ).toThrow();
  });

  it('supports deduplicated parent counts without treating recipient rows as campaigns', () => {
    const result = query(
      'SELECT c.client_id, COUNT(DISTINCT c.id) AS campaigns FROM client_outreach_campaigns c JOIN client_campaign_recipients r ON c.client_id=r.client_id AND c.id=r.campaign_id GROUP BY c.client_id',
    );
    expect(result.columns[1]).toEqual({ name: 'campaigns', type: 'integer', nullable: false });
  });

  it('keeps public bill and Clerk creator identities as text rather than UUIDs', () => {
    const result = query(
      'SELECT b.id, b.note FROM client_tracked_bills b WHERE b.bill_id=$1 AND b.created_by=$2',
      ['119-hr-1234', 'user_clerkCreator'],
    );
    expect(result.sql).toMatch(/CAST\(\$1 AS TEXT\)/i);
    expect(result.sql).toMatch(/CAST\(\$2 AS TEXT\)/i);
    expect(result.params).toEqual(['119-hr-1234', 'user_clerkCreator']);
  });

  it.each(['meeting_id', 'contact_id', 'mail_thread_id', 'source_id'])(
    'does not grant unchecked task linkage field %s',
    (name) => expect(() => query(`SELECT t.${name} FROM client_engagement_tasks t`)).toThrow(),
  );
  it.each(['evidence_jsonb', 'target_audience_jsonb', 'confidence_jsonb'])(
    'retains action field %s at the typed source-validation owner',
    (name) => expect(() => query(`SELECT a.${name} FROM client_action_items a`)).toThrow(),
  );
  it.each([
    'outreach_records',
    'outreach_send_intents',
    'planner_tasks',
    'research_portfolios',
    'users',
    'congress_bill',
  ])('does not widen into excluded source %s', (name) =>
    expect(() => query(`SELECT x.id FROM ${name} x`)).toThrow(),
  );

  it('keeps private fields out of the public registry and preserves query bounds', () => {
    expect(() =>
      compilePublicSql({ sql: 'SELECT t.id FROM client_engagement_tasks t', parameters: [] }),
    ).toThrow();
    const result = query(
      'SELECT c.client_id, c.id FROM client_outreach_campaigns c WHERE c.client_id=$1 AND c.id>$2 ORDER BY c.id LIMIT 1',
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    );
    expect(result.sqlLimit).toBe(1);
    expect(result.rowLimit).toBe(2);
  });

  it('deeply freezes the finite business scope and its limitations', () => {
    expect(ENGAGEMENT_WORK_QUERY_RELATIONS.map((r) => r.name)).toEqual([
      'client_engagement_tasks',
      'client_action_items',
      'client_tracked_bills',
      'client_outreach_campaigns',
      'client_campaign_recipients',
    ]);
    for (const relation of ENGAGEMENT_WORK_QUERY_RELATIONS) {
      expect(relation.fields.length).toBeLessThanOrEqual(32);
      expect(relation.freshness.sourceAsOf).toBeNull();
      expect(relation.freshness.sourceVersion).toBeNull();
      expect(() => (relation.fields as PublicField[]).pop()).toThrow();
    }
  });
});
type PublicField = (typeof ENGAGEMENT_WORK_QUERY_RELATIONS)[number]['fields'][number];
