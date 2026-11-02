import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { withStateBillWriter } from './state-bill-writer.js';
import { withFederalBillWriter } from './federal-bill-writer.js';
import { enrichFederalBulkMetadata } from './federal-billstatus-import.js';
import { publisherCooldown } from './state-publisher-document.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared state writer lease on disposable PostgreSQL', () => {
  jest.setTimeout(30000);
  let admin: PrismaClient, db: PrismaClient;
  const schema = 'bill_writer_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const value = process.env.BILL_STATE_WRITER_TEST_DATABASE_URL;
    if (!value) throw Error('BILL_STATE_WRITER_TEST_DATABASE_URL_REQUIRED');
    const url = new URL(value);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/bill_text_test'
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    admin = new PrismaClient({ datasources: { db: { url: value } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('schema', schema);
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20280924030000_federal_legislative_evidence/migration.sql',
      ),
      'utf8',
    );
    const checkpointDDL = migration.match(
      /CREATE TABLE "federal_evidence_checkpoint" \([\s\S]*?\n\);/,
    )?.[0];
    if (
      !checkpointDDL ||
      !migration.includes(
        'GRANT SELECT, INSERT, UPDATE ON federal_evidence_change_outbox, federal_evidence_checkpoint TO capiro_app;',
      )
    )
      throw Error('CANONICAL_CHECKPOINT_CONTRACT_MISSING');
    await db.$executeRawUnsafe(checkpointDDL);
    await db.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN CREATE ROLE capiro_app; END IF; END $$`,
    );
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${schema} TO capiro_app`);
    // The checkpoint subset of the canonical migration grant; unrelated outbox is not in this fixture.
    await db.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE ON federal_evidence_checkpoint TO capiro_app',
    );
    await db.$executeRawUnsafe('CREATE TABLE marker(value integer)');
    await db.$executeRawUnsafe('INSERT INTO marker VALUES(0)');
    await db.$executeRawUnsafe(
      'CREATE TABLE congress_bill(id text PRIMARY KEY,title text,subjects text[],cosponsors_count integer,update_date timestamptz)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE congress_bill_subject(id text PRIMARY KEY,bill_id text REFERENCES congress_bill(id),name text)',
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE congress_bill_cosponsor(id uuid PRIMARY KEY,bill_id text REFERENCES congress_bill(id),bioguide_id text,full_name text,party text,state text,district integer,sponsorship_date date,is_original boolean,withdrawn_date date,last_synced_at timestamptz,UNIQUE(bill_id,bioguide_id))`,
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE legal_source_receipt(id text PRIMARY KEY,source text,scope jsonb,manifest jsonb,complete boolean,observed_at timestamptz DEFAULT clock_timestamp())',
    );
  });
  it('persists per-host cooldowns across clients with atomic maximum expiry and existing app grants', async () => {
    const asApp = <T>(run: (tx: any) => Promise<T>) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        return run(tx);
      });
    const host = 'www.flsenate.gov';
    await Promise.all([
      asApp((tx) => publisherCooldown(tx).hold(host, 3600000, 429)),
      asApp((tx) => publisherCooldown(tx).hold(host, 60000, 503)),
    ]);
    const first = await db.$queryRawUnsafe<Array<{ deadline: Date }>>(
      'SELECT window_end AS deadline FROM federal_evidence_checkpoint WHERE source=$1',
      'bill-publisher:cooldown:' + host,
    );
    // A different adapter/client after the first process exits sees the shared hold.
    expect(await asApp((tx) => publisherCooldown(tx).remaining(host))).toBeGreaterThan(3500000);
    expect(await asApp((tx) => publisherCooldown(tx).remaining('www.flhouse.gov'))).toBe(0);
    await asApp((tx) => publisherCooldown(tx).hold(host, 1000, 503));
    expect(
      await db.$queryRawUnsafe(
        'SELECT window_end AS deadline FROM federal_evidence_checkpoint WHERE source=$1',
        'bill-publisher:cooldown:' + host,
      ),
    ).toEqual(first);
    await db.$executeRawUnsafe(
      "UPDATE federal_evidence_checkpoint SET window_end=clock_timestamp()-interval '1 second' WHERE source=$1",
      'bill-publisher:cooldown:' + host,
    );
    expect(await asApp((tx) => publisherCooldown(tx).remaining(host))).toBe(0);
    const privileges = await asApp((tx) =>
      tx.$queryRawUnsafe(
        `SELECT has_table_privilege(current_user,'federal_evidence_checkpoint','SELECT') AS read,
       has_table_privilege(current_user,'federal_evidence_checkpoint','INSERT') AS insert,
       has_table_privilege(current_user,'federal_evidence_checkpoint','UPDATE') AS update,
       has_table_privilege(current_user,'federal_evidence_checkpoint','DELETE') AS delete`,
      ),
    );
    expect(privileges).toEqual([{ read: true, insert: true, update: true, delete: false }]);
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.$disconnect();
    }
  });
  it('admits one job and refuses a competing job across distinct logical sources', async () => {
    await withStateBillWriter(db, ['FL'], async (writer) => {
      const loser = jest.fn();
      await expect(withStateBillWriter(db, ['FL'], loser)).rejects.toThrow(
        'STATE_WRITER_ALREADY_RUNNING',
      );
      expect(loser).not.toHaveBeenCalled();
      await writer.$executeRawUnsafe('UPDATE marker SET value=1');
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 1 }]);
  });
  it('fences an expired process after successor ownership, without releasing the successor token', async () => {
    await withStateBillWriter(db, ['FL'], async (stale) => {
      await db.$executeRawUnsafe(
        "UPDATE federal_evidence_checkpoint SET lease_until=clock_timestamp()-interval '1 second' WHERE source='state-bills:FL'",
      );
      await withStateBillWriter(db, ['FL'], async (current) => {
        await expect(stale.$executeRawUnsafe('UPDATE marker SET value=99')).rejects.toThrow(
          'STATE_WRITER_LEASE_LOST',
        );
        await current.$executeRawUnsafe('UPDATE marker SET value=2');
      });
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 2 }]);
  });
  it('keeps canonical nested writes in the fenced transaction and rolls back failures', async () => {
    await withStateBillWriter(db, ['FL'], async (writer) => {
      await expect(
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('UPDATE marker SET value=99');
          throw Error('synthetic rollback');
        }),
      ).rejects.toThrow('synthetic rollback');
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 2 }]);
  });
  it('serializes ordinary Congress sync and FY26 writer while keeping state leases independent', async () => {
    await withFederalBillWriter(db, async (standard) => {
      await expect(withFederalBillWriter(db, async () => {})).rejects.toThrow(
        'FEDERAL_WRITER_ALREADY_RUNNING',
      );
      await withStateBillWriter(db, ['FL'], async (state) => {
        await state.$executeRawUnsafe('UPDATE marker SET value=3');
      });
      await db.$executeRawUnsafe(
        "UPDATE federal_evidence_checkpoint SET lease_until=clock_timestamp()-interval '1 second' WHERE source='congress-bills'",
      );
      await withFederalBillWriter(db, async (current) => {
        await expect(standard.$executeRawUnsafe('UPDATE marker SET value=99')).rejects.toThrow(
          'FEDERAL_WRITER_LEASE_LOST',
        );
        await current.$executeRawUnsafe('UPDATE marker SET value=4');
      });
    });
    expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 4 }]);
  });
  it('atomically enriches canonical metadata and rolls back it with receipt failure', async () => {
    await db.$executeRawUnsafe(
      "INSERT INTO congress_bill VALUES('119-hr-1','Preserved title',ARRAY['old'],1,'2026-01-01T00:00:00Z')",
    );
    const bill = {
      id: '119-hr-1',
      eligible: true,
      providerUpdatedAt: '2026-02-01',
      metadataUpdatedAt: '2026-02-01',
      subjects: ['Synthetic subject'],
      cosponsors: [
        {
          bioguideId: 'A000001',
          fullName: 'Synthetic member',
          party: 'X',
          state: 'FL',
          district: 1,
          sponsorshipDate: '2026-01-01',
          withdrawnDate: null,
          isOriginal: true,
        },
      ],
      cosponsorEpisodes: [],
      versions: [],
      amendments: [],
    };
    await withFederalBillWriter(db, (writer) =>
      enrichFederalBulkMetadata(writer, bill, 'a'.repeat(64)),
    );
    expect(
      await db.$queryRawUnsafe('SELECT title,subjects,cosponsors_count FROM congress_bill'),
    ).toEqual([{ title: 'Preserved title', subjects: ['Synthetic subject'], cosponsors_count: 1 }]);
    expect(
      await db.$queryRawUnsafe('SELECT bioguide_id,withdrawn_date FROM congress_bill_cosponsor'),
    ).toEqual([{ bioguide_id: 'A000001', withdrawn_date: null }]);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_receipt BEFORE INSERT ON legal_source_receipt FOR EACH ROW EXECUTE FUNCTION fail_receipt()',
    );
    await expect(
      withFederalBillWriter(db, (writer) =>
        enrichFederalBulkMetadata(
          writer,
          { ...bill, subjects: [], cosponsors: [] },
          'b'.repeat(64),
        ),
      ),
    ).rejects.toThrow('synthetic receipt failure');
    expect(await db.$queryRawUnsafe('SELECT subjects,cosponsors_count FROM congress_bill')).toEqual(
      [{ subjects: ['Synthetic subject'], cosponsors_count: 1 }],
    );
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM congress_bill_cosponsor'),
    ).toEqual([{ n: 1 }]);
    await db.$executeRawUnsafe('DROP TRIGGER fail_receipt ON legal_source_receipt');
    expect(
      await withFederalBillWriter(db, (writer) =>
        enrichFederalBulkMetadata(
          writer,
          { ...bill, metadataUpdatedAt: '2026-01-15', subjects: [], cosponsors: [] },
          'c'.repeat(64),
        ),
      ),
    ).toBe('held');
    expect(await db.$queryRawUnsafe('SELECT subjects FROM congress_bill')).toEqual([
      { subjects: ['Synthetic subject'] },
    ]);
  });
});
