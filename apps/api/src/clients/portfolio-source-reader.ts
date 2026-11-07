import { Buffer } from 'node:buffer';

export interface PortfolioAgentSource {
  id: string;
  text: string;
  url?: string;
  attachmentId?: string;
}

// Below the native SDK's character and token spill thresholds, including JSON
// escaping and metadata. UTF-8 bytes also bound token count without a tokenizer.
export const PORTFOLIO_SOURCE_TOOL_MAX_BYTES = 12_000;
const SOURCE_TEXT_JSON_BYTES = 10_000;
const OVERVIEW_TEXT_JSON_BYTES = 512;
const SOURCE_ID_JSON_BYTES = 512;
const OVERVIEW_PAGE_SIZE = 10;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function endAtCharacterBoundary(text: string, end: number) {
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    return end - 1;
  return end;
}

/** Bound the encoded JSON string, not its unescaped JS character count. */
function excerptEnd(text: string, start: number, budget: number) {
  let low = start,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end = endAtCharacterBoundary(text, middle);
    if (jsonBytes(text.slice(start, end)) <= budget) low = middle;
    else high = middle - 1;
  }
  return endAtCharacterBoundary(text, low);
}

function pagesFor(text: string) {
  const pages: Array<{ startOffset: number; endOffset: number; text: string }> = [];
  let startOffset = 0;
  while (startOffset < text.length) {
    const endOffset = excerptEnd(text, startOffset, SOURCE_TEXT_JSON_BYTES);
    if (endOffset <= startOffset) throw new Error('Source page cannot fit');
    pages.push({ startOffset, endOffset, text: text.slice(startOffset, endOffset) });
    startOffset = endOffset;
  }
  return pages;
}

function result(value: unknown, isError = false) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > PORTFOLIO_SOURCE_TOOL_MAX_BYTES)
    throw new Error('Source response exceeds its serialized output budget');
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text }] };
}

/** Approved corpus only. Numbered pages can be requested in parallel in one SDK turn. */
export function createPortfolioSourceReader(sources: readonly PortfolioAgentSource[]) {
  if (
    !sources.length ||
    sources.length > 60 ||
    new Set(sources.map((source) => source.id)).size !== sources.length ||
    sources.some(
      (source) =>
        typeof source.id !== 'string' ||
        !source.id ||
        jsonBytes(source.id) > SOURCE_ID_JSON_BYTES ||
        typeof source.text !== 'string' ||
        !source.text ||
        source.text.length > 100_000,
    )
  )
    throw new Error('Invalid approved source corpus');
  const entries = sources.map((source) => ({ source, pages: pagesFor(source.text) }));
  const byId = new Map(entries.map((entry) => [entry.source.id, entry]));
  const overviewPageCount = Math.ceil(entries.length / OVERVIEW_PAGE_SIZE);
  return {
    overviewPageCount,
    manifest: entries.map(({ source, pages }) => ({
      id: source.id,
      url: source.url,
      attachmentId: source.attachmentId,
      characters: source.text.length,
      pageCount: pages.length,
    })),
    read(sourceId: string, page = 0) {
      const entry = byId.get(sourceId);
      if (!entry || !Number.isInteger(page) || page < 0 || page >= entry.pages.length)
        return result({ error: 'Source or page unavailable' }, true);
      return result({
        sourceId,
        page,
        pageCount: entry.pages.length,
        totalCharacters: entry.source.text.length,
        ...entry.pages[page]!,
      });
    },
    overview(page = 0) {
      if (!Number.isInteger(page) || page < 0 || page >= overviewPageCount)
        return result({ error: 'Overview page unavailable' }, true);
      return result({
        page,
        pageCount: overviewPageCount,
        sources: entries
          .slice(page * OVERVIEW_PAGE_SIZE, (page + 1) * OVERVIEW_PAGE_SIZE)
          .map(({ source, pages }) => {
            const endOffset = excerptEnd(source.text, 0, OVERVIEW_TEXT_JSON_BYTES);
            return {
              sourceId: source.id,
              pageCount: pages.length,
              totalCharacters: source.text.length,
              text: source.text.slice(0, endOffset),
              truncated: endOffset < source.text.length,
            };
          }),
      });
    },
  };
}
