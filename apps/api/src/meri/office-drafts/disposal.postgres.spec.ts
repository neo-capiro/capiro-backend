import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { officeDatabase } from './postgres-fixture.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { openDraft, saveDraft } from './store.js';
import { readOfficeDraftRetention, retireOfficeDrafts } from './retention-subject.js';

const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Office disposal excludes remotely unfinished effects on ordinary PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
  it('fences an empty artifact before a delayed Open arrives, across a new connection and draft expiry', async () => {
    const f = await officeDraftFixture(db, scoped), artifactId = randomUUID();
    const subject = { tenantId: f.ports.ctx.tenantId, subject: { kind: 'artifact', id: artifactId } };
    const source = { ...f.source, draftId: randomUUID(), artifactId };
    expect(await readOfficeDraftRetention(scoped, subject)).toMatchObject({ active: 0, bytes: 0, fenced: false });
    expect(await retireOfficeDrafts(scoped, subject)).toMatchObject({ retired: 0, remaining: false, fenced: true });
    const fresh = await officeDatabase(url!);
    try {
      await expect(openDraft({ ...f.ports, prisma: fresh.scoped }, source)).rejects.toThrow('CLOSED');
      expect(await readOfficeDraftRetention(fresh.scoped, subject)).toMatchObject({ drafts: 0, active: 0, bytes: 0, fenced: true });
    } finally { await fresh.db.$disconnect(); }
    await retireOfficeDrafts(scoped, { ...subject, subject: { kind: 'artifact', id: f.source.artifactId } });
    await db.$executeRaw`DELETE FROM meri_office_drafts WHERE tenant_id=${f.ports.ctx.tenantId}::uuid`;
    await expect(openDraft(f.ports, f.source)).rejects.toThrow('CLOSED');
  });
  it('waits for a Save already holding the custody lock, then erases its eventual bytes', async () => {
    const f = await officeDraftFixture(db, scoped); await f.lock();
    const admitted = gate(), finish = gate(); let reads = 0;
    const original = f.ports.authority.readCurrent;
    const authority = { readCurrent: async (tx?: Parameters<typeof original>[0]) => {
      if (++reads === 2) { admitted.release(); await finish.promise; }
      return original(tx);
    } };
    const writer = saveDraft({ ...f.ports, authority }, f.save('late remote save'));
    await admitted.promise;
    let settled = false;
    const subject = { tenantId: f.ports.ctx.tenantId, subject: { kind: 'artifact', id: f.source.artifactId } };
    const retire = retireOfficeDrafts(scoped, subject).finally(() => { settled = true; });
    try {
      // Observe the database's actual waiter; elapsed time alone is not evidence.
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
        waiting = rows[0]!.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); expect(settled).toBe(false);
    } finally { finish.release(); }
    await writer;
    expect(await retire).toMatchObject({ retired: 1, remaining: false, fenced: true });
    expect(await readOfficeDraftRetention(scoped, subject)).toMatchObject({ active: 0, bytes: 0, fenced: true });
    await expect(saveDraft(f.ports, f.save('another late save', 1))).rejects.toThrow('CLOSED');
  });
  it('denies ordinary fence writes and cross-tenant reads', async () => {
    const f = await officeDraftFixture(db, scoped), other = await officeDraftFixture(db, scoped);
    const tenantId = f.ports.ctx.tenantId, artifactId = f.source.artifactId;
    await expect(scoped.withTenant(tenantId, tx => tx.$executeRaw`INSERT INTO meri_office_disposed_subjects
      (tenant_id,subject_kind,subject_id) VALUES (${tenantId}::uuid,'artifact',${artifactId}::uuid)`)).rejects.toThrow();
    await retireOfficeDrafts(scoped, { tenantId, subject: { kind: 'artifact', id: artifactId } });
    expect(await scoped.withTenant(other.ports.ctx.tenantId, tx => tx.$queryRaw`SELECT * FROM meri_office_disposed_subjects
      WHERE tenant_id=${tenantId}::uuid`)).toEqual([]);
    await expect(scoped.withTenant(tenantId, tx => tx.$executeRaw`DELETE FROM meri_office_disposed_subjects
      WHERE tenant_id=${tenantId}::uuid`)).rejects.toThrow();
  });
});
