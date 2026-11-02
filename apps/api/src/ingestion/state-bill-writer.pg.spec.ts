import { randomUUID, createHash } from 'node:crypto';
import JSZip from 'jszip';
import { inspectFrozenStateFormats, importFrozenStateFormats } from './legiscan-frozen-formats.js';
import {
  requireQualifiedAlternateFormat,
  stateDocumentCheckIdentity,
} from './state-document-formats.js';
import { PrismaClient } from '@prisma/client';
import { withStateBillWriter } from './state-bill-writer.js';
import { withFederalBillWriter } from './federal-bill-writer.js';
import { enrichFederalBulkMetadata } from './federal-billstatus-import.js';
import { publisherCooldown } from './state-publisher-document.js';
import { persistVoteRevision } from './legiscan-vote-revisions.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { persistFederalBulkParent } from './federal-bulk-parent.js';
import { parseFederalBillStatusXml } from './federal-billstatus.js';
import {
  replaceCongressBillActionsAtomically,
  type NormalizedCongressAction,
} from '../../scripts/lib/congress-actions.js';

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
    // Only the canonical vote owner's required state columns; vote/record DDL
    // comes from the immutable migrations, including indexes and app grants.
    await db.$executeRawUnsafe(
      'CREATE TABLE state_bill(id text PRIMARY KEY,state text,legiscan_bill_id integer)',
    );
    const migrationText = (name: string) =>
      readFileSync(
        resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      ).replace(/\r\n/g, '\n');
    const truth = migrationText('20260710000000_state_truth_layer');
    const records = migrationText('20280910010000_legiwatch_published_records');
    for (const [table, source] of [
      ['state_roll_call_vote', truth],
      ['state_member_vote', truth],
      ['state_bill_published_record', records],
    ]) {
      const start = source!.indexOf('CREATE TABLE "' + table + '" (');
      const end = source!.indexOf('\n);', start);
      if (start < 0 || end < start) throw Error('CANONICAL_VOTE_FIXTURE_DDL_MISSING');
      await db.$executeRawUnsafe(source!.slice(start, end + 3));
      const indexes =
        source!.match(new RegExp('CREATE (?:UNIQUE )?INDEX "' + table + '[^;]+;', 'g')) ?? [];
      for (const index of indexes) await db.$executeRawUnsafe(index);
    }
    await db.$executeRawUnsafe(
      'ALTER TABLE state_roll_call_vote ADD COLUMN current_revision_hash TEXT, ADD COLUMN provider_bill_hash TEXT, ALTER COLUMN date DROP NOT NULL',
    );
    await db.$executeRawUnsafe(
      "ALTER TABLE state_bill_published_record ADD CONSTRAINT published_record_kind CHECK(kind IN ('action','amendment','vote','document'))",
    );
    await db.$executeRawUnsafe(
      'ALTER TABLE state_bill_published_record ADD CONSTRAINT published_record_bill_fk FOREIGN KEY(bill_key) REFERENCES state_bill(id)',
    );
    const checkMigration = migrationText('20280913011000_legiwatch_record_checks');
    for (const statement of checkMigration
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await db.$executeRawUnsafe(statement);
    await db.$executeRawUnsafe('GRANT SELECT ON state_bill TO capiro_app');
    await db.$executeRawUnsafe(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON state_roll_call_vote,state_member_vote TO capiro_app',
    );
    await db.$executeRawUnsafe('GRANT SELECT,INSERT ON state_bill_published_record TO capiro_app');
    await db.$executeRawUnsafe(
      'REVOKE UPDATE,DELETE,TRUNCATE ON state_bill_published_record FROM capiro_app',
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
  it('renews after its own real foreground row lock exceeds the heartbeat transaction timeout', async () => {
    const originalInterval = global.setInterval;
    const originalTransaction = db.$transaction.bind(db);
    let pulse: (() => void) | undefined;
    let enter!: () => void, renewed!: (error: unknown) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const heartbeat = new Promise<unknown>((resolve) => { renewed = resolve; });
    const intervals = jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 30000) pulse = callback;
      return originalInterval(callback, ms);
    }) as typeof setInterval);
    // Observe completion without mocking the transaction, lock, timeout or SQL.
    const transactions = jest.spyOn(db, '$transaction').mockImplementation(((callback: unknown, options?: unknown) => {
      const result = (originalTransaction as any)(callback, options) as Promise<unknown>;
      if (options === undefined) void result.then(() => renewed(null), (error) => renewed(error));
      return result;
    }) as typeof db.$transaction);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const task = withStateBillWriter(db, ['PA'], async (writer) => {
        await writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('UPDATE marker SET value=5');
          enter();
          // Prisma's unconfigured heartbeat transaction expires after 5 s;
          // the unchanged foreground transaction explicitly permits 60 s.
          await tx.$queryRawUnsafe('SELECT pg_sleep(6.5)::text');
        });
        expect(await heartbeat).toBeNull();
        await writer.$executeRawUnsafe('UPDATE marker SET value=6');
      });
      await entered;
      expect(pulse).toBeDefined();
      pulse!();
      await task;
      expect(log).not.toHaveBeenCalled();
      expect(await db.$queryRawUnsafe('SELECT value FROM marker')).toEqual([{ value: 6 }]);
      expect(await db.$queryRawUnsafe(
        "SELECT status,lease_token IS NULL AND lease_until IS NULL AS released FROM federal_evidence_checkpoint WHERE source='state-bills:PA'",
      )).toEqual([{ status: 'idle', released: true }]);
    } finally {
      intervals.mockRestore();
      transactions.mockRestore();
      log.mockRestore();
    }
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
  it('resolves only the exact partial vote check atomically with the fenced canonical revision', async () => {
    await db.$executeRawUnsafe(
      "INSERT INTO state_bill(id,state,legiscan_bill_id) VALUES('tx-2025-hb1','TX',1),('tx-2025-hb2','TX',2)",
    );
    await db.$executeRawUnsafe(`INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at,error_code,provider_hash)
      VALUES('tx-2025-hb1','vote','tx-rc-9','partial',1,clock_timestamp()+interval '3 hours','LEGISCAN_VOTE_DETAIL_INCOMPLETE','old'),
      ('tx-2025-hb1','vote','tx-rc-10','partial',1,clock_timestamp(),'LEGISCAN_VOTE_DETAIL_INCOMPLETE','old'),
      ('tx-2025-hb2','vote','tx-rc-9','partial',1,clock_timestamp(),'LEGISCAN_VOTE_DETAIL_INCOMPLETE','old'),
      ('tx-2025-hb1','document','tx-rc-9','partial',1,clock_timestamp(),'LEGISCAN_VOTE_DETAIL_INCOMPLETE','old')`);
    const vote = {
      roll_call_id: 9,
      bill_id: 1,
      yea: 1,
      nay: 0,
      nv: 0,
      absent: 0,
      total: 1,
      desc: 'Synthetic complete vote',
      votes: [{ people_id: 1, vote_text: 'Yea' }],
    };
    const write = (value = vote, state = 'TX', billKey = 'tx-2025-hb1') =>
      withStateBillWriter(db, [state], (writer) =>
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          await persistVoteRevision(tx as unknown as PrismaClient, state, billKey, value, {
            historical: true,
            providerBillId: 1,
            providerBillHash: 'corrected',
            stub: { roll_call_id: 9 },
          });
        }),
      );
    await expect(write({ ...vote, total: 2 })).rejects.toThrow('LEGISCAN_VOTE_DETAIL_INCOMPLETE');
    await expect(write(vote, 'TX', 'tx-2025-hb2')).rejects.toThrow('LEGISCAN_VOTE_BILL_MISMATCH');
    await expect(write(vote, 'FL')).rejects.toThrow('LEGISCAN_VOTE_BILL_MISMATCH');
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM state_bill_published_record'),
    ).toEqual([{ n: 0 }]);
    await write();
    const first = await db.stateBillPublishedRecord.findFirstOrThrow({
      where: { billKey: 'tx-2025-hb1', kind: 'vote' },
    });
    const member = await db.stateMemberVote.findFirstOrThrow({ where: { voteId: 'tx-rc-9' } });
    expect(
      await db.$queryRawUnsafe(`SELECT state,attempts,next_check_at,error_code,revision_hash FROM state_bill_record_check
      WHERE bill_key='tx-2025-hb1' AND kind='vote' AND source_identity='tx-rc-9'`),
    ).toEqual([
      {
        state: 'available',
        attempts: 1,
        next_check_at: null,
        error_code: null,
        revision_hash: first.revisionHash,
      },
    ]);
    expect(
      await db.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM state_bill_record_check WHERE state='partial'",
      ),
    ).toEqual([{ n: 3 }]);
    await db.$executeRawUnsafe(`UPDATE state_bill_record_check SET state='partial',error_code='LEGISCAN_VOTE_DETAIL_INCOMPLETE'
      WHERE bill_key='tx-2025-hb1' AND kind='vote' AND source_identity='tx-rc-9'`);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_vote_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic vote check failure'; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_vote_check BEFORE UPDATE ON state_bill_record_check FOR EACH ROW EXECUTE FUNCTION fail_vote_check()',
    );
    const corrected = { ...vote, desc: 'Corrected motion' };
    await expect(write(corrected)).rejects.toThrow('synthetic vote check failure');
    expect(
      await db.stateRollCallVote.findUniqueOrThrow({ where: { id: 'tx-rc-9' } }),
    ).toMatchObject({ currentRevisionHash: first.revisionHash, motion: vote.desc });
    expect(await db.stateBillPublishedRecord.count()).toBe(1);
    expect(await db.stateMemberVote.findUniqueOrThrow({ where: { id: member.id } })).toEqual(
      member,
    );
    expect(
      await db.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM state_bill_record_check WHERE state='partial'",
      ),
    ).toEqual([{ n: 4 }]);
    await db.$executeRawUnsafe('DROP TRIGGER fail_vote_check ON state_bill_record_check');
    await write(corrected);
    expect(await db.stateBillPublishedRecord.count()).toBe(2);
    expect(
      await db.stateBillPublishedRecord.findUniqueOrThrow({ where: { id: first.id } }),
    ).toEqual(first);
    expect(await db.stateMemberVote.findUniqueOrThrow({ where: { id: member.id } })).toEqual(
      member,
    );
    expect(
      await db.$queryRawUnsafe(
        "SELECT count(*)::int AS n FROM state_bill_record_check WHERE state='partial'",
      ),
    ).toEqual([{ n: 3 }]);
    expect(
      await db.$queryRawUnsafe(`SELECT has_table_privilege('capiro_app','state_bill_record_check','UPDATE') AS update,
      has_table_privilege('capiro_app','state_bill_record_check','DELETE') AS delete`),
    ).toEqual([{ update: true, delete: false }]);
  });
  it('keeps Congress action replacement and delivery atomic through raw Prisma and the federal callback facade', async () => {
    const readMigration = (name: string) =>
      readFileSync(
        resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      ).replace(/\r\n/g, '\n');
    const actionsDDL = readMigration('20260521030000_intel_optimization');
    const evidenceDDL = readMigration('20280924030000_federal_legislative_evidence');
    for (const [table, source] of [
      ['congress_bill_action', actionsDDL],
      ['federal_evidence_revision', evidenceDDL],
      ['federal_evidence_mention_event', evidenceDDL],
      ['federal_evidence_change_outbox', evidenceDDL],
    ]) {
      const start = source!.indexOf(`CREATE TABLE "${table}" (`),
        end = source!.indexOf('\n);', start);
      if (start < 0 || end < start) throw Error('CANONICAL_ACTION_FIXTURE_DDL_MISSING');
      await db.$executeRawUnsafe(source!.slice(start, end + 3));
      for (const index of source!.match(
        new RegExp('CREATE (?:UNIQUE )?INDEX "' + table + '[^;]+;', 'g'),
      ) ?? [])
        await db.$executeRawUnsafe(index);
    }
    const foreignKey = actionsDDL.match(/ALTER TABLE "congress_bill_action"[^;]+;/)?.[0];
    const immutableFunction = readMigration('20280913010000_legiwatch_record_revisions').match(
      /CREATE FUNCTION legiwatch_reject_record_rewrite\(\)[\s\S]*?\$\$;/,
    )?.[0];
    const immutableTrigger = evidenceDDL.match(
      /CREATE TRIGGER federal_evidence_mention_event_immutable[\s\S]*?;/,
    )?.[0];
    if (!foreignKey || !immutableFunction || !immutableTrigger)
      throw Error('CANONICAL_ACTION_FIXTURE_CONSTRAINT_MISSING');
    await db.$executeRawUnsafe(foreignKey);
    await db.$executeRawUnsafe(immutableFunction);
    await db.$executeRawUnsafe(immutableTrigger);
    await db.$executeRawUnsafe('GRANT SELECT,INSERT,DELETE ON congress_bill_action TO capiro_app');
    await db.$executeRawUnsafe(
      'GRANT SELECT,INSERT ON federal_evidence_mention_event TO capiro_app',
    );
    await db.$executeRawUnsafe(
      'GRANT SELECT,INSERT,UPDATE ON federal_evidence_change_outbox TO capiro_app',
    );
    const billId = '119-s-999';
    await db.$executeRawUnsafe(
      'INSERT INTO congress_bill(id,title) VALUES($1,$2)',
      billId,
      'Synthetic action transaction',
    );
    const first = {
      date: new Date('2026-01-01'),
      text: 'Synthetic introduction',
      type: 'IntroReferral',
      chamber: 'Senate',
    };
    const later = {
      date: new Date('2026-01-02'),
      text: 'Synthetic later action',
      type: null,
      chamber: null,
    };
    const failed = {
      date: new Date('2026-01-03'),
      text: 'Synthetic rolled-back action',
      type: null,
      chamber: null,
    };
    const run = (actions: NormalizedCongressAction[]) =>
      withFederalBillWriter(db, (writer) =>
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          await replaceCongressBillActionsAtomically(
            tx as unknown as PrismaClient,
            billId,
            actions,
          );
        }),
      );
    const snapshot = async () => ({
      actions: await db.$queryRawUnsafe(
        'SELECT date,text,type,chamber FROM congress_bill_action WHERE bill_id=$1 ORDER BY date,text',
        billId,
      ),
      baseline: await db.$queryRawUnsafe(
        'SELECT cursor_jsonb,status,completed_at FROM federal_evidence_checkpoint WHERE source=$1',
        `congress-actions:${billId}`,
      ),
      events: await db.$queryRawUnsafe(
        'SELECT event_key,raw_mention,historical FROM federal_evidence_mention_event WHERE bill_id=$1 ORDER BY event_key',
        billId,
      ),
      outbox: await db.$queryRawUnsafe(
        "SELECT dedupe_key,payload_jsonb FROM federal_evidence_change_outbox WHERE payload_jsonb->>'billId'=$1 ORDER BY dedupe_key",
        billId,
      ),
    });
    // Ordinary raw Prisma remains supported, and the first backfill stays silent.
    await replaceCongressBillActionsAtomically(db, billId, [first]);
    expect(
      await db.$queryRawUnsafe('SELECT count(*)::int n FROM federal_evidence_change_outbox'),
    ).toEqual([{ n: 0 }]);
    await run([first, later]);
    const initial = await snapshot();
    expect(initial.actions).toEqual([first, later]);
    expect(initial.events).toHaveLength(1);
    expect(initial.outbox).toHaveLength(1);
    await run([first, later]);
    await run([first]);
    await run([first, later]);
    const deduped = await snapshot();
    expect(deduped.events).toEqual(initial.events);
    expect(deduped.outbox).toEqual(initial.outbox);
    // Fail after history, checkpoint and event writes, proving all roll back together.
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_action_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic action outbox failure'; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_action_outbox BEFORE INSERT ON federal_evidence_change_outbox FOR EACH ROW EXECUTE FUNCTION fail_action_outbox()',
    );
    await expect(run([first, later, failed])).rejects.toThrow('synthetic action outbox failure');
    expect(await snapshot()).toEqual(deduped);
    await db.$executeRawUnsafe('DROP TRIGGER fail_action_outbox ON federal_evidence_change_outbox');
  });
  it('admits refresh parents and actions atomically and holds older archives under the same federal lease', async () => {
    // Extend only this isolated synthetic parent table with the canonical projection columns.
    await db.$executeRawUnsafe(`ALTER TABLE congress_bill
      ADD COLUMN congress integer, ADD COLUMN bill_type text, ADD COLUMN bill_number text,
      ADD COLUMN introduced_date date, ADD COLUMN sponsor_name text, ADD COLUMN sponsor_state text,
      ADD COLUMN sponsor_party text, ADD COLUMN sponsor_bioguide_id text, ADD COLUMN latest_action_text text,
      ADD COLUMN latest_action_date date, ADD COLUMN policy_area text, ADD COLUMN origin_chamber text,
      ADD COLUMN update_date_including_text timestamptz, ADD COLUMN pe_codes text[] DEFAULT '{}',
      ADD COLUMN committees jsonb DEFAULT '[]', ADD COLUMN last_synced_at timestamptz DEFAULT now(),
      ADD COLUMN url text`);
    await db.$executeRawUnsafe('GRANT SELECT,INSERT,UPDATE ON congress_bill TO capiro_app');
    await db.$executeRawUnsafe('GRANT SELECT ON legal_source_receipt TO capiro_app');
    const input = parseFederalBillStatusXml(
      `<billStatus><bill><congress>119</congress><type>HR</type><number>998</number><title>Synthetic refresh parent</title><introducedDate>2026-01-01</introducedDate><updateDate>2026-01-02T00:00:00Z</updateDate><actions><item><actionDate>2026-01-01</actionDate><text>Introduced</text></item></actions></bill></billStatus>`,
      { congress: 119, billType: 'hr' },
    );
    const run = (fail = false) =>
      withFederalBillWriter(db, (writer) =>
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          const result = await persistFederalBulkParent(tx as unknown as PrismaClient, input);
          if (fail) throw Error('synthetic after-refresh-parent failure');
          return result;
        }),
      );
    await expect(run(true)).rejects.toThrow('after-refresh-parent failure');
    expect(await db.$queryRawUnsafe('SELECT id FROM congress_bill WHERE id=$1', input.id)).toEqual(
      [],
    );
    expect(
      await db.$queryRawUnsafe(
        'SELECT bill_id FROM congress_bill_action WHERE bill_id=$1',
        input.id,
      ),
    ).toEqual([]);
    expect(await run()).toMatchObject({ status: 'written' });
    expect(
      await db.$queryRawUnsafe('SELECT title,url FROM congress_bill WHERE id=$1', input.id),
    ).toEqual([
      {
        title: 'Synthetic refresh parent',
        url: 'https://www.congress.gov/bill/119th-congress/house-bill/998',
      },
    ]);
    expect(
      await db.$queryRawUnsafe('SELECT text FROM congress_bill_action WHERE bill_id=$1', input.id),
    ).toEqual([{ text: 'Introduced' }]);
    await db.$executeRawUnsafe(
      "UPDATE congress_bill SET title='Newer canonical title',update_date_including_text='2026-02-01' WHERE id=$1",
      input.id,
    );
    expect(await run()).toMatchObject({ status: 'held' });
    expect(
      await db.$queryRawUnsafe('SELECT title FROM congress_bill WHERE id=$1', input.id),
    ).toEqual([{ title: 'Newer canonical title' }]);
    expect(
      await db.$queryRawUnsafe(
        "SELECT count(*)::int n FROM federal_evidence_change_outbox WHERE payload_jsonb->>'billId'=$1",
        input.id,
      ),
    ).toEqual([{ n: 0 }]);
  });
  it('stages archived alternate formats with app grants, fenced rollback and no primary retry or metadata changes', async () => {
    await db.$executeRawUnsafe('ALTER TABLE state_bill ADD COLUMN report_source_facts jsonb');
    await db.$executeRawUnsafe(
      'CREATE TABLE legal_dataset_archive(content_hash text PRIMARY KEY,original_bytes_base64 text NOT NULL)',
    );
    await db.$executeRawUnsafe(
      'GRANT SELECT,INSERT ON legal_source_receipt,legal_dataset_archive TO capiro_app',
    );
    await db.$executeRawUnsafe('GRANT UPDATE(report_source_facts) ON state_bill TO capiro_app');
    const raw = {
      state: 'FL',
      bill_id: 710,
      bill_number: 'S710',
      change_hash: 'a'.repeat(32),
      title: 'Synthetic formats',
      status: 1,
      session: {
        session_id: 2220,
        year_start: 2026,
        year_end: 2026,
        special: 0,
        prior: 0,
        session_name: 'Regular',
      },
      history: [{ date: '2026-01-01', action: 'Filed' }],
      progress: [],
      sponsors: [],
      votes: [],
      amendments: [],
      supplements: [],
      texts: [
        {
          doc_id: 711,
          date: '2026-01-01',
          type: 'Introduced',
          mime: 'text/html',
          text_hash: 'b'.repeat(32),
          text_size: 100,
          state_link: 'https://www.flsenate.gov/synthetic/HTML',
          alt_bill_text: 1,
          alt_mime: 'application/pdf',
          alt_text_size: 200,
          alt_text_hash: 'c'.repeat(32),
          alt_state_link: 'https://www.flsenate.gov/synthetic/PDF',
        },
      ],
    };
    const zip = new JSZip();
    zip.file('FL/bill/710.json', JSON.stringify({ bill: raw }));
    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    const scope = {
      state: 'FL',
      sessionId: 2220,
      expectedBills: 1,
      archiveHash: createHash('sha256').update(archive).digest('hex'),
    };
    const prepared = await inspectFrozenStateFormats(archive, scope),
      item = prepared.manifest.bills[0]!;
    await db.$executeRawUnsafe(
      'INSERT INTO legal_dataset_archive VALUES($1,$2)',
      scope.archiveHash,
      archive.toString('base64'),
    );
    await db.$executeRawUnsafe(
      "INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES($1,'fy26-state-frozen-inventory',$2::jsonb,$3::jsonb,true)",
      prepared.manifest.primaryReceiptId,
      JSON.stringify(prepared.primaryScope),
      JSON.stringify(prepared.prepared.manifest),
    );
    await db.$executeRawUnsafe(
      "INSERT INTO state_bill(id,state,legiscan_bill_id,report_source_facts) VALUES($1,'FL',710,'{\"newerPrimaryMetadata\":true}')",
      item.billKey,
    );
    const primaryIdentity = 'text:711:' + 'b'.repeat(32);
    await db.$executeRawUnsafe(
      "INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at,error_code) VALUES($1,'document',$2,'failed',9,now()+interval '3 hours','DOCUMENT_PROVIDER_HASH_MISMATCH')",
      item.billKey,
      primaryIdentity,
    );
    const primary = await db.$queryRawUnsafe(
      'SELECT * FROM state_bill_record_check WHERE bill_key=$1',
      item.billKey,
    );
    const run = () =>
      withStateBillWriter(db, ['FL'], (writer) =>
        writer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          return importFrozenStateFormats(tx as unknown as PrismaClient, archive, scope, {
            limit: 1,
          });
        }),
      );
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_format_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source LIKE 'fy26-state-formats:%' THEN RAISE EXCEPTION 'synthetic format checkpoint failure'; END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_format_checkpoint BEFORE UPDATE ON federal_evidence_checkpoint FOR EACH ROW EXECUTE FUNCTION fail_format_checkpoint()',
    );
    await expect(run()).rejects.toThrow('synthetic format checkpoint failure');
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM state_bill_record_check WHERE bill_key=$1',
        item.billKey,
      ),
    ).toEqual(primary);
    expect(
      await db.$queryRawUnsafe(
        'SELECT report_source_facts FROM state_bill WHERE id=$1',
        item.billKey,
      ),
    ).toEqual([{ report_source_facts: { newerPrimaryMetadata: true } }]);
    await db.$executeRawUnsafe(
      'DROP TRIGGER fail_format_checkpoint ON federal_evidence_checkpoint',
    );
    expect(await run()).toMatchObject({
      complete: true,
      queued: 1,
      processed: 1,
      primaryDocumentsChanged: 0,
    });
    expect(await run()).toMatchObject({ complete: true, queued: 1, processed: 0 });
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM state_bill_record_check WHERE bill_key=$1 AND source_identity=$2',
        item.billKey,
        primaryIdentity,
      ),
    ).toEqual(primary);
    expect(
      await db.$queryRawUnsafe(
        'SELECT state,attempts FROM state_bill_record_check WHERE bill_key=$1 AND source_identity=$2',
        item.billKey,
        stateDocumentCheckIdentity(item.formats[0]!),
      ),
    ).toEqual([{ state: 'pending', attempts: 0 }]);
    expect(await requireQualifiedAlternateFormat(db, item.billKey, 710, item.formats[0]!)).toEqual(
      item.formats[0],
    );
    await expect(
      requireQualifiedAlternateFormat(db, item.billKey, 999, item.formats[0]!),
    ).rejects.toThrow('DOCUMENT_FORMAT_INVENTORY_MISMATCH');
    expect(
      await db.$queryRawUnsafe(
        'SELECT manifest FROM legal_source_receipt WHERE id=$1',
        prepared.manifest.primaryReceiptId,
      ),
    ).toEqual([{ manifest: prepared.prepared.manifest }]);
  });
});
