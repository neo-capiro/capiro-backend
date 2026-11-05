import { extractPdfBounded } from './attachment-content.service.js';
const mockInfo = jest.fn();
const mockText = jest.fn();
const mockDestroy = jest.fn();
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    getInfo = mockInfo;
    getText = mockText;
    destroy = mockDestroy;
  },
}));
beforeEach(() => {
  mockInfo.mockReset().mockResolvedValue({ total: 4000 });
  mockText.mockReset().mockResolvedValue({
    pages: [
      { num: 1, text: 'First actual page' },
      { num: 2, text: 'Second actual page' },
    ],
  });
  mockDestroy.mockReset().mockResolvedValue(undefined);
});
test('limits PDF parsing to the requested first pages before any text extraction', async () => {
  expect(await extractPdfBounded(Buffer.from('fixture'), 2)).toEqual({
    text: 'First actual page\n\nSecond actual page',
    pageLimitHit: true,
  });
  expect(mockText).toHaveBeenCalledWith({ partial: [1, 2] });
  expect(mockDestroy).toHaveBeenCalledTimes(1);
});
test('does not report a truncated source when every page fits', async () => {
  mockInfo.mockResolvedValue({ total: 2 });
  expect((await extractPdfBounded(Buffer.from('fixture'), 10)).pageLimitHit).toBe(false);
  expect(mockText).toHaveBeenCalledWith({ partial: [1, 2] });
});
test('flat text fallback remains bounded by the parser request and preserves coverage disclosure', async () => {
  mockText.mockResolvedValue({ text: 'Only requested pages' });
  expect(await extractPdfBounded(Buffer.from('fixture'), 1)).toEqual({
    text: 'Only requested pages',
    pageLimitHit: true,
  });
  expect(mockText).toHaveBeenCalledWith({ partial: [1] });
});
test('unknown page counts fail closed instead of falling back to unbounded parsing', async () => {
  mockInfo.mockResolvedValue({ total: undefined });
  await expect(extractPdfBounded(Buffer.from('fixture'), 2)).rejects.toThrow('page count');
  expect(mockText).not.toHaveBeenCalled();
  expect(mockDestroy).toHaveBeenCalledTimes(1);
});
test('invalid zero page limit cannot invoke the parser meaning all pages', async () => {
  await expect(extractPdfBounded(Buffer.from('fixture'), 0)).rejects.toThrow('positive page limit');
  expect(mockInfo).not.toHaveBeenCalled();
  expect(mockText).not.toHaveBeenCalled();
});
test('empty PDF and parser failures both release their resources', async () => {
  mockInfo.mockResolvedValueOnce({ total: 0 });
  expect(await extractPdfBounded(Buffer.from('fixture'), 2)).toEqual({
    text: '',
    pageLimitHit: false,
  });
  expect(mockText).not.toHaveBeenCalled();
  mockText.mockRejectedValueOnce(new Error('Unreadable PDF'));
  await expect(extractPdfBounded(Buffer.from('fixture'), 2)).rejects.toThrow('Unreadable PDF');
  expect(mockDestroy).toHaveBeenCalledTimes(2);
});
