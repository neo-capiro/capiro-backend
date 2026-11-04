import { extractNativeFundingPdf, readNativePdfCandidates, publishLocalFundingText,
  CURRENT_DIBBS_ATTACHMENT_SQL, ELIGIBLE_DIBBS_ATTACHMENT_SQL } from './funding-document-text.js';
import { getDocumentProxy } from 'unpdf';
jest.mock('unpdf', () => ({ getDocumentProxy: jest.fn() }));

test('DIBBS PDF selection requires active current URL and hash-bound text without changing limits', async () => {
  const query = jest.fn(async () => []);
  await readNativePdfCandidates({ $queryRawUnsafe: query } as any, 'synthetic-bucket', 5);
  const [sql, bucket, limit] = query.mock.calls[0] as unknown as [string, string, number];
  expect(bucket).toBe('synthetic-bucket'); expect(limit).toBe(5);
  expect(sql).toContain(ELIGIBLE_DIBBS_ATTACHMENT_SQL);
  expect(CURRENT_DIBBS_ATTACHMENT_SQL).toContain('d.is_open IS TRUE');
  expect(CURRENT_DIBBS_ATTACHMENT_SQL).toContain('d.closes_date IS NULL OR d.closes_date>=CURRENT_DATE');
  expect(CURRENT_DIBBS_ATTACHMENT_SQL).toContain('d.document_url=opportunity_attachment.source_url');
  expect(sql).toContain("coalesce(length(provider_data->>'extracted_text'),0)<=10");
  expect(sql).toContain('t.attachment_content_sha256=opportunity_attachment.content_sha256');
  expect(sql).toContain("t.updated_at>now()-interval '1 day'");
});

test('DIBBS text publication stops on inactive, superseded, changed bytes or existing provider text', async () => {
  const row = { id: 'synthetic-attachment', content_sha256: 'current-hash' };
  for (const current of [[], [{ content_sha256: 'other-hash' }],
    [{ content_sha256: row.content_sha256, provider_data: { extracted_text: 'Genuine provider text is already available.' } }]]) {
    const query = jest.fn(async () => current), create = jest.fn(), update = jest.fn();
    const tx = { $queryRawUnsafe: query, opportunityDocumentText: { create }, opportunityAttachment: { update } };
    expect(await publishLocalFundingText({ $transaction: async (fn: any) => fn(tx) } as any, row,
      { text: 'Parsed document text.', truncated: false })).toBe(false);
    expect((query.mock.calls[0] as unknown as [string])[0]).toContain(ELIGIBLE_DIBBS_ATTACHMENT_SQL);
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  }
});

test('DIBBS partial text retains exact archived hash and explicit truncation', async () => {
  const row = { id: 'synthetic-attachment', content_sha256: 'synthetic-hash' };
  const create = jest.fn(), update = jest.fn();
  const tx = { $queryRawUnsafe: async () => [{ content_sha256: row.content_sha256, provider_data: {} }],
    opportunityDocumentText: { findFirst: async () => null, create }, opportunityAttachment: { update } };
  expect(await publishLocalFundingText({ $transaction: async (fn: any) => fn(tx) } as any, row,
    { text: 'Recovered specification text from readable pages.', truncated: true })).toBe(true);
  expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ attachmentId: row.id,
    attachmentContentSha256: row.content_sha256, extractionMethod: 'local_parser', status: 'available', truncated: true }) });
  expect(update).toHaveBeenCalledWith({ where: { id: row.id }, data: { providerObservedAt: expect.any(Date) } });
});

test('native grant text preserves page breaks and reports unreadable pages', async () => {
  const destroy = jest.fn();
  (getDocumentProxy as jest.Mock).mockResolvedValue({ numPages: 3,
    getPage: async (number: number) => ({ getTextContent: async () => ({ items: number === 2 ? [] : [{ str: `Page ${number}`, hasEOL: true }, { str: '\u0000' }] }) }),
    loadingTask: { destroy } });
  const result = await extractNativeFundingPdf(new Uint8Array([1]));
  expect(result.text).toContain('Page 1\n'); expect(result.text).toContain('Page 3\n');
  expect(result.text).not.toContain('\u0000'); expect(result.text).toContain('\uFFFD');
  expect(result).toMatchObject({ truncated: true, blankPages: 1, pagesRead: 3 });
  expect(destroy).toHaveBeenCalledTimes(1);
});

test('native grant extraction caps pages and characters and releases parser resources', async () => {
  const destroy = jest.fn();
  (getDocumentProxy as jest.Mock).mockResolvedValue({ numPages: 501,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'x'.repeat(5000) }] }) }), loadingTask: { destroy } });
  const result = await extractNativeFundingPdf(new Uint8Array([1]));
  expect(result.text.length).toBeLessThanOrEqual(2_000_000); expect(result.pagesRead).toBeLessThanOrEqual(500);
  expect(result.truncated).toBe(true); expect(destroy).toHaveBeenCalledTimes(1);
  await expect(extractNativeFundingPdf(new Uint8Array(25*1024*1024+1))).rejects.toThrow('size_limit');
});
