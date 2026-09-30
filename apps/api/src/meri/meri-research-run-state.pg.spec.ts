import { PGlite } from '@electric-sql/pglite';
import {
  ACTIVE_RESEARCH_RUN_FENCE_SQL,
  ACTIVE_RESEARCH_RUN_UPDATE_SQL,
  researchLeaseCutoff,
  type ResearchRunState,
} from './meri-research-run-state.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OLD_RUN_ID = '44444444-4444-4444-8444-444444444444';
const NEW_RUN_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-28T12:00:00.000Z');

function run(overrides: Partial<ResearchRunState> = {}): ResearchRunState {
  return {
    id: OLD_RUN_ID,
    leaseEpoch: 7,
    eventSequence: 0,
    phase: 'research',
    status: 'running',
    stage: 'Gathering evidence',
    startedAt: '2026-09-28T11:55:00.000Z',
    heartbeatAt: NOW.toISOString(),
    ...overrides,
  };
}

function updateValues(
  expectedMetadata: Record<string, unknown>,
  nextMetadata: Record<string, unknown>,
  owner: ResearchRunState,
  nextStatus = 'failed',
) {
  return [
    SESSION_ID,
    TENANT_ID,
    USER_ID,
    'researching',
    owner.id,
    owner.leaseEpoch,
    owner.phase,
    researchLeaseCutoff(NOW).toISOString(),
    JSON.stringify(expectedMetadata),
    JSON.stringify(nextMetadata),
    nextStatus,
    NOW.toISOString(),
  ];
}

describe('active research run PostgreSQL CAS', () => {
  jest.setTimeout(30_000);
  const db = new PGlite();

  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE clio_research_sessions (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        user_id uuid NOT NULL,
        status text NOT NULL,
        report_artifact_id uuid,
        metadata_jsonb jsonb NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec('TRUNCATE clio_research_sessions');
  });

  async function insert(metadata: Record<string, unknown>, status = 'researching') {
    await db.query(
      `INSERT INTO clio_research_sessions
       (id, tenant_id, user_id, status, metadata_jsonb, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::timestamptz)`,
      [SESSION_ID, TENANT_ID, USER_ID, status, JSON.stringify(metadata), NOW.toISOString()],
    );
  }

  it('rejects every expired-owner terminal or fence mutation without a successor', async () => {
    const expired = run({ heartbeatAt: '2026-09-28T11:57:59.999Z' });
    const current = { run: expired, durableStepReceipts: [] };
    const failed = { ...current, run: { ...expired, status: 'failed', failureReason: 'late' } };
    await insert(current);

    const terminal = await db.query(
      ACTIVE_RESEARCH_RUN_UPDATE_SQL,
      updateValues(current, failed, expired),
    );
    const fence = await db.query(ACTIVE_RESEARCH_RUN_FENCE_SQL, [
      SESSION_ID,
      TENANT_ID,
      USER_ID,
      'researching',
      expired.id,
      expired.leaseEpoch,
      expired.phase,
      researchLeaseCutoff(NOW).toISOString(),
      '2026-09-28T12:00:01.000Z',
    ]);
    const stored = await db.query<{ metadata_jsonb: typeof current; updated_at: string }>(
      'SELECT metadata_jsonb, updated_at::text FROM clio_research_sessions WHERE id=$1::uuid',
      [SESSION_ID],
    );

    expect(terminal.rows).toHaveLength(0);
    expect(fence.rows).toHaveLength(0);
    expect(stored.rows[0]?.metadata_jsonb).toEqual(current);
    expect(new Date(stored.rows[0]!.updated_at).toISOString()).toBe(NOW.toISOString());
  });

  it('rejects the replaced owner while admitting the current id and epoch', async () => {
    const replacement = run({ id: NEW_RUN_ID, leaseEpoch: 8 });
    const current = { run: replacement };
    await insert(current);

    const stale = await db.query(
      ACTIVE_RESEARCH_RUN_UPDATE_SQL,
      updateValues(current, { run: { ...run(), status: 'failed' } }, run()),
    );
    const next = { run: { ...replacement, status: 'failed' as const } };
    const active = await db.query(
      ACTIVE_RESEARCH_RUN_UPDATE_SQL,
      updateValues(current, next, replacement),
    );

    expect(stale.rows).toHaveLength(0);
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0]).toMatchObject({ metadata_jsonb: next });
  });

  it('allows exactly one concurrent update from the same JSON condition', async () => {
    const owner = run();
    const current = { run: owner, durableStepReceipts: [] };
    await insert(current);
    const left = {
      run: { ...owner, eventSequence: 1 },
      durableStepReceipts: [{ receiptId: 'left', sequence: 1 }],
    };
    const right = {
      run: { ...owner, eventSequence: 1 },
      durableStepReceipts: [{ receiptId: 'right', sequence: 1 }],
    };

    const results = await Promise.all([
      db.query(ACTIVE_RESEARCH_RUN_UPDATE_SQL, updateValues(current, left, owner, 'researching')),
      db.query(ACTIVE_RESEARCH_RUN_UPDATE_SQL, updateValues(current, right, owner, 'researching')),
    ]);
    const stored = await db.query<{ metadata_jsonb: typeof left | typeof right }>(
      'SELECT metadata_jsonb FROM clio_research_sessions WHERE id=$1::uuid',
      [SESSION_ID],
    );

    expect(results.map((result) => result.rows.length).sort()).toEqual([0, 1]);
    expect([left, right]).toContainEqual(stored.rows[0]?.metadata_jsonb);
  });
});
