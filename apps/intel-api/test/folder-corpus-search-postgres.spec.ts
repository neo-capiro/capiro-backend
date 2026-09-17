import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

/**
 * Global bill-corpus search regression (real PostgreSQL).
 *
 * Covers the requirements the pre-fix implementation violated:
 *  - an UNTRACKED federal bill is findable without any tenant tracking row;
 *  - ingested state bills in ANY ingested jurisdiction (not only FL) match;
 *  - older sessions and special sessions match (no current-session gate);
 *  - HR/H.R./H R/H B punctuation variants hit the same canonical number;
 *  - jurisdiction-less "H 27" matches BOTH the FL alias (H0027→HB27) and a
 *    same-numbered bill in another state (row-local FL alias, not global);
 *  - true paginated totals beyond the first page with no duplicate rows;
 *  - tenant-private folder context never leaks into corpus rows;
 *  - the folder BOARD contract still requires jurisdiction+session.
 */
describe('global bill corpus search (PostgreSQL)', () => {
  const prisma = new PrismaService();
  const source = new FolderSourceDataRepository(prisma);
  const svc = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const tenant = randomUUID();
  const foreign = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const actor = 'corpus_' + suffix;
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  const foreignCtx: WorkspaceTenantContext = {
    tenantId: foreign,
    clerkUserId: actor,
    role: 'org:admin',
  };

  const fed119 = `119-hr-corpus-${suffix}`;
  const fed117 = `117-hr-corpus-${suffix}`;
  const flRegular = `fl-2099-hb-corpus-${suffix}`;
  const flSpecial = `fl-2099x1-hb-corpus-${suffix}`;
  const gaBill = `ga-2099-hb-corpus-${suffix}`;
  const flH27 = `fl-2097-h0027-corpus-${suffix}`;
  const maH27 = `ma-2097-h27-corpus-${suffix}`;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable DATABASE_URL is required');
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES (${tenant}::uuid,${'corpus-' + suffix},'Corpus tenant'),(${foreign}::uuid,${'corpus-f-' + suffix},'Foreign tenant')`;
      const uid = randomUUID();
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES (${uid}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES (${tenant}::uuid,${uid}::uuid,'standard_user','active')`;

      await tx.$executeRawUnsafe(
        `INSERT INTO congress_bill(id,congress,bill_type,bill_number,title,latest_action_text,latest_action_date)
         VALUES ($1,119,'hr',9001,'Corpus marker federal current','Referred','2026-06-01'),
                ($2,117,'hr',9002,'Corpus marker federal older','Passed House','2022-03-01')
         ON CONFLICT(id) DO NOTHING`,
        fed119,
        fed117,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,latest_action_text,latest_action_date)
         VALUES ($1,'FL','2099 Regular Session','2099','HB 9001','hb9001','Corpus marker Florida regular','Filed','2026-01-05'),
                ($2,'FL','2099 Special Session 1','2099x1','HB 9002','hb9002','Corpus marker Florida special','Filed','2026-02-05'),
                ($3,'GA','2099 Regular Session','2099','HB 9003','hb9003','Corpus marker Georgia regular','Filed','2026-01-06'),
                ($4,'FL','2097 Regular Session','2097','H 0027','h0027','Corpus marker Florida H alias','Filed','2025-01-06'),
                ($5,'MA','2097 Regular Session','2097','H 27','h27','Corpus marker Massachusetts H27','Filed','2025-01-07')
         ON CONFLICT(id) DO NOTHING`,
        flRegular,
        flSpecial,
        gaBill,
        flH27,
        maH27,
      );

      // A FOREIGN tenant's private folder assignment on one corpus bill: it
      // must never leak into this tenant's search rows.
      const folderId = randomUUID();
      await tx.legiWatchFolder.create({
        data: {
          id: folderId,
          tenantId: foreign,
          name: 'Foreign private folder',
          createdBy: actor,
        },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO intel_legiwatch_folder_bill(id,tenant_id,folder_id,bill_id,jurisdiction,session_key,updated_by,updated_at,added_date_raw,added_date_precision)
         VALUES ($4,$1,$2,$3,'GA','2099',$5,now(),'2026-01-01','date') ON CONFLICT DO NOTHING`,
        foreign,
        folderId,
        gaBill,
        randomUUID(),
        actor,
      );
    });
  }, 30000);

  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.legiWatchFolderBill.deleteMany({ where: { tenantId: foreign } });
      await tx.legiWatchFolder.deleteMany({ where: { tenantId: foreign } });
      await tx.$executeRawUnsafe(
        'DELETE FROM state_bill WHERE id = ANY($1::text[])',
        [flRegular, flSpecial, gaBill, flH27, maH27],
      );
      await tx.$executeRawUnsafe('DELETE FROM congress_bill WHERE id = ANY($1::text[])', [
        fed119,
        fed117,
      ]);
      await tx.$executeRaw`DELETE FROM tenant_memberships WHERE tenant_id=${tenant}::uuid`;
      await tx.$executeRaw`DELETE FROM users WHERE clerk_user_id=${actor}`;
      await tx.$executeRaw`DELETE FROM tenants WHERE id IN (${tenant}::uuid,${foreign}::uuid)`;
    });
    await prisma.$disconnect();
  });

  it('finds an untracked federal bill with no jurisdiction/session filter', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'Corpus marker federal current' });
    expect(page.rows.map((r) => r.id)).toContain(fed119);
    expect(page.rows.find((r) => r.id === fed119)?.jurisdiction).toBe('US');
    expect(page.rows.find((r) => r.id === fed119)?.sessionKey).toBe('119');
    expect(page.rows.find((r) => r.id === fed119)?.assignmentId).toBeNull();
  });

  it('finds an older-Congress federal bill (no current-Congress gate)', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'Corpus marker federal older' });
    const hit = page.rows.find((r) => r.id === fed117);
    expect(hit).toBeTruthy();
    expect(hit?.sessionKey).toBe('117');
  });

  it('finds state bills in every ingested jurisdiction, not only Florida', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'Corpus marker Georgia regular' });
    expect(page.rows.find((r) => r.id === gaBill)?.jurisdiction).toBe('GA');
  });

  it('finds special-session bills with no session filter', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'Corpus marker Florida special' });
    expect(page.rows.find((r) => r.id === flSpecial)?.sessionKey).toBe('2099x1');
  });

  it('explicit jurisdiction + session filters still scope the corpus exactly', async () => {
    const filtered = await svc.searchCorpus(ctx, {
      q: 'Corpus marker',
      jurisdiction: 'FL',
      sessionKey: '2099x1',
    });
    expect(filtered.rows.map((r) => r.id)).toEqual([flSpecial]);
  });

  it.each(['HR 9001', 'H.R. 9001', 'H R 9001'])('matches federal punctuation variant %s', async (q) => {
    const page = await svc.searchCorpus(ctx, { q });
    expect(page.rows.map((r) => r.id)).toContain(fed119);
  });

  it.each(['HB 9001', 'H B 9001'])('matches state punctuation variant %s', async (q) => {
    const page = await svc.searchCorpus(ctx, { q, jurisdiction: 'FL', sessionKey: '2099' });
    expect(page.rows.map((r) => r.id)).toContain(flRegular);
  });

  it('jurisdiction-less "H 27" matches the FL alias row AND the MA row (row-local alias)', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'H 27' });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(flH27);
    expect(ids).toContain(maH27);
  });

  it('a GA "H 27" stays distinct from the FL alias (no global H→HB conversion)', async () => {
    // GA has no H→HB alias; only the MA row + FL row answer "H 27" here.
    const page = await svc.searchCorpus(ctx, { q: 'H 27', jurisdiction: 'GA' });
    expect(page.rows.map((r) => r.id)).not.toContain(flH27);
  });

  it('paginates the true total beyond the first page with no duplicate ids', async () => {
    const first = await svc.searchCorpus(ctx, { q: 'Corpus marker', limit: 2 });
    expect(first.total).toBeGreaterThan(2);
    expect(first.nextCursor).toBeTruthy();
    const seen = new Set(first.rows.map((r) => r.id));
    let cursor = first.nextCursor;
    let walked = first.rows.length;
    while (cursor) {
      const page = await svc.searchCorpus(ctx, { q: 'Corpus marker', limit: 2, cursor });
      for (const r of page.rows) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      walked += page.rows.length;
      cursor = page.nextCursor;
    }
    expect(walked).toBe(first.total);
  });

  it('never leaks a foreign tenant’s private folder assignment into corpus rows', async () => {
    const page = await svc.searchCorpus(ctx, { q: 'Corpus marker Georgia regular' });
    const hit = page.rows.find((r) => r.id === gaBill);
    expect(hit?.assignmentId).toBeNull();
    expect(hit?.folderId).toBeNull();
    expect(hit?.internalComments).toBeNull();
    // The foreign tenant itself sees only global columns on the corpus route.
    const foreignPage = await svc.searchCorpus(foreignCtx, { q: 'Corpus marker Georgia regular' });
    expect(foreignPage.rows.find((r) => r.id === gaBill)?.internalComments).toBeNull();
  });

  it('the folder board still requires jurisdiction and session', async () => {
    await expect(svc.board(ctx, {} as never, false)).rejects.toThrow(
      'JURISDICTION_AND_SESSION_REQUIRED',
    );
    await expect(svc.board(ctx, { jurisdiction: 'FL' } as never, false)).rejects.toThrow(
      'JURISDICTION_AND_SESSION_REQUIRED',
    );
  });

  it('corpus metadata reflects only ingested jurisdictions and sessions', async () => {
    const meta = await source.corpusMetadata();
    const keys = meta.jurisdictions.map((j) => j.key);
    expect(keys).toContain('US');
    expect(keys).toContain('FL');
    expect(keys).toContain('GA');
    expect(keys).toContain('MA');
    expect(meta.sessions.some((s) => s.jurisdiction === 'FL' && s.key === '2099x1')).toBe(true);
  });
});
