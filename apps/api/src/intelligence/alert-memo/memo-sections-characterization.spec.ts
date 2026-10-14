import { Logger } from '@nestjs/common';
import { renderMemoDocx, type MemoDocInput } from './alert-memo-docx.js';
import { PARSER_CASES, PROVIDER_CASES } from './fixtures/memo-sections-characterization/cases.js';
import {
  FALLBACK,
  FALLBACK_DELIVERED,
  PRODUCERS,
  makeProducer,
  providerReply,
  providerFailure,
} from './fixtures/memo-sections-characterization/dependencies.js';

jest.mock('./alert-memo-docx.js', () => {
  const actual = jest.requireActual('./alert-memo-docx.js');
  return { ...actual, renderMemoDocx: jest.fn(async () => Buffer.from('fixture-docx')) };
});

describe.each(PRODUCERS)('%s original section parsing through generate', (producer) => {
  const originalFetch = global.fetch;
  const envKeys = ['MERI_AUDITOR_MODE', 'MERI_ENTAILMENT_MODE', 'MERI_SKEPTIC_MODE'] as const;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) process.env[key] = 'off';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    jest.restoreAllMocks();
    (renderMemoDocx as jest.Mock).mockClear();
  });

  it.each(PARSER_CASES)('$name', async ({ text, expected, delivered, warning }) => {
    const deps = makeProducer(producer);
    global.fetch = jest.fn(async () => providerReply(text)) as typeof fetch;
    const result = await deps.generate();
    expect(result.sections).toEqual(expected ?? FALLBACK[producer]);
    expect(result.lowConfidence).toBe(expected === undefined);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(warning ? 1 : 0);
    if (warning)
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('generation failed'),
      );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(deps.credentials.resolveProvider).toHaveBeenCalledTimes(1);
    expect(deps.usageRows).toHaveLength(1);
    expect(deps.usageRows[0]!.data).toEqual(
      expect.objectContaining({ inputTokens: 17, outputTokens: 9 }),
    );
    expect(result.held).toBe(false);
    expect(deps.reviews.createSystem).not.toHaveBeenCalled();
    expect(deps.engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
    expect(result.document).toEqual({
      attachmentId: 'attachment-parser',
      fileName: 'fixture.docx',
    });
    const doc = (renderMemoDocx as jest.Mock).mock.calls[0][0] as MemoDocInput;
    const expectedDelivery = delivered ?? FALLBACK_DELIVERED[producer];
    expect(doc.sections).toEqual(expectedDelivery);
    for (const section of expectedDelivery)
      for (const line of section.paragraphs) {
        expect(result.markdown).toContain(line);
      }
  });

  it.each(PROVIDER_CASES)(
    'provider %s keeps the existing fallback, usage and filing boundary',
    async (kind) => {
      const deps = makeProducer(producer);
      global.fetch = providerFailure(kind) as typeof fetch;
      const result = await deps.generate();
      expect(result.sections).toEqual(FALLBACK[producer]);
      expect(result.lowConfidence).toBe(true);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(kind === 'non-text content' ? 0 : 1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(deps.usageRows).toHaveLength(1);
      expect(deps.usageRows[0]!.data).toEqual(
        expect.objectContaining({
          inputTokens: kind === 'non-text content' ? 17 : 0,
          outputTokens: kind === 'non-text content' ? 9 : 0,
        }),
      );
      expect(result.held).toBe(false);
      expect(deps.reviews.createSystem).not.toHaveBeenCalled();
      expect(deps.engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
      expect(result.document).toEqual({
        attachmentId: 'attachment-parser',
        fileName: 'fixture.docx',
      });
    },
  );
});
