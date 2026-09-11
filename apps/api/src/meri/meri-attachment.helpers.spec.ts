import { describe, expect, test } from '@jest/globals';
import {
  DOC_TEXT_MAX_CHARS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  PPTX_CT,
  SCANNED_PDF_MIN_CHARS,
  attachmentMetaRef,
  clampExtractedText,
  detectAttachmentKind,
  formatAttachmentContext,
  imageHistoryPlaceholder,
  imageMediaTypeFromSniff,
  isExtractableKind,
  isScannedPdf,
  resolveDocumentStatus,
  sniffMagicBytes,
  validateAttachment,
  validateVisionSet,
  verifyMagicBytes,
} from './meri-attachment.helpers.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const bytes = (...values: Array<number | string>): Uint8Array => {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === 'number') out.push(v);
    else for (const ch of Buffer.from(v, 'utf8')) out.push(ch);
  }
  return Uint8Array.from(out);
};

describe('detectAttachmentKind', () => {
  test('by content-type', () => {
    expect(detectAttachmentKind('application/pdf')).toBe('pdf');
    expect(detectAttachmentKind(DOCX)).toBe('docx');
    expect(detectAttachmentKind(`${PPTX_CT}; charset=binary`)).toBe('pptx');
    expect(detectAttachmentKind('image/png')).toBe('image');
    expect(detectAttachmentKind('text/plain')).toBe('text');
    expect(detectAttachmentKind('application/zip')).toBe('unsupported');
  });
  test('falls back to filename extension', () => {
    expect(detectAttachmentKind('', 'memo.pdf')).toBe('pdf');
    expect(detectAttachmentKind('', 'brief.docx')).toBe('docx');
    expect(detectAttachmentKind('application/octet-stream', 'Strat Discussion.PPTX')).toBe('pptx');
    expect(detectAttachmentKind('application/vnd.ms-powerpoint', 'old.ppt')).toBe('unsupported');
    expect(detectAttachmentKind('', 'logo.jpg')).toBe('image');
    expect(detectAttachmentKind('', 'notes.md')).toBe('text');
    expect(detectAttachmentKind('', 'archive.bin')).toBe('unsupported');
  });
});

describe('isExtractableKind', () => {
  test('pdf + docx + pptx + text are extractable; image/unsupported are not', () => {
    expect(isExtractableKind('docx')).toBe(true);
    expect(isExtractableKind('pptx')).toBe(true);
    expect(isExtractableKind('text')).toBe(true);
    expect(isExtractableKind('pdf')).toBe(true);
    expect(isExtractableKind('image')).toBe(false);
    expect(isExtractableKind('unsupported')).toBe(false);
  });
});

describe('validateAttachment', () => {
  test('accepts PowerPoint with a missing or generic MIME type and preserves the size limit', () => {
    for (const contentType of ['', 'application/octet-stream', PPTX_CT]) {
      expect(validateAttachment({ contentType, byteSize: 1000, filename: 'Strat Discussion.pptx' }))
        .toEqual({ ok: true, reason: null, kind: 'pptx' });
    }
    expect(validateAttachment({ contentType: PPTX_CT, byteSize: MAX_ATTACHMENT_BYTES + 1 }).ok).toBe(false);
  });
  test('accepts a valid docx', () => {
    expect(validateAttachment({ contentType: DOCX, byteSize: 1000, filename: 'a.docx' }).ok).toBe(
      true,
    );
  });
  test('rejects empty, oversized, and unsupported', () => {
    expect(validateAttachment({ contentType: 'text/plain', byteSize: 0 }).ok).toBe(false);
    expect(
      validateAttachment({ contentType: 'text/plain', byteSize: MAX_ATTACHMENT_BYTES + 1 }).ok,
    ).toBe(false);
    expect(validateAttachment({ contentType: 'application/zip', byteSize: 10 }).reason).toBe(
      'Unsupported file type',
    );
  });
});

describe('sniffMagicBytes', () => {
  test('recognizes the supported container formats', () => {
    expect(sniffMagicBytes(bytes('%PDF-1.7 rest'))).toBe('pdf');
    expect(sniffMagicBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe('zip');
    expect(sniffMagicBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1))).toBe('png');
    expect(sniffMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffMagicBytes(bytes('GIF89a'))).toBe('gif');
    expect(sniffMagicBytes(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp');
  });
  test('detects HTML even with leading whitespace', () => {
    expect(sniffMagicBytes(bytes('  \n<!DOCTYPE html><html>'))).toBe('html');
    expect(sniffMagicBytes(bytes('<html lang="en">'))).toBe('html');
  });
  test('plain prose is unknown', () => {
    expect(sniffMagicBytes(bytes('Dear Chairman, attached please find'))).toBe('unknown');
  });
});

describe('verifyMagicBytes (spoof rejection)', () => {
  test('requires an OOXML container for PowerPoint; rejects PDF and HTML renamed to .pptx', () => {
    expect(verifyMagicBytes('pptx', bytes(0x50, 0x4b, 0x03, 0x04)).ok).toBe(true);
    expect(verifyMagicBytes('pptx', bytes('%PDF-1.7')).ok).toBe(false);
    expect(verifyMagicBytes('pptx', bytes('<html>fake deck')).ok).toBe(false);
  });
  test('a .pdf that is actually HTML is rejected', () => {
    const check = verifyMagicBytes('pdf', bytes('<!DOCTYPE html><html><body>fake</body>'));
    expect(check.ok).toBe(false);
    expect(check.sniffed).toBe('html');
    expect(check.reason).toContain('does not look like a PDF');
  });
  test('a .docx that is not a zip container is rejected', () => {
    expect(verifyMagicBytes('docx', bytes('%PDF-1.4')).ok).toBe(false);
  });
  test('an image with unknown bytes is rejected', () => {
    expect(verifyMagicBytes('image', bytes('not an image')).ok).toBe(false);
  });
  test('binary masquerading as text is rejected; html-in-txt is allowed', () => {
    expect(verifyMagicBytes('text', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).ok).toBe(
      false,
    );
    expect(verifyMagicBytes('text', bytes('<html>snippet</html>')).ok).toBe(true);
    expect(verifyMagicBytes('text', bytes('plain notes')).ok).toBe(true);
  });
  test('matching kinds pass and report the sniffed format', () => {
    expect(verifyMagicBytes('pdf', bytes('%PDF-1.7'))).toEqual({
      ok: true,
      reason: null,
      sniffed: 'pdf',
    });
    expect(verifyMagicBytes('image', bytes(0xff, 0xd8, 0xff)).sniffed).toBe('jpeg');
  });
});

describe('imageMediaTypeFromSniff', () => {
  test('maps sniffed formats to canonical media types', () => {
    expect(imageMediaTypeFromSniff('png')).toBe('image/png');
    expect(imageMediaTypeFromSniff('jpeg')).toBe('image/jpeg');
    expect(imageMediaTypeFromSniff('gif')).toBe('image/gif');
    expect(imageMediaTypeFromSniff('webp')).toBe('image/webp');
    expect(imageMediaTypeFromSniff('pdf')).toBeNull();
    expect(imageMediaTypeFromSniff('unknown')).toBeNull();
  });
});

describe('clampExtractedText', () => {
  test('passes short text through untouched', () => {
    expect(clampExtractedText('  hello  ')).toEqual({ text: 'hello', truncated: false });
  });
  test('clamps long text with an explicit marker', () => {
    const out = clampExtractedText('x'.repeat(DOC_TEXT_MAX_CHARS + 500));
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('[truncated]');
    expect(out.text.length).toBeLessThanOrEqual(DOC_TEXT_MAX_CHARS + 20);
  });
});

describe('isScannedPdf', () => {
  test('sparse text (whitespace ignored) marks a scan', () => {
    expect(isScannedPdf('   \n\n  a b c ')).toBe(true);
    expect(isScannedPdf('x'.repeat(SCANNED_PDF_MIN_CHARS - 1))).toBe(true);
  });
  test('a real text layer does not', () => {
    expect(isScannedPdf('w'.repeat(SCANNED_PDF_MIN_CHARS + 1))).toBe(false);
  });
});

describe('resolveDocumentStatus', () => {
  test('scanned pdf gets an explicit user-visible explanation', () => {
    const res = resolveDocumentStatus('pdf', '  ');
    expect(res.status).toBe('scanned');
    expect(res.text).toBeNull();
    expect(res.reason).toContain('no text layer');
  });
  test('a sparse docx is NOT treated as scanned', () => {
    const res = resolveDocumentStatus('docx', 'short memo');
    expect(res.status).toBe('parsed');
    expect(res.text).toBe('short memo');
  });
  test('long documents report truncated with a reason', () => {
    const res = resolveDocumentStatus('pdf', 'y'.repeat(DOC_TEXT_MAX_CHARS + 1000));
    expect(res.status).toBe('truncated');
    expect(res.truncated).toBe(true);
    expect(res.reason).toContain('characters');
  });
  test('empty extraction is surfaced, never silently dropped', () => {
    const res = resolveDocumentStatus('text', '   ');
    expect(res.status).toBe('unsupported');
    expect(res.reason).toContain('No readable text');
  });
});

describe('validateVisionSet', () => {
  test('caps image count per message', () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ byteSize: 10 }));
    expect(validateVisionSet(many).ok).toBe(false);
    expect(validateVisionSet(many.slice(0, MAX_IMAGES_PER_MESSAGE)).ok).toBe(true);
  });
  test('caps per-image size at the vision limit', () => {
    const res = validateVisionSet([{ byteSize: MAX_IMAGE_BYTES + 1, filename: 'big.png' }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('big.png');
  });
});

describe('formatAttachmentContext', () => {
  test('labels and clamps', () => {
    expect(formatAttachmentContext('memo.txt', 'hello')).toContain('Attached document "memo.txt"');
    const long = formatAttachmentContext('big.txt', 'x'.repeat(9000), 100);
    expect(long).toContain('[truncated]');
    expect(long.length).toBeLessThan(200);
  });
});

describe('attachment meta + history placeholders', () => {
  test('attachmentMetaRef keeps only the chip fields', () => {
    expect(
      attachmentMetaRef({
        id: 'a1',
        filename: 'memo.pdf',
        kind: 'pdf',
        status: 'parsed',
      }),
    ).toEqual({ id: 'a1', filename: 'memo.pdf', kind: 'pdf', status: 'parsed' });
  });
  test('imageHistoryPlaceholder names the file', () => {
    expect(imageHistoryPlaceholder('chart.png')).toContain('"chart.png"');
  });
});
