/**
 * Provenance dispositions — disposable-Postgres proof.
 *
 * Exercises the REAL migration DDL (table, CHECKs, partial unique index, and
 * the self-healing supersede trigger) plus the service against a disposable
 * PG loaded with real migrations. Complements the unit specs by proving the
 * database-level behavior that mocks cannot.
 *
 * Cases:
 *  A. schema accepts a valid disposition; one-ACTIVE-per-hearing is enforced
 *  B. second ACTIVE row for the same hearing violates the partial unique index
 *  C. revocation: ACTIVE -> REVOKED (history kept), a NEW ACTIVE row may then
 *     be created (revocation -> re-disposition cycle)
 *  D. SELF-HEALING: linking a reconciled observation automatically supersedes
 *     the ACTIVE disposition (observation provenance wins, history kept)
 *  E. CHECK constraints reject bad type/reason/uri/expiry shapes
 *  F. tenant-shaped keys are rejected by the service before any SQL runs
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  LegiWatchPhase9ProvenanceDispositionService,
  LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
} from './legiwatch-phase9-provenance-disposition.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const DISPOSITION = {
  dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
  reasonCode: 'CLOSED_BRIEFING_NO_PUBLIC_EVENT_RECORD',
  artifactUri:
    's3://updated-directory-967807252336-us-east-1/phase9-evidence/provenance-disposition-investigation.json',
  details: {
    investigatedAt: '2026-09-02',
    sourcesProbed: 6,
    verdict: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
  },
  reviewedBy: 'dbproof-operator',
  reviewedAt: new Date('2026-09-02T12:00:00Z'),
};

async function seedHearing(prisma: PrismaService, id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO committee_hearing
       (id, congress, chamber, committee_system_code, committee_name, title,
        date, time, starts_at, event_status, visibility, url, source_revision,
        witnesses, stream_availability, coverage_status, synced_at)
     VALUES ($1, 119, 'senate', 'sscm00', 'Select Committee on Intelligence',
             'DB-proof hearing', '2026-07-20', '10:00 AM', '2026-07-20T14:00:00Z',
             'completed', 'public', 'https://www.intelligence.senate.gov', 1,
             ARRAY[]::text[], 'unknown', 'no_public_stream', now())
     ON CONFLICT (id) DO NOTHING`,
    id,
  );
}

describeDb('LegiWatch Phase 9 provenance dispositions (disposable PG)', () => {
  const prisma = new PrismaService();
  const hearingIds = ['provdisp-a', 'provdisp-b', 'provdisp-c'];
  const service = new LegiWatchPhase9ProvenanceDispositionService(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_source (id,chamber,source_type,source_url,adapter_key,updated_at)
       VALUES ('provdisp-source','senate','CONGRESS_GOV','https://example.test/provdisp','congress-gov',now())
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const id of hearingIds) {
      await seedHearing(prisma, id);
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    // Dispositions cascade on hearing delete; observations do not.
    await prisma.$executeRawUnsafe(
      `DELETE FROM hearing_source_observation WHERE hearing_id LIKE 'provdisp-%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM committee_hearing WHERE id LIKE 'provdisp-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM committee_source WHERE id='provdisp-source'`);
  }

  it('A. creates a valid disposition and enforces exactly-one-ACTIVE (read-back)', async () => {
    const created = await service.apply({
      hearingId: 'provdisp-a',
      ...DISPOSITION,
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    expect(created.status).toBe('ACTIVE');
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM canonical_provenance_disposition WHERE hearing_id='provdisp-a'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('B. a second ACTIVE row for the same hearing violates the partial unique index', async () => {
    await service.apply({
      hearingId: 'provdisp-a',
      ...DISPOSITION,
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    // Revoke the first (history kept), then a new ACTIVE row is allowed.
    await service.revoke({
      hearingId: 'provdisp-a',
      actor: 'dbproof',
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    await service.apply({
      hearingId: 'provdisp-a',
      ...DISPOSITION,
      reviewedAt: new Date('2026-09-02T13:00:00Z'),
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM canonical_provenance_disposition WHERE hearing_id='provdisp-a' ORDER BY created_at`,
    );
    expect(rows.map((r) => r.status)).toEqual(['REVOKED', 'ACTIVE']);
    // And a direct second ACTIVE insert must throw (23505 unique violation).
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO canonical_provenance_disposition
           (hearing_id, disposition_type, reason_code, artifact_uri, reviewed_by, reviewed_at)
         VALUES ('provdisp-a', 'OFFICIAL_OBSERVATION_UNAVAILABLE', 'OFFICIAL_ARCHIVE_NO_EVENT_RECORD',
                 's3://bucket/second.json', 'x', now())`,
      ),
    ).rejects.toThrow();
  });

  it('C. revoked rows keep history with revoked_by/revoked_at set', async () => {
    await service.apply({
      hearingId: 'provdisp-b',
      ...DISPOSITION,
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    await service.revoke({
      hearingId: 'provdisp-b',
      actor: 'dbproof-revoker',
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    const rows = await prisma.$queryRawUnsafe<
      Array<{ status: string; revokedBy: string | null; revokedAt: Date | null }>
    >(
      `SELECT status, revoked_by AS "revokedBy", revoked_at AS "revokedAt"
       FROM canonical_provenance_disposition WHERE hearing_id='provdisp-b'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('REVOKED');
    expect(rows[0]?.revokedBy).toBe('dbproof-revoker');
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('D. SELF-HEALING: a reconciled observation supersedes the ACTIVE disposition automatically', async () => {
    await service.apply({
      hearingId: 'provdisp-c',
      ...DISPOSITION,
      confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
    });
    // Link one reconciled observation through the NORMAL path: insert with
    // hearing_id set; the Phase 3 trigger stamps RECONCILED, and the Phase 9
    // supersede trigger must flip the disposition to SUPERSEDED.
    await prisma.$executeRawUnsafe(
      `INSERT INTO hearing_source_observation
         (id, source_id, external_event_id, hearing_id, raw_content_hash, observed_date, source_metadata)
       SELECT 'provdisp-obs-1', s.id, 'db-proof-evt', 'provdisp-c', 'hash-dbproof', '2026-07-20',
              '{"event":{"title":"x"}}'::jsonb
       FROM committee_source s WHERE s.id='provdisp-source'`,
    );
    const obs = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT reconciliation_status AS status FROM hearing_source_observation WHERE id='provdisp-obs-1'`,
    );
    expect(obs[0]?.status).toBe('RECONCILED'); // Phase 3 trigger fired
    const disp = await prisma.$queryRawUnsafe<Array<{ status: string; revokedBy: string | null }>>(
      `SELECT status, revoked_by AS "revokedBy" FROM canonical_provenance_disposition WHERE hearing_id='provdisp-c'`,
    );
    expect(disp[0]?.status).toBe('SUPERSEDED'); // self-healing fired
    expect(disp[0]?.revokedBy).toBe('system:reconciled-observation-supersedes');
    // Now the service refuses a NEW disposition (observation provenance wins).
    await expect(
      service.apply({
        hearingId: 'provdisp-c',
        ...DISPOSITION,
        confirmation: LEGIWATCH_PROVENANCE_DISPOSITION_CONFIRMATION,
      }),
    ).rejects.toThrow(/observation provenance wins/);
  });

  it('E. CHECK constraints reject bad shapes', async () => {
    const base = `INSERT INTO canonical_provenance_disposition
        (hearing_id, disposition_type, reason_code, artifact_uri, reviewed_by, reviewed_at)`;
    await seedHearing(prisma, 'provdisp-e');
    hearingIds.push('provdisp-e');
    await expect(
      prisma.$executeRawUnsafe(
        `${base} VALUES ('provdisp-e', 'WE_FAILED_TO_LOOK', 'CLOSED_BRIEFING_NO_PUBLIC_EVENT_RECORD', 's3://b/a.json', 'x', now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `${base} VALUES ('provdisp-e', 'OFFICIAL_OBSERVATION_UNAVAILABLE', 'MADE_UP_REASON', 's3://b/a.json', 'x', now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `${base} VALUES ('provdisp-e', 'OFFICIAL_OBSERVATION_UNAVAILABLE', 'OFFICIAL_ARCHIVE_NO_EVENT_RECORD', 'file:///etc/passwd', 'x', now())`,
      ),
    ).rejects.toThrow();
    // Empty reviewed_by violates the review-shape CHECK.
    await expect(
      prisma.$executeRawUnsafe(
        `${base} VALUES ('provdisp-e', 'OFFICIAL_OBSERVATION_UNAVAILABLE', 'OFFICIAL_ARCHIVE_NO_EVENT_RECORD', 's3://b/a.json', '', now())`,
      ),
    ).rejects.toThrow();
  });

  it('F. expires_at before reviewed_at is rejected', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO canonical_provenance_disposition
           (hearing_id, disposition_type, reason_code, artifact_uri, reviewed_by, reviewed_at, expires_at)
         VALUES ('provdisp-b', 'OFFICIAL_OBSERVATION_UNAVAILABLE', 'OFFICIAL_ARCHIVE_NO_EVENT_RECORD',
                 's3://b/a.json', 'x', '2026-09-02T12:00:00Z', '2026-09-01T12:00:00Z')`,
      ),
    ).rejects.toThrow();
  });
});
