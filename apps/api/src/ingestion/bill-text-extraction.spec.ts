import { createHash } from 'node:crypto';
import { deriveBillExtraction, ensureBillTextExtraction } from './bill-text-extraction';
import { structureText } from './bill-document-structure';
const text = 'SECTION 2. Definitions\n(a) “Agency” means the office.\nSECTION 3. Short';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const input = {
  sourceKind: 'state' as const,
  revisionId: 'synthetic-revision',
  documentHash: hash(text),
  evidence: { mime: 'text/plain', contentSnapshotBase64: Buffer.from(text).toString('base64') },
};
describe('immutable extraction owner', () => {
  it('qualifies retained bytes, records missing/mismatched bytes as failures, and never fabricates complete text', async () => {
    expect((await deriveBillExtraction(input)).completeness).toBe('complete');
    expect(
      (await deriveBillExtraction({ ...input, documentHash: '0'.repeat(64) })).structure.warnings,
    ).toEqual(['ORIGINAL_SNAPSHOT_HASH_MISMATCH']);
    expect((await deriveBillExtraction({ ...input, evidence: {} })).completeness).toBe('failed');
    expect(
      (
        await deriveBillExtraction({
          ...input,
          evidence: { ...input.evidence, mime: 'application/unknown' },
        })
      ).completeness,
    ).toBe('unreadable');
  });
  it('persists every lexical section atomically before embedding and fences the transaction', async () => {
    const events: string[] = [];
    const db: any = {
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        events.push(sql.startsWith('INSERT') ? 'extraction' : 'lookup');
        return sql.startsWith('INSERT') ? [{ id: 'new' }] : [];
      }),
      $executeRawUnsafe: jest.fn(async () => {
        events.push('passages');
        return 1;
      }),
      $transaction: jest.fn(async (fn: any) => {
        events.push('transaction');
        return fn(db);
      }),
    };
    const result = await ensureBillTextExtraction(db, input, {
      commit: true,
      beforeWrite: async () => {
        events.push('fence');
        return true;
      },
    });
    expect(events).toEqual(['lookup', 'transaction', 'fence', 'extraction', 'passages']);
    const rows = JSON.parse(db.$executeRawUnsafe.mock.calls[0][3]);
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(result.structure.text.slice(row.start_offset, row.end_offset)).toBe(row.content_text);
    expect(rows[0].metadata_jsonb.nextPassageId).toContain(result.id);
    db.$executeRawUnsafe.mockClear();
    await expect(
      ensureBillTextExtraction(db, input, { commit: true, beforeWrite: async () => false }),
    ).rejects.toThrow('BILL_TEXT_LEASE_LOST');
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('reuses a successful immutable extraction and dry-run makes no writes', async () => {
    const structure = structureText(text);
    const db: any = {
      $queryRawUnsafe: jest.fn(async () => [{ id: 'existing', structure }]),
      $transaction: jest.fn(),
    };
    expect((await ensureBillTextExtraction(db, input, { commit: true })).id).toBe('existing');
    expect(db.$transaction).not.toHaveBeenCalled();
    db.$queryRawUnsafe.mockResolvedValue([]);
    expect((await ensureBillTextExtraction(db, input, { commit: false })).id).toBe('dry-run');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('reuses a validated retained parser snapshot after JSONB key reordering', async () => {
    const saved = structureText(text);
    const reordered = Object.fromEntries(Object.entries(saved).reverse()) as typeof saved;
    const result = await deriveBillExtraction({
      ...input,
      evidence: { ...input.evidence, mime: 'unsupported', structure: reordered },
    });
    expect(result.structure).toBe(reordered);
    expect(result.completeness).toBe('complete');
    const corrupted = { ...reordered, text: 'changed' };
    expect(
      (
        await deriveBillExtraction({
          ...input,
          evidence: { ...input.evidence, structure: corrupted },
        })
      ).structure.text,
    ).toBe(saved.text);
  });
});
