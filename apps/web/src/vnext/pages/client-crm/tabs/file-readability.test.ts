import { describe, expect, it } from 'vitest';
import { fileReadability } from './file-readability.js';

describe('client file readability labels', () => {
  it('does not treat legacy filename-only indexing as readable document contents', () => {
    expect(fileReadability({ indexedAt: '2026-09-07' })).toEqual({
      status: 'Readability unverified',
      tone: 'gray',
    });
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'empty',
        extractionMetadata: { chars: 0 },
      }),
    ).toMatchObject({ status: 'No readable text', tone: 'warning' });
  });
  it('distinguishes verified searchable text, partial sections and unavailable/partial visual reads', () => {
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'extracted',
        extractionMetadata: { chars: 1000 },
      }).status,
    ).toBe('Text searchable');
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'extracted',
        extractionMetadata: { sectionRead: true, chars: 1000 },
      }).status,
    ).toBe('Text read · section only');
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'empty',
        extractionMetadata: {
          sectionRead: true,
          readability: { status: 'no_readable_text', scope: 'section' },
        },
      }).status,
    ).toBe('No readable text · section');
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'extracted',
        extractionMetadata: {
          chars: 24000,
          indexedChunks: 6,
          lastSectionRead: {
            sectionRead: true,
            emptySection: true,
            readability: { status: 'no_readable_text', scope: 'section' },
          },
        },
      }).status,
    ).toBe('No readable text · section');
    expect(
      fileReadability({
        indexedAt: null,
        extractionStatus: 'truncated',
        extractionMetadata: { readability: { status: 'ocr_partial' } },
      }).status,
    ).toBe('Visual text partial');
    expect(
      fileReadability({
        indexedAt: '2026-09-07',
        extractionStatus: 'empty',
        extractionMetadata: { readability: { status: 'ocr_unavailable' } },
      }).status,
    ).toBe('Visual read unavailable');
    expect(fileReadability({ indexedAt: null, extractionStatus: 'failed' }).status).toBe(
      'Extraction failed',
    );
  });
});
