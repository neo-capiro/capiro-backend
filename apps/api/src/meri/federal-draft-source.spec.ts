import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { readFederalDraftSource } from './federal-draft-source.js';
import {
  createQualificationDatabase,
  qualificationAdminUrl,
  type QualificationDatabase,
} from '../../test/memory-postgres-qualification/harness.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const text = 'SEC. 1. Synthetic authorization.\nThe amount is $20.\n';
const raw = '<text>' + text + '</text>';
const selection = {
  billId: '119-hr-1',
  versionCode: 'enr',
  revisionId: '11111111-1111-4111-8111-111111111111',
  versionHash: hash(raw),
  textHash: hash(text),
};
const adminUrl = qualificationAdminUrl();

describe('exact federal source from its canonical PostgreSQL view', () => {
  jest.setTimeout(120000);
  let db: QualificationDatabase, prisma: PrismaService;
  beforeAll(async () => {
    if (!adminUrl) return;
    db = await createQualificationDatabase(adminUrl, false);
    const migration = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20280924030000_federal_legislative_evidence/migration.sql',
      ),
      'utf8',
    );
    // Use the actual two immutable source tables and current view, not an invented fixture view.
    for (const name of ['federal_evidence_revision', 'federal_evidence_observation']) {
      const ddl = migration.match(
        new RegExp('CREATE TABLE "' + name + '" \\([\\s\\S]*?\\n\\);'),
      )?.[0];
      if (!ddl) throw Error('Canonical source DDL missing');
      await db.admin.$executeRawUnsafe(ddl);
    }
    const view = migration.match(/CREATE VIEW "federal_evidence_current" AS[\s\S]*?;/)?.[0];
    if (!view || !/^meri_memory_qualification_app_[a-f0-9]{12}$/.test(db.appRole))
      throw Error('Fixture identity invalid');
    await db.admin.$executeRawUnsafe(view);
    await db.admin.$executeRawUnsafe(
      `GRANT SELECT ON federal_evidence_revision, federal_evidence_observation, federal_evidence_current TO "${db.appRole}"`,
    );
    prisma = new PrismaService({ datasources: { db: { url: db.appUrl } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.dispose({ preserveDatabase: true });
  });
  const insert = async (
    patch: {
      text?: string;
      raw?: string;
      completeness?: string;
      locator?: string;
      provider?: string;
    } = {},
  ) => {
    await db.admin.$executeRawUnsafe(
      'TRUNCATE federal_evidence_observation, federal_evidence_revision',
    );
    await db.admin.$executeRaw(Prisma.sql`INSERT INTO federal_evidence_revision
      (id,source_key,provider,collection,package_id,bill_id,version_code,lineage_key,content_hash,extraction_hash,parser_version,source_url,published_at,source_modified_at,fetched_at,raw_content,extracted_text,completeness)
      VALUES (${selection.revisionId}::uuid,'fixture-bill',${patch.provider ?? 'govinfo'},'BILLS','BILLS-119hr1enr',${selection.billId},'enr','bill:119-hr-1',${selection.versionHash},${selection.textHash},'federal-legislative-exact-code-v1',${patch.locator ?? 'https://www.govinfo.gov/content/pkg/BILLS-119hr1enr/html/BILLS-119hr1enr.htm'},'2026-01-01','2026-01-02','2026-01-03',${patch.raw ?? raw},${patch.text ?? text},${patch.completeness ?? 'complete'})`);
    await db.admin.$executeRaw(
      Prisma.sql`INSERT INTO federal_evidence_observation (observation_key,source_key,revision_id,state,inventory_window_end) VALUES ('fixture-current','fixture-bill',${selection.revisionId}::uuid,'present','2026-01-04')`,
    );
  };
  (adminUrl ? it : it.skip)(
    'actual MeriTools serialization retains identity, integrity and separate date meanings',
    async () => {
      await insert();
      const service = Object.assign(Object.create(MeriToolsService.prototype), {
        prisma,
      }) as MeriToolsService;
      const response = JSON.parse(
        JSON.stringify(await service.execute({} as never, 'read_federal_draft_source', selection)),
      );
      expect(response.currentStatus).toBe('available');
      expect(response.source.text).toBe(text);
      expect(response.source.publishedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(response.source.sourceModifiedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(response.source.fetchedAt).toBe('2026-01-03T00:00:00.000Z');
      expect(response.currency.enactment).toBe('unresolved');
      expect(response.source).not.toHaveProperty('rawContent');
      const vector = { synthetic: true, request: selection, response };
      const file = join(__dirname, 'federal-draft-source.wire.json');
      if (process.env.UPDATE_FEDERAL_DRAFT_WIRE === '1')
        writeFileSync(file, JSON.stringify(vector, null, 2) + '\n');
      expect(vector).toEqual(JSON.parse(readFileSync(file, 'utf8')));
    },
  );
  (adminUrl ? it : it.skip)(
    'removed current pointer cannot revive a retained revision',
    async () => {
      await insert();
      await db.admin.$executeRawUnsafe(
        "INSERT INTO federal_evidence_observation(observation_key,source_key,state,inventory_window_end) VALUES ('fixture-removal','fixture-bill','removed','2026-01-05')",
      );
      expect(await readFederalDraftSource(prisma, selection)).toMatchObject({
        currentStatus: 'unavailable',
        reason: 'exact_current_source_unavailable',
      });
    },
  );
  for (const [label, patch, reason] of [
    ['altered text', { text: text + 'changed' }, 'source_integrity_unverified'],
    ['altered retained content', { raw: raw + 'changed' }, 'source_integrity_unverified'],
    ['partial extraction', { completeness: 'partial' }, 'exact_current_source_unavailable'],
    ['UTF-8 text byte bound', { text: '€'.repeat(50000) }, 'source_size_unsupported'],
    ['retained content byte bound', { raw: 'x'.repeat(1048577) }, 'source_size_unsupported'],
    [
      'mismatched publisher host',
      { locator: 'https://www.congress.gov/bill/119' },
      'publisher_locator_unsupported',
    ],
  ] as const)
    (adminUrl ? it : it.skip)(label, async () => {
      await insert(patch);
      expect(await readFederalDraftSource(prisma, selection)).toMatchObject({
        currentStatus: 'unavailable',
        reason,
      });
    });
  (adminUrl ? it : it.skip)('pins never fall back to another revision or version', async () => {
    await insert();
    for (const patch of [
      { billId: '119-s-1' },
      { versionCode: 'ih' },
      { revisionId: '22222222-2222-4222-8222-222222222222' },
      { versionHash: 'a'.repeat(64) },
      { textHash: 'b'.repeat(64) },
    ])
      expect(await readFederalDraftSource(prisma, { ...selection, ...patch })).toMatchObject({
        currentStatus: 'unavailable',
      });
  });
});

test('rejects nonexact and authority-bearing selections before database access', async () => {
  const query = jest.fn();
  for (const patch of [
    { billId: 'H.R. 1' },
    { revisionId: 'invalid' },
    { versionHash: 'A'.repeat(64) },
    { tenantId: 'forged' },
    { sourceUrl: 'https://example.com' },
  ])
    await expect(
      readFederalDraftSource({ $queryRaw: query } as never, { ...selection, ...patch }),
    ).rejects.toThrow('Exact federal source');
  expect(query).not.toHaveBeenCalled();
});
