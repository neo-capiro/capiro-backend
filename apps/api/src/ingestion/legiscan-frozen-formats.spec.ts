import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { inspectFrozenStateFormats, importFrozenStateFormats } from './legiscan-frozen-formats.js';
import {
  alternateDocumentFormats,
  stateDocumentCheckIdentity,
  requireQualifiedAlternateFormat,
} from './state-document-formats.js';
import { stateDocumentStubs, mergeDocumentStubs } from './state-document-stub.js';
import { withStateBillWriter } from './state-bill-writer.js';
jest.mock('./state-bill-writer.js', () => ({
  withStateBillWriter: jest.fn((db, _states, run) => run(db)),
}));

export const formatBill = (id = 1) => ({
  state: 'FL',
  bill_id: id,
  bill_number: `S${id}`,
  change_hash: 'a'.repeat(32),
  title: 'Synthetic format bill',
  status: 1,
  session: {
    session_id: 2220,
    year_start: 2026,
    year_end: 2026,
    special: 0,
    prior: 0,
    session_name: 'Regular',
  },
  history: [{ date: '2026-01-01', action: 'Introduced' }],
  progress: [],
  sponsors: [],
  votes: [],
  amendments: [],
  supplements: [],
  texts: [
    {
      doc_id: id,
      date: '2026-01-01',
      type: 'Introduced',
      mime: 'text/html',
      text_size: 100,
      text_hash: 'b'.repeat(32),
      state_link: `https://www.flsenate.gov/${id}/HTML`,
      alt_bill_text: 1,
      alt_mime: 'application/pdf',
      alt_text_size: 200,
      alt_text_hash: 'c'.repeat(32),
      alt_state_link: `https://www.flsenate.gov/${id}/PDF`,
    },
  ],
});
async function fixture() {
  const zip = new JSZip();
  for (const id of [1, 2]) zip.file(`FL/bill/${id}.json`, JSON.stringify({ bill: formatBill(id) }));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const scope = {
    state: 'FL',
    sessionId: 2220,
    expectedBills: 2,
    archiveHash: createHash('sha256').update(archive).digest('hex'),
  };
  return { archive, scope };
}
const proof = { receiptId: 'a'.repeat(64), archiveHash: 'b'.repeat(64) };
it('preserves primary manifests and projects only exact qualified PDF alternatives', () => {
  const raw = formatBill();
  const primary = stateDocumentStubs(raw);
  const formats = alternateDocumentFormats(raw, proof);
  expect(primary).toHaveLength(1);
  expect(primary[0]).toMatchObject({ mime: 'text/html', providerHash: 'b'.repeat(32), size: 100 });
  expect(primary[0]).not.toHaveProperty('format');
  expect(formats).toHaveLength(1);
  expect(formats[0]).toMatchObject({
    providerId: 1,
    mime: 'application/pdf',
    providerHash: 'c'.repeat(32),
    size: 200,
    format: { role: 'alternate', primaryProviderHash: 'b'.repeat(32), ...proof },
  });
  expect(stateDocumentCheckIdentity(formats[0]!)).toBe(
    'text:1:' + 'c'.repeat(32) + ':' + 'b'.repeat(32) + ':alternate',
  );
  const otherPrimary = {
    ...formats[0]!,
    format: { ...formats[0]!.format!, primaryProviderHash: 'd'.repeat(32) },
  };
  expect(stateDocumentCheckIdentity(otherPrimary)).not.toBe(
    stateDocumentCheckIdentity(formats[0]!),
  );
  expect(mergeDocumentStubs(formats, [otherPrimary])).toHaveLength(2);
  for (const change of [
    { alt_text_hash: 'bad' },
    { alt_text_hash: raw.texts[0]!.text_hash },
    { alt_text_size: 0 },
    { alt_text_size: 20000001 },
    { alt_mime: 'text/html' },
    { alt_state_link: 'https://user:pass@www.flsenate.gov/PDF' },
    { alt_bill_text: 0 },
  ])
    expect(alternateDocumentFormats({ texts: [{ ...raw.texts[0]!, ...change }] }, proof)).toEqual(
      [],
    );
});
it('requires exact receipt-backed bill, primary hash, MIME, URL, size and version metadata', async () => {
  const stub = alternateDocumentFormats(formatBill(), proof)[0]!;
  const db: any = { $queryRawUnsafe: jest.fn(async () => [{ stub }]) };
  expect(await requireQualifiedAlternateFormat(db, 'bill', 1, stub)).toEqual(stub);
  for (const change of [
    { mime: 'text/html' },
    { size: 201 },
    { stateUrl: 'https://www.flsenate.gov/other/PDF' },
    { format: { ...stub.format!, primaryProviderHash: 'd'.repeat(32) } },
  ])
    await expect(
      requireQualifiedAlternateFormat(db, 'bill', 1, { ...stub, ...change }),
    ).rejects.toThrow('DOCUMENT_FORMAT_INVENTORY_MISMATCH');
  db.$queryRawUnsafe.mockResolvedValue([]);
  await expect(requireQualifiedAlternateFormat(db, 'other-bill', 2, stub)).rejects.toThrow(
    'DOCUMENT_FORMAT_INVENTORY_MISMATCH',
  );
});
function database() {
  let cursor = { offset: 0, queued: 0 };
  const facts = new Map<string, any>();
  const checks = new Set<string>();
  let fail = false;
  const db: any = {
    stateBill: {
      findUnique: jest.fn(({ where }) => ({
        legiscanBillId: where.id.endsWith('s1') ? 1 : 2,
        reportSourceFacts: facts.get(where.id) ?? { keep: 'newer-primary-metadata' },
      })),
      update: jest.fn(({ where, data }) => {
        facts.set(where.id, data.reportSourceFacts);
        return {};
      }),
    },
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('').includes('AS cursor') ? [{ cursor: { ...cursor } }] : [{ id: 'exact' }],
    ),
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...args: any[]) => {
      const text = sql.join('');
      if (text.startsWith('INSERT INTO state_bill_record_check')) {
        let n = 0;
        for (const item of JSON.parse(args[1])) {
          const key = args[0] + item.identity;
          if (!checks.has(key)) {
            checks.add(key);
            n++;
          }
        }
        return n;
      }
      if (text.startsWith('UPDATE federal_evidence_checkpoint')) {
        if (fail) throw Error('synthetic late failure');
        cursor = JSON.parse(args[0]);
      }
      return 1;
    }),
  };
  db.$transaction = jest.fn(async (run: any) => {
    const before = { cursor: { ...cursor }, facts: new Map(facts), checks: new Set(checks) };
    try {
      return await run(db);
    } catch (e) {
      cursor = before.cursor;
      facts.clear();
      before.facts.forEach((v, k) => facts.set(k, v));
      checks.clear();
      before.checks.forEach((v) => checks.add(v));
      throw e;
    }
  });
  return {
    db,
    facts,
    checks,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
it('uses a distinct receipt and bounded checkpoint, preserves primary metadata, and resumes without retry inflation', async () => {
  const { archive, scope } = await fixture();
  const prepared = await inspectFrozenStateFormats(archive, scope);
  expect(prepared.prepared.manifest.bills.flatMap((b) => b.documents)).toHaveLength(2);
  expect(prepared.prepared.manifest.bills.flatMap((b) => b.documents).every((d) => !d.format)).toBe(
    true,
  );
  expect(prepared.receiptId).not.toBe(prepared.manifest.primaryReceiptId);
  const mock = database();
  expect(await importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).toMatchObject({
    offset: 1,
    queued: 1,
    complete: false,
    primaryDocumentsChanged: 0,
  });
  expect(await importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).toMatchObject({
    offset: 2,
    queued: 2,
    complete: true,
  });
  expect(await importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).toMatchObject({
    processed: 0,
    queued: 2,
  });
  expect(
    [...mock.facts.values()].every(
      (f) => f.keep === 'newer-primary-metadata' && f.retainedDocumentFormats.length === 1,
    ),
  ).toBe(true);
  expect(withStateBillWriter).toHaveBeenCalledWith(mock.db, ['FL'], expect.any(Function));
  expect(mock.checks.size).toBe(2);
  expect(
    mock.db.$executeRaw.mock.calls.every(
      (call: any[]) => !call[0].join('').includes('UPDATE state_bill_record_check'),
    ),
  ).toBe(true);
});
it('rolls back metadata and alternate work if the same fenced checkpoint transaction fails', async () => {
  const { archive, scope } = await fixture();
  const mock = database();
  mock.fail(true);
  await expect(importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).rejects.toThrow(
    'synthetic late failure',
  );
  expect(mock.checks.size).toBe(0);
  expect(mock.facts.size).toBe(0);
  mock.fail(false);
  expect(await importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).toMatchObject({
    offset: 1,
    queued: 1,
  });
});
it('refuses absent or changed frozen primary receipts and altered archive bytes', async () => {
  const { archive, scope } = await fixture();
  const mock = database();
  mock.db.$queryRaw.mockResolvedValue([]);
  await expect(importFrozenStateFormats(mock.db, archive, scope, { limit: 1 })).rejects.toThrow(
    'FROZEN_PRIMARY_INVENTORY_REQUIRED',
  );
  expect(mock.db.stateBill.update).not.toHaveBeenCalled();
  await expect(
    inspectFrozenStateFormats(Buffer.concat([archive, Buffer.from('x')]), scope),
  ).rejects.toThrow('FROZEN_DATASET_SCOPE_OR_HASH_MISMATCH');
});
