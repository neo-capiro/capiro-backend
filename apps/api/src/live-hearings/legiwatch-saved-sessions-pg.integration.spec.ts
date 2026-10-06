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
  tenantId: 'tenant-a',
  userId: 'api-user-a',
  clerkUserId: 'clerk-a',
  tenantSlug: 'test',
  role: 'standard_user',
};
const SENATE_RECORDING =
  'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/govtaff072926/master.m3u8';

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
        (await client.query('SELECT * FROM committee_hearing WHERE id = $1', [where.id])).rows[0] ??
        null,
    },
    hearingStreamCandidate: {
      findMany: jest.fn(
        async (args: {
          where: { hearingId: { in: string[] } };
          orderBy: Array<Record<string, string>>;
          select: Record<string, boolean>;
        }) => {
          expect(args.orderBy).toEqual([{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }]);
          expect(args.select).toEqual({
            id: true,
            hearingId: true,
            provider: true,
            officialPageUrl: true,
            capturePolicy: true,
            priority: true,
            updatedAt: true,
          });
          return (
            await client.query(
              `SELECT id, hearing_id AS "hearingId", provider,
                  official_page_url AS "officialPageUrl", capture_policy AS "capturePolicy",
                  priority, updated_at AS "updatedAt"
             FROM hearing_stream_candidate WHERE hearing_id = ANY($1::text[])
             ORDER BY priority ASC, updated_at DESC, id ASC`,
              [args.where.hearingId.in],
            )
          ).rows;
        },
      ),
    },
  };
  const service = new LegiWatchWave1Service(
    prisma as unknown as PrismaService,
    null as never,
    null as never,
    null as never,
    null as never,
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
        witnesses text[] DEFAULT '{}', geographic_jurisdiction text DEFAULT 'US'
      );
      CREATE TEMP VIEW federal_committee_hearing AS SELECT * FROM committee_hearing
        WHERE geographic_jurisdiction='US' OR geographic_jurisdiction IS NULL;
      CREATE TEMP TABLE hearing_stream_candidate (
        hearing_id text, official_page_url text, media_url text,
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        provider text DEFAULT 'senate-isvp', capture_policy text DEFAULT 'REVIEW_REQUIRED',
        priority integer DEFAULT 100, updated_at timestamptz DEFAULT now()
      );
      CREATE TEMP TABLE committee_source (source_url text);
      CREATE TEMP TABLE intel_live_hearing_session (
        id text PRIMARY KEY, hearing_id text, tenant_id text, created_by text,
        title text, source_type text DEFAULT 'hearing', source_url text, status text DEFAULT 'ended',
        started_at timestamptz, ended_at timestamptz, created_at timestamptz DEFAULT now(),
        public_capture_id text
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
        id text, capture_id text, start_ms integer, speaker_label text, text text, sequence integer,
        is_final boolean DEFAULT true
    );
      CREATE TEMP TABLE public_hearing_speaker (
        capture_id text NOT NULL, speaker_label text NOT NULL, display_name text NOT NULL,
        source text NOT NULL DEFAULT 'llm',
        UNIQUE(capture_id, speaker_label)
      );
      CREATE TEMP TABLE public_hearing_insight (
        id text, hearing_id text, capture_id text, segment_id text,
        insight_type text, title text, summary text, evidence_text text, sequence integer
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
      public_hearing_insight, public_hearing_speaker`);
    await hearing('fauci', 'TESTIMONY OF ANTHONY FAUCI', 'https://congress.gov/hearings/fauci');
    await hearing('other', 'Unrelated proceeding', 'https://senate.gov/hearings/other');
  });

  async function hearing(id: string, title: string, url: string) {
    await client.query('INSERT INTO committee_hearing (id, title, url) VALUES ($1,$2,$3)', [
      id,
      title,
      url,
    ]);
  }

  async function session(
    id: string,
    opts: {
      hearingId?: string | null;
      tenant?: string;
      creator?: string;
      type?: string;
      url?: string | null;
    } = {},
  ) {
    await client.query(
      `INSERT INTO intel_live_hearing_session
      (id, hearing_id, tenant_id, created_by, source_type, source_url, title)
      VALUES ($1,$2,$3,$4,$5,$6,'TESTIMONY OF ANTHONY FAUCI')`,
      [
        id,
        opts.hearingId ?? null,
        opts.tenant ?? 'tenant-a',
        opts.creator ?? 'clerk-a',
        opts.type ?? 'hearing',
        opts.url ?? null,
      ],
    );
  }

  async function transcript(sessionId: string, tenant = 'tenant-a') {
    await client.query(
      `INSERT INTO intel_transcript_segment (id, session_id, tenant_id, text_plain)
      VALUES ($1,$2,$3,'tenant transcript must not enter the public rail')`,
      [`segment-${sessionId}-${tenant}`, sessionId, tenant],
    );
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
    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: 'saved-fauci',
        hearingId: 'fauci',
        association: 'hearing_id',
        transcriptSegmentCount: 1,
        intelligenceMomentCount: 1,
        recordingPath: '/intelligence/hearing-watch/saved-fauci',
      }),
    ]);
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(JSON.stringify(result)).not.toContain('tenant transcript must not');
    expect((await client.query('SELECT * FROM public_hearing_transcript_segment')).rows).toEqual(
      [],
    );
  });

  it('uses Clerk creator identity and excludes other tenants and private colleagues', async () => {
    await session('team', { hearingId: 'fauci', creator: 'another-user' });
    await session('private-own', { hearingId: 'fauci', type: 'meeting' });
    await session('private-colleague', {
      hearingId: 'fauci',
      creator: 'another-user',
      type: 'meeting',
    });
    await session('api-id-is-not-clerk', {
      hearingId: 'fauci',
      creator: 'api-user-a',
      type: 'meeting',
    });
    await session('foreign', { hearingId: 'fauci', tenant: 'tenant-b' });
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions.map((row) => row.id).sort()).toEqual(['private-own', 'team']);
    const foreign = await service.savedSessions({ ...ctx, tenantId: 'tenant-b' }, 'fauci');
    expect(foreign.sessions.map((row) => row.id)).toEqual(['foreign']);
  });

  it('recovers only unique official media/page identities for unlinked public sessions', async () => {
    await client.query(
      `INSERT INTO hearing_stream_candidate (hearing_id, official_page_url, media_url) VALUES
      ('fauci','https://senate.gov/hearings/fauci',$1)`,
      [SENATE_RECORDING],
    );
    await session('media', { url: SENATE_RECORDING });
    await session('page', { url: 'https://senate.gov/hearings/fauci', type: 'markup' });
    await session('canonical-page', { url: 'https://congress.gov/hearings/fauci' });
    await session('legacy-missing-id', {
      hearingId: 'retired-id',
      url: 'https://congress.gov/hearings/fauci',
    });
    await session('private-title', { type: 'meeting', url: 'https://congress.gov/hearings/fauci' });
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions.map((row) => row.id).sort()).toEqual([
      'canonical-page',
      'legacy-missing-id',
      'media',
      'page',
    ]);
    expect(result.sessions.every((row) => row.association === 'official_source')).toBe(true);
  });

  it.each(['canonical', 'candidate-page', 'candidate-media'])(
    'refuses a shared Senate calendar in a sparse corpus through %s',
    async (field) => {
      const url = 'https://www.senate.gov/general/committee_schedules/hearings.xml';
      if (field === 'canonical')
        await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
      else
        await client.query(
          `INSERT INTO hearing_stream_candidate (hearing_id, official_page_url, media_url) VALUES ('fauci',$1,$2)`,
          [
            field === 'candidate-page' ? url : 'https://senate.gov/hearings/fauci',
            field === 'candidate-media' ? url : null,
          ],
        );
      await session('generic-calendar', { url });
      expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
    },
  );

  it.each(['canonical', 'candidate-page', 'candidate-media'])(
    'refuses a persistent media stream in a sparse corpus through %s',
    async (field) => {
      const url =
        'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/master.m3u8';
      if (field === 'canonical')
        await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
      else
        await client.query(
          `INSERT INTO hearing_stream_candidate (hearing_id, official_page_url, media_url) VALUES ('fauci',$1,$2)`,
          [
            field === 'candidate-page' ? url : 'https://senate.gov/hearings/fauci',
            field === 'candidate-media' ? url : null,
          ],
        );
      await session('generic-stream', { url });
      expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
    },
  );

  it('rejects a registered source URL despite a unique specific-looking path and harmless URL variations', async () => {
    const url = 'https://committee.senate.gov/business/current?view=all#top';
    await client.query(
      `INSERT INTO committee_source VALUES ('https://COMMITTEE.senate.gov/business/current/')`,
    );
    await client.query(`UPDATE committee_hearing SET url=$1 WHERE id='fauci'`, [url]);
    await session('registered-source', { url });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it('bounds requested-hearing metadata while keeping source uniqueness global', async () => {
    await session('direct-target', { hearingId: 'fauci' });
    await session('unrelated', { hearingId: 'other' });
    await transcript('direct-target');
    await transcript('unrelated');
    await client.query(
      `INSERT INTO hearing_stream_candidate (hearing_id, official_page_url, media_url) VALUES
      ('fauci','https://senate.gov/hearings/fauci',$1),
      ('other','https://senate.gov/hearings/other',$1)`,
      [SENATE_RECORDING],
    );
    await session('ambiguous-dated-source', { url: SENATE_RECORDING });
    const result = await discoverSavedHearingSessions(tx, 'tenant-a', 'clerk-a', 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'direct-target', transcriptSegmentCount: 1 }),
    ]);
  });

  it('does not use title/date similarity or override an explicit hearing id with a URL', async () => {
    await session('same-title-date');
    await session('explicit-other', {
      hearingId: 'other',
      url: 'https://congress.gov/hearings/fauci',
    });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
    expect((await service.savedSessions(ctx, 'other')).sessions[0]).toMatchObject({
      id: 'explicit-other',
      association: 'hearing_id',
    });
  });

  it('rejects reused media URLs and duplicate canonical page identities', async () => {
    await client.query(`INSERT INTO hearing_stream_candidate (hearing_id, official_page_url, media_url) VALUES
      ('fauci','https://senate.gov/hearings/fauci','https://cdn.senate.gov/live/master.m3u8'),
      ('other','https://senate.gov/hearings/other','https://cdn.senate.gov/live/master.m3u8')`);
    await session('shared-stream', { url: 'https://cdn.senate.gov/live/master.m3u8' });
    await hearing(
      'duplicate',
      'Another imported Fauci record',
      'https://congress.gov/hearings/fauci',
    );
    await session('duplicate-page', { url: 'https://congress.gov/hearings/fauci' });
    expect((await discoverSavedHearingSessions(tx, 'tenant-a', 'clerk-a')).sessions).toEqual([]);
  });

  it('does not auto-associate a public session to a closed/private public-corpus record', async () => {
    await client.query(`UPDATE committee_hearing SET visibility='private' WHERE id='fauci'`);
    await session('public-typed', { url: 'https://congress.gov/hearings/fauci' });
    expect((await service.savedSessions(ctx, 'fauci')).sessions).toEqual([]);
  });

  it('archive playback reads ordered candidates only for the returned hearings', async () => {
    await client.query(`INSERT INTO hearing_stream_candidate
      (id, hearing_id, official_page_url, priority, updated_at) VALUES
      ('old', 'fauci', 'https://www.senate.gov/hearings/old', 1, '2026-07-28T00:00:00Z'),
      ('z-new', 'fauci', 'https://www.senate.gov/hearings/z-new', 1, '2026-07-29T00:00:00Z'),
      ('a-new', 'fauci', 'https://www.senate.gov/hearings/a-new', 1, '2026-07-29T00:00:00Z'),
      ('low-priority', 'fauci', 'https://www.senate.gov/hearings/low', 2, '2026-07-30T00:00:00Z'),
      ('other-hearing', 'other', 'https://www.senate.gov/hearings/other', 0, '2026-07-30T00:00:00Z')`);
    const result = await service.searchArchive(ctx, { q: 'Fauci' });
    expect(result.total).toBe(1);
    expect(prisma.hearingStreamCandidate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.hearingStreamCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hearingId: { in: ['fauci'] } },
      }),
    );
    const candidates: Array<{ id: string }> =
      await prisma.hearingStreamCandidate.findMany.mock.results[0]!.value;
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'a-new',
      'z-new',
      'old',
      'low-priority',
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: 'fauci',
        officialPlaybackUrl: 'https://www.senate.gov/hearings/a-new',
      }),
    ]);
  });

  it('empty archive results do not request playback candidates', async () => {
    const result = await service.searchArchive(ctx, { q: 'NoMatchingHearingAtAll' });
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
    expect(prisma.hearingStreamCandidate.findMany).not.toHaveBeenCalled();
  });

  it('archive search and Transcript Available return the same saved room without changing public counts', async () => {
    await session('saved-fauci', { hearingId: 'fauci' });
    await transcript('saved-fauci');
    for (const q of [undefined, 'Fauci']) {
      const result = await service.searchArchive(ctx, { q, hasTranscript: true });
      expect(result.total).toBe(1);
      expect(result.savedSessionsState).toBe('available');
      expect(result.facets).toMatchObject({ chamber: [{ value: 'Senate', count: 1 }] });
      expect(result.rows).toEqual([
        expect.objectContaining({
          id: 'fauci',
          savedTranscriptAvailable: true,
          captureStatus: null,
          transcript: expect.objectContaining({ available: false, segmentCount: 0 }),
          intelligenceCount: 0,
          savedSessions: [expect.objectContaining({ id: 'saved-fauci' })],
        }),
      ]);
    }
    const unavailable = await service.searchArchive(ctx, { hasTranscript: false });
    expect(unavailable.total).toBe(1);
    expect(unavailable.rows).toEqual([expect.objectContaining({ id: 'other' })]);
    const foreign = await service.searchArchive(
      { ...ctx, tenantId: 'tenant-b' },
      { hasTranscript: true },
    );
    expect(foreign.total).toBe(0);
  });

  it('archive transcript snippets withhold automatic identities but retain reviewed and original named labels', async () => {
    await client.query(`INSERT INTO public_hearing_capture (id, hearing_id, domain_status) VALUES ('capture-speaker','fauci','COMPLETE')`);
    await client.query(`INSERT INTO public_hearing_transcript_segment (id,capture_id,start_ms,speaker_label,text,sequence)
      VALUES ('speaker-segment','capture-speaker',1000,'8','Quantum sensing discussion',1)`);
    await client.query(`INSERT INTO public_hearing_speaker (capture_id,speaker_label,display_name,source)
      VALUES ('capture-speaker','8','Shaheen, Jeanne','llm')`);
    const search = async () => {
      const result = await service.searchArchive(ctx, { q: 'Quantum' });
      const row = (result.rows as Array<{ transcriptHit?: { speakerName: string | null } }>)[0];
      return row?.transcriptHit;
    };
    expect(await search()).toMatchObject({ speakerName: null });
    await client.query(`UPDATE public_hearing_speaker SET display_name='Tim Kaine',source='manual' WHERE capture_id='capture-speaker'`);
    expect(await search()).toMatchObject({ speakerName: 'Tim Kaine' });
    await client.query(`UPDATE public_hearing_transcript_segment SET speaker_label='Official source speaker' WHERE id='speaker-segment'`);
    expect(await search()).toMatchObject({ speakerName: 'Official source speaker' });
  });

  it('archive playback uses the scoped candidate projection and deterministic priority', async () => {
    await client.query(`INSERT INTO hearing_stream_candidate
      (id, hearing_id, official_page_url, provider, capture_policy, priority) VALUES
      ('later', 'fauci', 'https://www.senate.gov/hearings/later', 'senate-isvp', 'BLOCKED', 20),
      ('chosen', 'fauci', 'https://www.senate.gov/hearings/chosen', 'senate-isvp', 'BLOCKED', 10),
      ('foreign', 'other', 'https://www.senate.gov/hearings/foreign', 'senate-isvp', 'BLOCKED', 0)`);
    const result = await service.searchArchive(ctx, { q: 'Fauci' });
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: 'fauci',
        officialPlaybackUrl: 'https://www.senate.gov/hearings/chosen',
        officialPlaybackKind: 'official_player_page',
      }),
    ]);
  });

  it('archive count/facets/paging deduplicate several saved sessions and retain public-only transcripts', async () => {
    await session('saved-1', { hearingId: 'fauci' });
    await session('saved-2', { hearingId: 'fauci' });
    await transcript('saved-1');
    await transcript('saved-2');
    await client.query(
      `INSERT INTO official_hearing_transcript VALUES ('official','other','official transcript')`,
    );
    const first = await service.searchArchive(ctx, { hasTranscript: true, pageSize: 1 });
    const second = await service.searchArchive(ctx, { hasTranscript: true, pageSize: 1, page: 2 });
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(second.total).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(first.facets).toMatchObject({ chamber: [{ value: 'Senate', count: 2 }] });
    expect(
      [...(first.rows as Array<{ id: string }>), ...(second.rows as Array<{ id: string }>)]
        .map((r) => r.id)
        .sort(),
    ).toEqual(['fauci', 'other']);
  });

  it('reports missing intel rails explicitly without failing public archive or hiding errors', async () => {
    await client.query('ALTER TABLE intel_live_summary_card RENAME TO saved_card_unavailable');
    // Exclude public so a real/migrated public.intel_live_summary_card cannot
    // satisfy to_regclass fallback and mask the missing TEMP rail.
    const pathResult = await client.query<{ search_path: string }>('SHOW search_path');
    const pathRow = pathResult.rows[0];
    if (!pathRow) throw new Error('SHOW search_path returned no rows');
    const originalPath = pathRow.search_path;
    await client.query(`SET search_path = ${functionSchema}, pg_temp`);
    try {
      const detail = await service.savedSessions(ctx, 'fauci');
      expect(detail).toMatchObject({ savedSessionsState: 'unavailable', sessions: [] });
      const archive = await service.searchArchive(ctx, {});
      expect(archive.total).toBe(2);
      expect(archive.savedSessionsState).toBe('unavailable');
      expect(archive.rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ savedTranscriptAvailable: null })]),
      );
    } finally {
      await client.query(`SET search_path = ${originalPath}`);
      await client.query('ALTER TABLE saved_card_unavailable RENAME TO intel_live_summary_card');
    }
    const failure = new Error('database disconnected');
    await expect(
      discoverSavedHearingSessions(
        {
          $queryRawUnsafe: async () => {
            throw failure;
          },
        },
        'tenant-a',
        'clerk-a',
      ),
    ).rejects.toBe(failure);
  });

  it('public review session counts canonical final segments and never borrows another capture', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-fauci','fauci')`,
    );
    for (let i = 1; i <= 37; i++) {
      await client.query(
        `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
         VALUES ($1, 'cap-fauci', $2, $3, true, 'public canonical')`,
        [`seg-${i}`, i * 1000, i],
      );
    }
    // One interim public segment must not be counted.
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('interim-pub', 'cap-fauci', 38000, 38, false, 'public interim')`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('review-fauci', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-fauci')`,
    );
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: 'review-fauci',
        hearingId: 'fauci',
        association: 'hearing_id',
        transcriptSegmentCount: 37,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('public canonical');
  });

  it('public review session counts distinct insight source segments and ignores private decoys', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-fauci','fauci')`,
    );
    // Two segments back the moments; one carries two insight rows that must
    // dedup to one moment, mirroring the 7-rows-over-6-segments public shape.
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('seg-1', 'cap-fauci', 1000, 1, true, 'public canonical'),
              ('seg-2', 'cap-fauci', 2000, 2, true, 'public canonical')`,
    );
    await client.query(
      `INSERT INTO public_hearing_insight (id, hearing_id, capture_id, segment_id, insight_type, title, summary, sequence)
       VALUES ('i-1', 'fauci', 'cap-fauci', 'seg-1', 'KEY_QUOTE', 'q1', 's1', 1),
              ('i-2', 'fauci', 'cap-fauci', 'seg-1', 'COMMITMENT', 'q2', 's2', 2),
              ('i-3', 'fauci', 'cap-fauci', 'seg-2', 'QUESTION', 'q3', 's3', 3)`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('review-fauci', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-fauci')`,
    );
    // Decoys: a native private card on the same session and a foreign-tenant
    // card must never leak into the public review count.
    await client.query(
      `INSERT INTO intel_live_summary_card (id, tenant_id, session_id, segment_id)
       VALUES ('decoy-own', 'tenant-a', 'review-fauci', 'seg-9'),
              ('decoy-foreign', 'tenant-b', 'review-fauci', 'seg-8')`,
    );
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: 'review-fauci',
        transcriptSegmentCount: 2,
        intelligenceMomentCount: 2,
      }),
    ]);
  });

  it('misassociated public capture never borrows public insights and keeps the private count', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-other','other')`,
    );
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('other-seg', 'cap-other', 1000, 1, true, 'other hearing transcript')`,
    );
    await client.query(
      `INSERT INTO public_hearing_insight (id, hearing_id, capture_id, segment_id, insight_type, title, summary, sequence)
       VALUES ('oi-1', 'other', 'cap-other', 'other-seg', 'KEY_QUOTE', 'oq', 'os', 1)`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('mis-fauci', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-other')`,
    );
    await client.query(
      `INSERT INTO intel_live_summary_card (id, tenant_id, session_id, segment_id)
       VALUES ('own-card', 'tenant-a', 'mis-fauci', 'own-seg')`,
    );
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'mis-fauci', intelligenceMomentCount: 1 }),
    ]);
  });

  it('ordinary private session keeps tenant private intelligence count; public capture does not merge', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-fauci','fauci')`,
    );
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('pub-1', 'cap-fauci', 1000, 1, true, 'public canonical')`,
    );
    await client.query(
      `INSERT INTO public_hearing_insight (id, hearing_id, capture_id, segment_id, insight_type, title, summary, sequence)
       VALUES ('pi-1', 'fauci', 'cap-fauci', 'pub-1', 'KEY_QUOTE', 'pq', 'ps', 1)`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, source_type)
       VALUES ('private-own', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'meeting')`,
    );
    await client.query(
      `INSERT INTO intel_live_summary_card (id, tenant_id, session_id, segment_id)
       VALUES ('c-1', 'tenant-a', 'private-own', 'seg-1'),
              ('c-2', 'tenant-a', 'private-own', 'seg-1'),
              ('c-foreign', 'tenant-b', 'private-own', 'seg-2')`,
    );
    const result = await service.savedSessions(ctx, 'fauci');
    // Public insights exist for this hearing but the private session has no
    // capture, so only its own tenant cards count (distinct segments).
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'private-own', intelligenceMomentCount: 1 }),
    ]);
  });

  it('ordinary private session keeps tenant private count; public capture does not merge', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-fauci','fauci')`,
    );
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('pub-1', 'cap-fauci', 1000, 1, true, 'public canonical')`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('review-fauci', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-fauci')`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, source_type)
       VALUES ('private-own', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'meeting')`,
    );
    await transcript('private-own');
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review-fauci', transcriptSegmentCount: 1 }),
        expect.objectContaining({ id: 'private-own', transcriptSegmentCount: 1 }),
      ]),
    );
    const review = result.sessions.find((s) => s.id === 'review-fauci');
    const own = result.sessions.find((s) => s.id === 'private-own');
    expect(review?.association).toBe('hearing_id');
    expect(own?.association).toBe('hearing_id');
  });

  it('misassociated public capture falls back to private count and never merges another hearing', async () => {
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-other','other')`,
    );
    await client.query(
      `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
       VALUES ('other-seg', 'cap-other', 1000, 1, true, 'other hearing transcript')`,
    );
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('mis-fauci', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-other')`,
    );
    await transcript('mis-fauci');
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'mis-fauci', transcriptSegmentCount: 1 }),
    ]);
    expect(result.sessions[0]?.transcriptSegmentCount).toBe(1);
  });

  it('closed hearing with public capture remains discoverable and counts canonical segments', async () => {
    await client.query(`UPDATE committee_hearing SET visibility='private' WHERE id='fauci'`);
    await client.query(
      `INSERT INTO public_hearing_capture (id, hearing_id) VALUES ('cap-fauci','fauci')`,
    );
    for (let i = 1; i <= 5; i++) {
      await client.query(
        `INSERT INTO public_hearing_transcript_segment (id, capture_id, start_ms, sequence, is_final, text)
         VALUES ($1, 'cap-fauci', $2, $3, true, 'public canonical')`,
        [`seg-${i}`, i * 1000, i],
      );
    }
    await client.query(
      `INSERT INTO intel_live_hearing_session (id, hearing_id, tenant_id, created_by, title, public_capture_id)
       VALUES ('review-closed', 'fauci', 'tenant-a', 'clerk-a', 'TESTIMONY OF ANTHONY FAUCI', 'cap-fauci')`,
    );
    const result = await service.savedSessions(ctx, 'fauci');
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'review-closed', transcriptSegmentCount: 5 }),
    ]);
  });
});
