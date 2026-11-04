import { structureText } from '../../ingestion/bill-document-structure.js';
import { defenseTextSignals } from './portfolio-office-bill-text.js';
const bill = {
  id: '119-hr-1',
  title: 'Synthetic National Defense Authorization fixture',
  lastSyncedAt: new Date('2026-01-01'),
};
it('uses exact retained text from the existing bill owner and quotes the matching passage', async () => {
  const structure = structureText(
    'SECTION 1. Synthetic fixture.\nRadar parsing marker, not legislative text.',
  );
  const row = {
    sourceKind: 'federal',
    billId: bill.id,
    billNumber: 'HR1',
    jurisdiction: 'US',
    session: '119',
    version: 'Introduced',
    versionId: '119hr1',
    revisionId: '10000000-0000-4000-8000-000000000001',
    extractionId: '20000000-0000-4000-8000-000000000002',
    structureHash: structure.structureHash,
    textHash: structure.textHash,
    extractionVersion: structure.parserVersion,
    sourceUrl: 'https://www.govinfo.gov/fixture',
    publishedDate: '2026-01-01',
    title: bill.title,
    completeness: 'complete',
    text: structure.text,
    structure,
  };
  const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([row]) };
  const result = await defenseTextSignals(tx as never, [bill] as never, ['radar', 'other term']);
  expect(result[0]?.evidence.excerpt).toContain('Radar parsing marker, not legislative text.');
  expect(result[0]?.evidence.url).toBe(row.sourceUrl);
  expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  expect(tx.$queryRawUnsafe.mock.calls[0]?.[0]).toContain('bill_text_extraction');
  const forged = { ...row, text: 'Changed text without matching extraction hash' };
  tx.$queryRawUnsafe.mockResolvedValue([forged]);
  await expect(defenseTextSignals(tx as never, [bill] as never, ['radar'])).rejects.toThrow(
    'BILL_EXTRACTION_INTEGRITY_FAILED',
  );
});
