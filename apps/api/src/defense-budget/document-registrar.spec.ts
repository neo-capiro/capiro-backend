import { DocumentRegistrar, type RegisterDocumentInput } from './document-registrar.js';
import type { RawArchiveService, ArchiveResult } from './raw-archive.service.js';
import type {
  SourceDocumentClient,
  SourceDocumentRow,
} from '../program-element/source-document/source-document-registry.js';

function makeRegistryClient() {
  const rows: SourceDocumentRow[] = [];
  const client: SourceDocumentClient = {
    sourceDocument: {
      async findFirst({ where }) {
        return (
          rows.find((r) =>
            Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
          ) ?? null
        );
      },
      async create({ data }) {
        const row = { id: `sd-${rows.length + 1}`, supersededByDocumentId: null, ...data } as SourceDocumentRow;
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { client, rows };
}

const input = (): RegisterDocumentInput => ({
  sourceKey: 'jbook_r2_af_rdte_v1_fy2027',
  fiscalYear: 2027,
  budgetCycle: 'pb',
  component: 'AF',
  documentType: 'r2',
  title: 'FY2027 Air Force RDT&E Vol 1',
  sourceUrl: 'https://www.saffm.hq.af.mil/rdte_v1.pdf',
  pageCount: 500,
  archive: {
    documentId: 'jbook_r2_af_rdte_v1_fy2027',
    fiscalYear: 2027,
    sourceAuthority: 'dod-comptroller',
    family: 'rdte',
    localPath: '/tmp/af_rdte_v1.pdf',
  },
});

describe('DocumentRegistrar', () => {
  it('archives BEFORE registering and persists the verified VersionId', async () => {
    const order: string[] = [];
    const archiveResult: ArchiveResult = {
      bucket: 'capiro-defense-budget-raw-dev-000',
      key: 'raw/public/dod-budget/fiscal_year=2027/.../original.pdf',
      versionId: 'ver-abc',
      sha256: 'a'.repeat(64),
      byteSize: 1234,
      kmsKeyArn: 'arn:key',
      retainUntil: new Date('2033-07-14T00:00:00Z'),
      created: true,
      retrievalKey: 'raw/.../retrieval.json',
      manifestKey: 'raw/.../manifest.json',
    };
    const archiveSvc = {
      async archiveOriginal() {
        order.push('archive');
        return archiveResult;
      },
    } as unknown as RawArchiveService;

    const { client, rows } = makeRegistryClient();
    // Wrap create to record ordering.
    const origCreate = client.sourceDocument.create;
    client.sourceDocument.create = async (args) => {
      order.push('register');
      return origCreate(args);
    };

    const registrar = new DocumentRegistrar(archiveSvc, client, () => new Date('2026-07-14T00:00:00Z'));
    const res = await registrar.register(input());

    // Ordering invariant: archive strictly before register.
    expect(order).toEqual(['archive', 'register']);
    expect(res.archive.versionId).toBe('ver-abc');
    const row = rows[0]! as Record<string, unknown>;
    expect(row.archiveVersionId).toBe('ver-abc');
    expect(row.archiveBucket).toBe('capiro-defense-budget-raw-dev-000');
    expect(row.extractionMethod).toBe('llamaparse');
    expect(row.sha256).toBe('a'.repeat(64));
    expect(row.retainUntil).toEqual(new Date('2033-07-14T00:00:00Z'));
  });

  it('does NOT register when archival throws (no orphan SourceDocument row)', async () => {
    const archiveSvc = {
      async archiveOriginal() {
        throw new Error('S3 AccessDenied');
      },
    } as unknown as RawArchiveService;
    const { client, rows } = makeRegistryClient();
    const registrar = new DocumentRegistrar(archiveSvc, client);
    await expect(registrar.register(input())).rejects.toThrow(/AccessDenied/);
    expect(rows).toHaveLength(0);
  });

  it('refuses to register if the archive returns no bucket/key', async () => {
    const archiveSvc = {
      async archiveOriginal() {
        return { bucket: '', key: '', versionId: null, sha256: 'b'.repeat(64), byteSize: 1, retainUntil: new Date(), created: true, retrievalKey: '', manifestKey: '' } as ArchiveResult;
      },
    } as unknown as RawArchiveService;
    const { client, rows } = makeRegistryClient();
    const registrar = new DocumentRegistrar(archiveSvc, client);
    await expect(registrar.register(input())).rejects.toThrow(/refusing to register/);
    expect(rows).toHaveLength(0);
  });
});
