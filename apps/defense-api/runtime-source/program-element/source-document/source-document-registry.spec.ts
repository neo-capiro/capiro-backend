import {
  sha256OfBuffer,
  readDocumentToolVersion,
  supersedeSourceDocumentHead,
  upsertSourceDocument,
  type SourceDocumentClient,
  type SourceDocumentRow,
  type UpsertSourceDocumentInput,
} from './source-document-registry.js';

/** Minimal in-memory mock of the `sourceDocument` Prisma delegate. */
function makeClient() {
  const rows: SourceDocumentRow[] = [];
  let seq = 0;
  const client: SourceDocumentClient = {
    sourceDocument: {
      async findFirst({ where, orderBy }) {
        let matches = rows.filter((r) =>
          Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        );
        if (orderBy && (orderBy as Record<string, unknown>).ingestedAt === 'desc') {
          matches = [...matches].sort((a, b) => Number(b.ingestedAt) - Number(a.ingestedAt));
        }
        return matches[0] ?? null;
      },
      async create({ data }) {
        const d = data as Record<string, unknown>;
        const row: SourceDocumentRow = {
          ...d,
          id: `doc-${++seq}`,
          sourceKey: String(d.sourceKey),
          sha256: (d.sha256 ?? null) as string | null,
          supersededByDocumentId: null,
          ingestedAt: seq,
        };
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const r = rows.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r as SourceDocumentRow;
      },
    },
  };
  return { client, rows };
}

function input(over: Partial<UpsertSourceDocumentInput> = {}): UpsertSourceDocumentInput {
  return {
    sourceKey: 'jbook_r1_fy2027',
    sha256: 'a'.repeat(64),
    fiscalYear: 2027,
    budgetCycle: 'pb',
    component: null,
    documentType: 'r1',
    title: 'R-1 master list',
    sourceUrl: 'https://example.gov/r1.pdf',
    extractionMethod: 'deterministic_pdf',
    ...over,
  };
}

describe('sha256OfBuffer', () => {
  it('matches the known empty-string SHA-256 vector', () => {
    expect(sha256OfBuffer(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('readDocumentToolVersion', () => {
  it('reads _document.tool_version when present', () => {
    expect(readDocumentToolVersion({ _document: { tool_version: '0.1.0' } })).toBe('0.1.0');
  });
  it('returns null when the header or field is absent/blank', () => {
    expect(readDocumentToolVersion({})).toBeNull();
    expect(readDocumentToolVersion({ _document: {} })).toBeNull();
    expect(readDocumentToolVersion({ _document: { tool_version: '' } })).toBeNull();
    expect(readDocumentToolVersion(null)).toBeNull();
    expect(readDocumentToolVersion(undefined)).toBeNull();
  });
});

describe('upsertSourceDocument', () => {
  it('is idempotent: same (sourceKey, sha256) returns the existing row, no duplicate', async () => {
    const { client, rows } = makeClient();
    const first = await upsertSourceDocument(client, input());
    const second = await upsertSourceDocument(client, input());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(second.supersededDocument).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('changed sha256 for the same sourceKey inserts a new row and chains the old head', async () => {
    const { client, rows } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    const v2 = await upsertSourceDocument(client, input({ sha256: 'b'.repeat(64) }));

    expect(v2.created).toBe(true);
    expect(v2.document.id).not.toBe(v1.document.id);
    expect(v2.supersededDocument?.id).toBe(v1.document.id);
    expect(rows).toHaveLength(2);

    // Old head now points to the new version; new version is the live head.
    const oldHead = rows.find((r) => r.id === v1.document.id)!;
    const newHead = rows.find((r) => r.id === v2.document.id)!;
    expect(oldHead.supersededByDocumentId).toBe(v2.document.id);
    expect(newHead.supersededByDocumentId).toBeNull();
  });

  it('re-ingesting old content after a version bump is still a no-op (exact match wins)', async () => {
    const { client, rows } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    await upsertSourceDocument(client, input({ sha256: 'b'.repeat(64) }));
    const again = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));

    expect(again.created).toBe(false);
    expect(again.document.id).toBe(v1.document.id);
    expect(rows).toHaveLength(2);
  });

  it('treats distinct sourceKeys independently', async () => {
    const { client, rows } = makeClient();
    await upsertSourceDocument(client, input({ sourceKey: 'jbook_r2_dw_darpa', documentType: 'r2' }));
    await upsertSourceDocument(client, input({ sourceKey: 'jbook_performers_dw_darpa', documentType: 'r3' }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.supersededByDocumentId === null)).toBe(true);
  });
});

// A caller that registers a document BEFORE a separate canonical transaction must
// be able to keep the previous head live until that transaction succeeds. Without
// this, a promotion that fails after registration leaves a valid head superseded
// by a document whose values were never promoted.
describe('deferred head supersession', () => {
  it('leaves the prior head live when supersession is deferred', async () => {
    const { client } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    const v2 = await upsertSourceDocument(
      client,
      input({ sha256: 'b'.repeat(64) }),
      { deferSupersede: true },
    );

    expect(v2.created).toBe(true);
    expect(v2.supersededDocument?.id).toBe(v1.document.id);
    // The whole point: v1 is still the live head until promotion succeeds.
    const head = await client.sourceDocument.findFirst({
      where: { sourceKey: 'jbook_r1_fy2027', supersededByDocumentId: null },
      orderBy: { ingestedAt: 'desc' },
    });
    expect(head?.supersededByDocumentId).toBeNull();
    expect(v1.document.supersededByDocumentId).toBeNull();
  });

  it('retires the prior head only when the deferred update is applied', async () => {
    const { client, rows } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    const v2 = await upsertSourceDocument(
      client,
      input({ sha256: 'b'.repeat(64) }),
      { deferSupersede: true },
    );

    await supersedeSourceDocumentHead(client, v1.document.id, v2.document.id);

    expect(rows.find((r) => r.id === v1.document.id)?.supersededByDocumentId).toBe(v2.document.id);
    expect(rows.find((r) => r.id === v2.document.id)?.supersededByDocumentId).toBeNull();
  });

  it('still supersedes eagerly by default so existing callers are unchanged', async () => {
    const { client, rows } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    const v2 = await upsertSourceDocument(client, input({ sha256: 'b'.repeat(64) }));

    expect(rows.find((r) => r.id === v1.document.id)?.supersededByDocumentId).toBe(v2.document.id);
  });

  it('never chains a document to itself', async () => {
    const { client, rows } = makeClient();
    const v1 = await upsertSourceDocument(client, input({ sha256: 'a'.repeat(64) }));
    await supersedeSourceDocumentHead(client, v1.document.id, v1.document.id);
    expect(rows.find((r) => r.id === v1.document.id)?.supersededByDocumentId).toBeNull();
  });
});
