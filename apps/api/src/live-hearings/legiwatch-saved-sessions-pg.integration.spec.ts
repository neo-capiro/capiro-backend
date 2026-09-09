/**
 * Executes production discovery AND archive SQL in PostgreSQL. All fixtures are
 * TEMP tables on one connection plus an isolated helper-function schema; no application records are changed. Can also
 * run through a PGlite pg adapter when native PostgreSQL is unavailable.
 */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import { discoverSavedHearingSessions } from './legiwatch-saved-sessions.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const ctx: TenantContext = {
  tenantId: 'tenant-a', userId: 'api-user-a', clerkUserId: 'clerk-a',
  tenantSlug: 'test', role: 'standard_user',
};
const SENATE_RECORDING = 'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/govtaff072926/master.m3u8';

describeDb('saved hearing identity + archive (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let client: PoolClient;
  const functionSchema = `lw_saved_test_${randomUUID().replace(/-/g, '')}`;
  const tx = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...values: unknown[]): Promise<T> =>
      (await client.query(sql, values)).rows as T,
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (transaction: typeof tx) => unknown) => fn(tx)),
    committeeHearing: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (await client.query('SELECT * FROM committee_hearing WHERE id = $1', [where.id])).rows[0] ?? null,
    },
  };
  const service = new LegiWatchWave1Service(
    prisma as unknown as PrismaService, null as never, null as never, null as never,
  );

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    client = await pool.connect();
    await client.query(`
      CREATE TEMP TABLE committee_hearing (
        id text PRIMARY KEY, title text, visibility text DEFAULT 'public', url text,
        chamber text DEFAULT 'Senate', committee_name text DEFAULT 'Oversight',
        committee_system_code text DEFAULT 'ssga00', subcommittee_system_code text,
        date date DEFAULT '2026-07-29', starts_at timestamptz, time text, timezone text,
        location text, event_status text DEFAULT 'completed', type text DEFAULT 'hearing',
        witnesses text[] DEFAULT '{}'
      );
      CREATE TEMP TABLE hearing_stream_candidate (hearing_id text, official_page_url text, media_url text);
      CREATE TEMP TABLE committee_source (source_url text);
      CREATE TEMP TABLE intel_live_hearing_session (
        id text PRIMARY KEY, hearing_id text, tenant_id text, created_by text,
        title text, source_type text DEFAULT 'hearing', source_url text, status text DEFAULT 'ended',
        started_at timestamptz, ended_at timestamptz, created_at timestamptz DEFAULT now()
      );
      CREATE TEMP TABLE intel_transcript_segment (
        id text, tenant_id text, session_id text, is_final boolean DEFAULT true, text_plain text
      );
      CREATE TEMP TABLE intel_live_summary_card (id text, tenant_id text, session_id text, segment_id text);
      CREATE TEMP TABLE public_hearing_capture (
        id text, hearing_id text, domain_status text, actual_end timestamptz, transcript_gap_seconds integer
      );
      CREATE TEMP TABLE official_hearing_transcript (id text, hearing_id text, text text);
      CREATE TEMP TABLE public_hearing_transcript_segment (
        id text, capture_id text, start_ms integer, speaker_label text, text text, sequence integer
      );
      CREATE TEMP TABLE public_hearing_insight (
        id text, hearing_id text, insight_type text, title text, summary text, evidence_text text, sequence integer
      );
      CREATE SCHEMA ${functionSchema};
      SET search_path = ${functionSchema}, pg_temp, public;
      CREATE FUNCTION ${functionSchema}.legiwatch_witness_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE
        AS 'SELECT array_to_string($1, '' '')';
    `);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${functionSchema} CASCADE`);
    client?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await client.query(`TRUNCATE committee_hearing, hearing_stream_candidate, committee_source,
      intel_live_hearing_session, intel_transcript_segment, intel_live_summary_card,
      public_hearing_capture, official_hearing_transcript, public_hearing_transcript_segment,
      public_hearing_insight`);
    await hearing('fauci', 'TESTIMONY OF ANTHONY FAUCI', 'https://congress.gov/hearings/fauci');
    await hearing('other', 'Unrelated proceeding', 'https://senate.gov/hearings/other');
  });

  async function hearing(id: string, title: string, url: string) {
    await client.query('INSERT INTO committee_hearing (id, title, url) VALUES ($1,$2,$3)', [id, title, url]);
  }

  async function session(id: string, opts: {
    hearingId?: string | null; tenant?: string; creator?: string; type?: string; url?: string | null;
  } = {}) {
    await client.query(`INSERT INTO intel_live_hearing_session
      (id, hearing_id, tenant_id, created_by, source_type, source_url, title)
      VALUES ($1,$2,$3,$4,$5,$6,'TESTIMONY OF ANTHONY FAUCI')`, [
      id, opts.hearingId ?? null, opts.tenant ?? 'tenant-a', opts.creator ?? 'clerk-a',
      opts.type ?? 'hearing', opts.url ?? null,
    ]);
  }

  async function transcript(sessionId: string, tenant = 'tenant-a') {
    await client.query(`INSERT INTO intel_transcript_segment (id, session_id, tenant_id, text_plain)
      VALUES ($1,$2,$3,'tenant transcript must not enter the public rail')`, [`segment-${sessionId}-${tenant}`, sessionId, tenant]);
  }

  it('links direct ids with separate saved counts and navigable recording paths', async () => {
    await session('saved-fauci', { hearingId: 'fauci' });
    await transcript('saved-fauci');
    await transcript('saved-fauci', 'tenant-b'); // hostile child-row tenant mismatch
    await client.query(`INSERT INTO intel_transcript_segment (id, session_id, tenant_id, is_final)
      VALUES ('interim','saved-fauci','tenant-a',false)`);
    await client.query(`INSERT INTO intel_live_summary_card (id, tenant_id, session_id, segment_id)
      VALUES ('a','tenant-a','saved-fauci','segment-1'), ('b','tenant-a','saved-fauci','segment-1'),
        ('foreign','tenant-b','saved-fauci','segment-2')`);
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.savedSessionsState).toBe('available');
    expect(result.sessions).toEqual([expect.objectContaining({
      id: 'saved-fauci', hearingId: 'fauci', association: 'hearing_id',
      transcriptSegmentCount: 1, intelligenceMomentCount: 1,
      recordingPath: '/intelligence/hearing-watch/saved-fauci',
    })]);
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(JSON.stringify(result)).not.toContain('tenant transcript must not');
    expect((await client.query('SELECT * FROM public_hearing_transcript_segment')).rows).toEqual([]);
  });

  it('uses Clerk creator identity and excludes other tenants and private colleagues', async () => {
    await session('team', { hearingId: 'fauci', creator: 'another-user' });
    await session('private-own', { hearingId: 'fauci', type: 'meeting' });
    await session('private-colleague', { hearingId: 'fauci', creator: 'another-user', type: 'meeting' });
    await session('api-id-is-not-clerk', { hearingId: 'fauci', creator: 'api-user-a', type: 'meeting' });
    await session('foreign', { hearingId: 'fauci', tenant: 'tenant-b' });
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions.map((row) => row.id).sort()).toEqual(['private-own', 'team']);
    const foreign = await service.savedSessions({ ...ctx, tenantId: 'tenant-b' }, 'fauci');
    expect(foreign.sessions.map((row) => row.id)).toEqual(['foreign']);
  });

  it('recovers only unique official media/page identities for unlinked public sessions', async () => {
    await client.query(`INSERT INTO hearing_stream_candidate VALUES
      ('fauci','https://senate.gov/hearings/fauci',$1)`, [SENATE_RECORDING]);
    await session('media', { url: SENATE_RECORDING });
    await session('page', { url: 'https://senate.gov/hearings/fauci', type: 'markup' });
    await session('canonical-page', { url: 'https://congress.gov/hearings/fauci' });
    await session('legacy-missing-id', { hearingId: 'retired-id', url: 'https://congress.gov/hearings/fauci' });
    await session('private-title', { type: 'meeting', url: 'https://congress.gov/hearings/fauci' });
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions.map((row) => row.id).sort()).toEqual(['canonical-page', 'legacy-missing-id', 'media', 'page']);
    expect(result.sessions.every((row) => row.association === 'official_source')).toBe(true);
  });

  it.each(['canonical', 'candidate-page', 'candidate-media'])('refuses a shared Senate calendar in a sparse corpus through %s', async (field) => {
    const url = 'https://www.senate.gov/general/committee_schedules/hearings.xml';
    if (field === 'canonical') await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
    else await client.query(`INSERT INTO hearing_stream_candidate VALUES ('fauci',$1,$2)`, [
      field === 'candidate-page' ? url : 'https://senate.gov/hearings/fauci',
      field === 'candidate-media' ? url : null,
    ]);
    await session('generic-calendar', { url });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it.each(['canonical', 'candidate-page', 'candidate-media'])('refuses a persistent media stream in a sparse corpus through %s', async (field) => {
    const url = 'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/master.m3u8';
    if (field === 'canonical') await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
    else await client.query(`INSERT INTO hearing_stream_candidate VALUES ('fauci',$1,$2)`, [
      field === 'candidate-page' ? url : 'https://senate.gov/hearings/fauci',
      field === 'candidate-media' ? url : null,
    ]);
    await session('generic-stream', { url });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it('rejects a registered source URL despite a unique specific-looking path and harmless URL variations', async () => {
    const url = 'https://committee.senate.gov/business/current?view=all#top';
    await client.query(`INSERT INTO committee_source VALUES ('https://COMMITTEE.senate.gov/business/current/')`);
    await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
    await session('registered-source', { url });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it('bounds requested-hearing metadata while keeping source uniqueness global', async () => {
    await session('direct-target', { hearingId: 'fauci' });
    await session('unrelated', { hearingId: 'other' });
    await transcript('direct-target');
    await transcript('unrelated');
    await client.query(`INSERT INTO hearing_stream_candidate VALUES
      ('fauci','https://senate.gov/hearings/fauci',$1),
      ('other','https://senate.gov/hearings/other',$1)`, [SENATE_RECORDING]);
    await session('ambiguous-dated-source', { url: SENATE_RECORDING });
    const result = await discoverSavedHearingSessions(tx, 'tenant-a', 'clerk-a', 'fauci');
    expect(result.sessions).toEqual([expect.objectContaining({ id: 'direct-target', transcriptSegmentCount: 1 })]);
  });

  it('does not use title/date similarity or override an explicit hearing id with a URL', async () => {
    await session('same-title-date');
    await session('explicit-other', { hearingId: 'other', url: 'https://congress.gov/hearings/fauci' });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
    expect((await service.savedSessions(ctx, 'other')).sessions[0]).toMatchObject({ id: 'explicit-other', association: 'hearing_id' });
  });

  it('rejects reused media URLs and duplicate canonical page identities', async () => {
    await client.query(`INSERT INTO hearing_stream_candidate VALUES
      ('fauci','https://senate.gov/hearings/fauci','https://cdn.senate.gov/live/master.m3u8'),
      ('other','https://senate.gov/hearings/other','https://cdn.senate.gov/live/master.m3u8')`);
    await session('shared-stream', { url: 'https://cdn.senate.gov/live/master.m3u8' });
    await hearing('duplicate', 'Another imported Fauci record', 'https://congress.gov/hearings/fauci');
    await session('duplicate-page', { url: 'https://congress.gov/hearings/fauci' });
    expect((await discoverSavedHearingSessions(tx, 'tenant-a', 'clerk-a')).sessions).toEqual([]);
  });

  it('does not auto-associate a public session to a closed/private public-corpus record', async () => {
    await client.query(`UPDATE committee_hearing SET visibility='private' WHERE id='fauci'`);
    await session('public-typed', { url: 'https://congress.gov/hearings/fauci' });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it('archive search and Transcript Available return the same saved room without changing public counts', async () => {
    await session('saved-fauci', { hearingId: 'fauci' });
    await transcript('saved-fauci');
    for (const q of [undefined, 'Fauci']) {
      const result = await service.searchArchive(ctx, { q, hasTranscript: true });
      expect(result.total).toBe(1);
      expect(result.savedSessionsState).toBe('available');
      expect(result.facets).toMatchObject({ chamber: [{ value: 'Senate', count: 1 }] });
      expect(result.rows).toEqual([expect.objectContaining({
        id: 'fauci', savedTranscriptAvailable: true, captureStatus: null,
        transcript: expect.objectContaining({ available: false, segmentCount: 0 }),
        intelligenceCount: 0,
        savedSessions: [expect.objectContaining({ id: 'saved-fauci' })],
      })]);
    }
    const unavailable = await service.searchArchive(ctx, { hasTranscript: false });
    expect(unavailable.total).toBe(1);
    expect(unavailable.rows).toEqual([expect.objectContaining({ id: 'other' })]);
    const foreign = await service.searchArchive({ ...ctx, tenantId: 'tenant-b' }, { hasTranscript: true });
    expect(foreign.total).toBe(0);
  });

  it('archive count/facets/paging deduplicate several saved sessions and retain public-only transcripts', async () => {
    await session('saved-1', { hearingId: 'fauci' });
    await session('saved-2', { hearingId: 'fauci' });
    await transcript('saved-1');
    await transcript('saved-2');
    await client.query(`INSERT INTO official_hearing_transcript VALUES ('official','other','official transcript')`);
    const first = await service.searchArchive(ctx, { hasTranscript: true, pageSize: 1 });
    const second = await service.searchArchive(ctx, { hasTranscript: true, pageSize: 1, page: 2 });
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(second.total).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(first.facets).toMatchObject({ chamber: [{ value: 'Senate', count: 2 }] });
    expect([...(first.rows as Array<{ id: string }>), ...(second.rows as Array<{ id: string }>)].map((r) => r.id).sort())
      .toEqual(['fauci', 'other']);
  });

  it('reports missing intel rails explicitly without failing public archive or hiding errors', async () => {
    await client.query('ALTER TABLE intel_live_summary_card RENAME TO saved_card_unavailable');
    try {
      const detail = await service.savedSessions(ctx, 'fauci');
      expect(detail).toMatchObject({ savedSessionsState: 'unavailable', sessions: [] });
      const archive = await service.searchArchive(ctx, {});
      expect(archive.total).toBe(2);
      expect(archive.savedSessionsState).toBe('unavailable');
      expect(archive.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ savedTranscriptAvailable: null }),
      ]));
    } finally {
      await client.query('ALTER TABLE saved_card_unavailable RENAME TO intel_live_summary_card');
    }
    const failure = new Error('database disconnected');
    await expect(discoverSavedHearingSessions({ $queryRawUnsafe: async () => { throw failure; } }, 'tenant-a', 'clerk-a'))
      .rejects.toBe(failure);
  });
});
