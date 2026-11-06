import { Buffer } from 'node:buffer';
import {
  createPortfolioSourceReader,
  PORTFOLIO_SOURCE_TOOL_MAX_BYTES,
} from './portfolio-source-reader.js';

const encodedBytes = (result: { content: Array<{ text: string }> }) =>
  Buffer.byteLength(result.content[0]!.text, 'utf8');
const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

test('maximum corpus stays inline after Unicode, escaping and metadata serialization; all text remains accessible', () => {
  const patterns = ['a', '😀', '漢', '\u0000', '\\"\n', '😀漢\u0001\\"'];
  const sources = Array.from({ length: 60 }, (_, index) => {
    const pattern = patterns[index % patterns.length]!;
    return {
      // Near the serialized ID allowance, including six-byte JSON escapes.
      id: '\u0000'.repeat(84) + String(index),
      text: pattern.repeat(Math.floor(99_900 / pattern.length)) + ` END ${index}`,
      url: `https://evidence.example/${'漢'.repeat(20_000)}/${index}`,
      attachmentId: '😀'.repeat(20_000),
    };
  });
  const reader = createPortfolioSourceReader(sources);
  expect(reader.overviewPageCount).toBe(6);
  const overviewResults = Array.from({ length: reader.overviewPageCount }, (_, page) =>
    reader.overview(page),
  );
  expect(
    overviewResults.every((result) => encodedBytes(result) <= PORTFOLIO_SOURCE_TOOL_MAX_BYTES),
  ).toBe(true);
  expect(
    overviewResults.reduce((sum, result) => sum + encodedBytes(result), 0),
  ).toBeLessThanOrEqual(72_000);
  const overviews = overviewResults.flatMap((result) => body(result).sources);
  expect(overviews.map((source) => source.sourceId)).toEqual(sources.map((source) => source.id));
  expect(overviews.every((source) => source.truncated && source.pageCount > 1)).toBe(true);
  expect(
    overviews.every((source) => source.url === undefined && source.attachmentId === undefined),
  ).toBe(true);

  const batchSizes: number[] = [];
  for (const [index, source] of sources.entries()) {
    const manifest = reader.manifest[index]!;
    expect(manifest).toMatchObject({
      id: source.id,
      url: source.url,
      attachmentId: source.attachmentId,
      characters: source.text.length,
    });
    expect(overviews[index].pageCount).toBe(manifest.pageCount);
    const texts: string[] = [];
    let offset = 0;
    for (let page = 0; page < manifest.pageCount; page++) {
      const response = reader.read(source.id, page);
      const size = encodedBytes(response);
      expect(size).toBeLessThanOrEqual(PORTFOLIO_SOURCE_TOOL_MAX_BYTES);
      batchSizes.push(size);
      const result = body(response);
      expect(result).toMatchObject({
        sourceId: source.id,
        page,
        pageCount: manifest.pageCount,
        totalCharacters: source.text.length,
        startOffset: offset,
      });
      expect(result.endOffset).toBe(offset + result.text.length);
      // Valid surrogate pairs must not be split at a page boundary.
      if (result.endOffset < source.text.length) {
        expect(/^[\uDC00-\uDFFF]/u.test(source.text.slice(result.endOffset))).toBe(false);
      }
      texts.push(result.text);
      offset = result.endOffset;
    }
    expect(texts.join('')).toBe(source.text);
    expect(offset).toBe(source.text.length);
    expect(body(reader.read(source.id, manifest.pageCount - 1)).text).toContain(` END ${index}`);
  }
  for (let start = 0; start < batchSizes.length; start += 12) {
    expect(
      batchSizes.slice(start, start + 12).reduce((sum, bytes) => sum + bytes, 0),
    ).toBeLessThanOrEqual(144_000);
  }
});

test('small sources remain complete and out-of-corpus or invalid page requests are bounded errors', () => {
  const reader = createPortfolioSourceReader([
    { id: 'approved', text: 'Small complete evidence.' },
  ]);
  expect(body(reader.overview()).sources[0]).toMatchObject({
    truncated: false,
    pageCount: 1,
    text: 'Small complete evidence.',
  });
  expect(body(reader.read('approved'))).toMatchObject({
    page: 0,
    pageCount: 1,
    text: 'Small complete evidence.',
  });
  for (const result of [
    reader.read('unapproved'),
    reader.read('approved', 1),
    reader.read('approved', -1),
    reader.read('approved', 0.5),
    reader.overview(1),
    reader.overview(-1),
    reader.overview(0.5),
  ]) {
    expect(result).toMatchObject({ isError: true });
    expect(encodedBytes(result)).toBeLessThan(100);
  }
});

test('existing corpus allowances and bounded source identifiers are enforced before native tools are registered', () => {
  const valid = { id: 'source', text: 'Approved evidence.' };
  for (const sources of [
    [],
    [valid, valid],
    [{ ...valid, text: 'x'.repeat(100_001) }],
    [{ ...valid, id: '\u0000'.repeat(86) }],
    [{ ...valid, text: '' }],
    Array.from({ length: 61 }, (_, index) => ({ ...valid, id: `source-${index}` })),
  ]) {
    expect(() => createPortfolioSourceReader(sources)).toThrow('Invalid approved source corpus');
  }
});
