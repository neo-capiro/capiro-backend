import { extractNativeFundingPdf } from './funding-document-text.js';
import { getDocumentProxy } from 'unpdf';
jest.mock('unpdf', () => ({ getDocumentProxy: jest.fn() }));

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
