import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { StateSourceDataRepository } from '../../intel-api/src/sourcedata/state-source-data.repository.js';
import type { PrismaService } from '../../intel-api/src/prisma/prisma.service.js';

// Disposable PostgreSQL acceptance for the actual repository query. All fixture
// relations are temporary and disappear with this connection.
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(process.env.CAPIRO_DISPOSABLE_PG, '1');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE state_bill_version
        (id text,bill_key text,legiscan_doc_id integer,version_type text,date date,state_url text,mime text,last_synced_at timestamptz)`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE state_bill_published_record
        (id uuid,bill_key text,kind text,source_identity text,event_date text,evidence jsonb,first_observed_at timestamptz DEFAULT now())`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE published_record_source_observation
        (id bigint GENERATED ALWAYS AS IDENTITY,source_key text,state_record_id uuid)`);
      await tx.$executeRawUnsafe(`INSERT INTO state_bill_version VALUES
        ('text-one','fl-2026-h1211',123,'Introduced','2026-01-08','https://example.gov/text','application/pdf',now()),
        ('other-text','fl-2026-s0474',124,'Introduced','2026-01-08','https://example.gov/other','application/pdf',now())`);
      const bill = 'fl-2026-h1211';
      const oldId = '00000000-0000-4000-8000-000000000001';
      const newId = '00000000-0000-4000-8000-000000000002';
      for (const [id, title] of [[oldId, 'Staff analysis'], [newId, 'Revised staff analysis']]) {
        await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,event_date,evidence)
          VALUES (${id}::uuid,${bill},'document','analysis-one','2026-02-24',
          ${JSON.stringify({ documentKind: 'supplement', title, url: 'https://example.gov/analysis', mime: 'application/pdf' })}::jsonb)`;
      }
      // The newest observation deliberately restores the earlier immutable row.
      for (const id of [oldId, newId, oldId]) {
        await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id)
          VALUES ('state:fl-2026-h1211:document:analysis-one',${id}::uuid)`;
      }
      const repo = new StateSourceDataRepository(tx as unknown as PrismaService);
      const page = await repo.getRecordPage(bill, 'documents', 0);
      assert.equal(page.total, 2);
      assert.deepEqual(page.rows.map((r) => r.label), ['Staff analysis', 'Introduced']);
      assert.equal(page.rows[0].url, 'https://example.gov/analysis');
      assert.equal(page.rows[0].providerDocumentId, null);
      assert.equal((await repo.getRecordPage('fl-2026-s0474', 'documents', 0)).total, 1);
      assert.equal((await repo.getRecordPage("x' OR true --", 'documents', 0)).total, 0);
      // Text snapshots must not duplicate the canonical text version list.
      await tx.$executeRawUnsafe(`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,event_date,evidence)
        VALUES ('00000000-0000-4000-8000-000000000003','fl-2026-h1211','document','text-one','2026-01-08','{"documentKind":"text"}')`);
      await tx.$executeRawUnsafe(`INSERT INTO published_record_source_observation(source_key,state_record_id)
        VALUES ('state:fl-2026-h1211:document:text-one','00000000-0000-4000-8000-000000000003')`);
      assert.equal((await repo.getRecordPage(bill, 'documents', 0)).total, 2);
      await tx.$executeRawUnsafe(`INSERT INTO state_bill_version
        SELECT 'page-'||n,'fl-2026-h1211',1000+n,'Text '||n,'2026-01-01'::date,NULL,NULL,now() FROM generate_series(1,50) n`);
      const first = await repo.getRecordPage(bill, 'documents', 0);
      const second = await repo.getRecordPage(bill, 'documents', 50);
      assert.equal(first.total, 52);
      assert.equal(first.rows.length, 50);
      assert.equal(second.rows.length, 2);
      assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.id)).size, 52);
    }, { timeout: 30_000 });
    console.log('STATE_DOCUMENT_RECORDS_POSTGRES_PASS: analysis visibility, current revision, bill isolation, parameter binding, text deduplication, pagination');
  } finally { await db.$disconnect(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
