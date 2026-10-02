import { normalizeTextSpec, validateTextBytes } from './meri-docgen.helpers.js';
import { validateDocumentArtifactBytes } from './meri-artifact-integrity.js';

describe('meri-text-artifact helpers (UTF8 validation, exact-byte preservation)', () => {
  it('preserves BOM and exact Unicode while rejecting replacement of lone surrogates', () => {
    const text = '\ufeffCafé 🚀\r\n';
    expect(normalizeTextSpec({ title: 'Exact', text }).text).toBe(text);
    for (const text of ['\ud800', '\udc00', 'a\ud800b']) {
      expect(() => normalizeTextSpec({ title: 'Invalid', text })).toThrow();
    }
  });
  it('uses the same strict text size and encoding validator at persisted-byte readback', async () => {
    await expect(validateDocumentArtifactBytes('txt', Buffer.from('Exact\n'))).resolves.toBeUndefined();
    for (const bytes of [Buffer.from([0xc0, 0x80]), Buffer.from('x\u0000'), Buffer.alloc(1024 * 1024 + 1, 0x61)]) {
      await expect(validateDocumentArtifactBytes('txt', bytes)).rejects.toThrow();
    }
  });
  describe('validateTextBytes', () => {
    it('accepts valid plain UTF8 text with allowed control characters (tab/CR/LF)', () => {
      const text = '\n  \t Leading and trailing  \t  \n';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('rejects NUL bytes (binary NUL U+0000)', () => {
      const bytes = Buffer.from('hello\x00world', 'utf-8');
      expect(() => validateTextBytes(bytes)).toThrow('text_invalid_control');
    });

    it('rejects invalid control characters (Bell U+0007)', () => {
      const bytes = Buffer.from('\x07hello', 'utf-8');
      expect(() => validateTextBytes(bytes)).toThrow('text_invalid_control');
    });

    it('rejects ESC control character (U+001B)', () => {
      const bytes = Buffer.from('\x1bhello', 'utf-8');
      expect(() => validateTextBytes(bytes)).toThrow('text_invalid_control');
    });

    it('rejects DEL character (U+007F)', () => {
      const bytes = Buffer.from('\x7fhello', 'utf-8');
      expect(() => validateTextBytes(bytes)).toThrow('text_invalid_control');
    });

    it('accepts valid ASCII printable range', () => {
      const text = 'Hello 123!@#$%^&*()';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('accepts multi-line text with CRLF line endings', () => {
      const text = 'Line1\r\nLine2\r\nLine3';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('accepts mixed line endings', () => {
      const text = 'Line1\nLine2\r\nLine3\rLine4';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('rejects UTF8 encoding errors (invalid byte sequence)', () => {
      const bytes = Buffer.from([0xff, 0xfe, 0xfd]); // Invalid UTF8
      expect(() => validateTextBytes(bytes)).toThrow('text_encoding_invalid');
    });

    it('rejects surrogate codepoints (not valid UTF8)', () => {
      // Unpaired high surrogate
      const bytes1 = Buffer.from('\uD800', 'utf-16le');
      expect(() => validateTextBytes(bytes1)).toThrow('text_encoding_invalid');

      // Unpaired low surrogate
      const bytes2 = Buffer.from('\uDC00', 'utf-16le');
      expect(() => validateTextBytes(bytes2)).toThrow('text_encoding_invalid');
    });

    it('accepts 2-byte UTF8 characters', () => {
      const text = 'Café résumé';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('accepts 3-byte UTF8 characters (CJK)', () => {
      const text = '你好世界';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('accepts 4-byte UTF8 characters (emoji)', () => {
      const text = '🎉🚀✨';
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('rejects empty buffer', () => {
      expect(() => validateTextBytes(Buffer.alloc(0))).toThrow('text_size_invalid');
    });

    it('supports up to 1MiB text', () => {
      const size = 1024 * 1024; // 1MiB
      const text = 'x'.repeat(size);
      const bytes = Buffer.from(text, 'utf-8');
      expect(validateTextBytes(bytes)).toBe(text);
    });

    it('rejects text exceeding 1MiB', () => {
      const size = 1024 * 1024 + 1; // 1MiB + 1
      const text = 'x'.repeat(size);
      const bytes = Buffer.from(text, 'utf-8');
      expect(() => validateTextBytes(bytes)).toThrow('text_size_invalid');
    });

    it('preserves exact printable text and line ending bytes', () => {
      // This test ensures we correctly differentiate NUL bytes (rejected) from valid content
      const text = 'line1\nline2\nline3';
      const bytes = Buffer.from(text, 'utf-8');
      const result = validateTextBytes(bytes);
      expect(result).toBe(text);
      expect(Buffer.from(result, 'utf-8').equals(bytes)).toBe(true);
    });
  });
});
