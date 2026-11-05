import { queueBillDocumentChecks } from './bill-document-queue.js';
it('keeps every version, including versions from before FY26, without storing fetched hashes', async () => {
  const execute = jest.fn(async () => 3);
  const prisma = { $executeRaw: execute } as any;
  await queueBillDocumentChecks(prisma, 'tx-2025-hb1', {
    texts: [
      { doc_id: 1, date: '2025-01-01', text_hash: 'old' },
      { doc_id: 2, date: '2026-01-01', text_hash: 'new' },
    ],
    amendments: [{ amendment_id: 3, amendment_hash: 'amended' }],
  } as any);
  const [strings, billKey, inventory, comparison] = execute.mock.calls[0] as any[];
  expect(billKey).toBe('tx-2025-hb1');
  expect(JSON.parse(inventory)).toEqual([
    { identity: 'text:1', hash: 'old' },
    { identity: 'text:2', hash: 'new' },
    { identity: 'amendment:3', hash: 'amended' },
  ]);
  expect(comparison).toBe(inventory);
  expect(strings.join('?')).toContain("'pending',0,now()");
  expect(strings.join('?')).not.toContain('SET provider_hash');
  expect(strings.join('?')).not.toContain('attempted_at');
});
it('does not write an empty document inventory', async () => {
  const execute = jest.fn();
  await queueBillDocumentChecks({ $executeRaw: execute } as any, 'tx-2025-hb1', {});
  expect(execute).not.toHaveBeenCalled();
});
