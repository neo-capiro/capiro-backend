import {
  mimeForFormat,
  normalizeExcelSpec,
  normalizePptxSpec,
  normalizeTable,
  normalizeTextSpec,
  normalizeWordSpec,
  slugifyDocName,
} from './meri-docgen.helpers.js';

describe('clio-docgen helpers', () => {
  describe('normalizeTable', () => {
    it('coerces rows to header width and drops missing cells', () => {
      const t = normalizeTable({
        headers: ['A', 'B', 'C'],
        rows: [['1', '2'], ['x', 'y', 'z', 'extra']],
      });
      expect(t).not.toBeNull();
      expect(t!.headers).toEqual(['A', 'B', 'C']);
      expect(t!.rows[0]).toEqual(['1', '2', '']);
      expect(t!.rows[1]).toEqual(['x', 'y', 'z']);
    });
    it('returns null when there are no headers', () => {
      expect(normalizeTable({ rows: [['1']] })).toBeNull();
      expect(normalizeTable(null)).toBeNull();
    });
  });

  describe('normalizeWordSpec', () => {
    it('builds a spec from sections and applies a default title', () => {
      const spec = normalizeWordSpec({
        sections: [{ heading: 'Intro', paragraphs: ['Hello'], bullets: ['one'] }],
      });
      expect(spec.title).toBe('Document');
      expect(spec.sections).toHaveLength(1);
      expect(spec.sections[0]!.paragraphs).toEqual(['Hello']);
      expect(spec.sections[0]!.bullets).toEqual(['one']);
    });
    it('throws when there is no usable section', () => {
      expect(() => normalizeWordSpec({ title: 'X', sections: [] })).toThrow();
      expect(() => normalizeWordSpec({})).toThrow();
    });
  });

  describe('normalizeExcelSpec', () => {
    it('keeps headers + rows and ensures unique sanitized sheet names', () => {
      const spec = normalizeExcelSpec({
        sheets: [
          { name: 'Data:1', headers: ['x'], rows: [['1']] },
          { name: 'Data:1', headers: ['y'], rows: [['2']] },
        ],
      });
      expect(spec.sheets).toHaveLength(2);
      expect(spec.sheets[0]!.name).not.toContain(':');
      expect(spec.sheets[0]!.name).not.toBe(spec.sheets[1]!.name);
    });
    it('throws when there is no usable sheet', () => {
      expect(() => normalizeExcelSpec({ sheets: [] })).toThrow();
    });
  });

  describe('normalizePptxSpec', () => {
    it('keeps slides with bullets or a table', () => {
      const spec = normalizePptxSpec({
        title: 'Deck',
        slides: [
          { title: 'S1', bullets: ['a', 'b'] },
          { title: 'S2', table: { headers: ['h'], rows: [['v']] } },
          { title: '', bullets: [] },
        ],
      });
      expect(spec.title).toBe('Deck');
      expect(spec.slides).toHaveLength(2);
      expect(spec.slides[0]!.bullets).toEqual(['a', 'b']);
      expect(spec.slides[1]!.table).not.toBeNull();
    });
    it('throws when there is no usable slide', () => {
      expect(() => normalizePptxSpec({ slides: [] })).toThrow();
    });
  });

  describe('slugifyDocName + mimeForFormat', () => {
    it('slugifies titles to filesystem-safe stems', () => {
      expect(slugifyDocName('FY2027 Army P-40: Review!')).toBe('fy2027-army-p-40-review');
      expect(slugifyDocName('')).toBe('document');
    });
    it('maps formats to Office MIME types', () => {
      expect(mimeForFormat('docx')).toContain('wordprocessingml');
      expect(mimeForFormat('xlsx')).toContain('spreadsheetml');
      expect(mimeForFormat('pptx')).toContain('presentationml');
      expect(mimeForFormat('pdf')).toBe('application/pdf');
      expect(mimeForFormat('txt')).toBe('text/plain; charset=utf-8');
    });
  });

  describe('normalizeTextSpec', () => {
    it('builds a spec with title and text, default title if missing', () => {
      const spec = normalizeTextSpec({ title: 'My Doc', text: 'Hello\nWorld' });
      expect(spec.title).toBe('My Doc');
      expect(spec.text).toBe('Hello\nWorld');
    });
    it('uses default title when title is empty', () => {
      const spec = normalizeTextSpec({ text: 'Hello' });
      expect(spec.title).toBe('Text Document');
      expect(spec.text).toBe('Hello');
    });
    it('preserves exact bytes including leading/trailing whitespace and newlines', () => {
      const text = '\n  \t Leading and trailing  \t  \n';
      const spec = normalizeTextSpec({ title: 'X', text });
      expect(spec.text).toBe(text);
      expect(Buffer.from(spec.text)).toEqual(Buffer.from(text));
    });
    it('throws when text is missing', () => {
      expect(() => normalizeTextSpec({ title: 'X' })).toThrow('Text spec has no usable text');
      expect(() => normalizeTextSpec({ text: '' })).toThrow('Text spec has no usable text');
    });
    it('throws when input is invalid (no object)', () => {
      expect(() => normalizeTextSpec(null as unknown)).toThrow('Text spec has no usable text');
    });
    it('throws when text contains invalid control characters (except tab/CR/LF)', () => {
      const withBEL = '\x07hello';
      expect(() => normalizeTextSpec({ title: 'X', text: withBEL })).toThrow('text_content_invalid');
      const withESC = '\x1bhello';
      expect(() => normalizeTextSpec({ title: 'X', text: withESC })).toThrow('text_content_invalid');
    });
    it('allows tab, CR, LF characters', () => {
      const text = 'Col1\tCol2\nRow2';
      const spec = normalizeTextSpec({ title: 'X', text });
      expect(spec.text).toBe(text);
    });
  });
});
