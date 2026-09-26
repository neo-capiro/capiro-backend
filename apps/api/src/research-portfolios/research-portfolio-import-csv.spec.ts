import {
  parseResearchPortfolioCsv,
  ResearchPortfolioCsvError,
} from './research-portfolio-import-csv.js';

describe('parseResearchPortfolioCsv', () => {
  describe('positive cases', () => {
    it('parses basic CSV', () => {
      const csv = Buffer.from('name,email,role\nJohn Doe,john@example.com,admin\nJane Smith,jane@example.com,user');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['name', 'email', 'role']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({
        rowNumber: 2,
        cells: ['John Doe', 'john@example.com', 'admin'],
      });
      expect(result.rows[1]).toEqual({
        rowNumber: 3,
        cells: ['Jane Smith', 'jane@example.com', 'user'],
      });
    });

    it('handles UTF-8 BOM', () => {
      const csv = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,name\n1,Test')]);
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['id', 'name']);
      expect(result.rows[0]!.cells).toEqual(['1', 'Test']);
    });

    it('handles quoted commas', () => {
      const csv = Buffer.from('id,description\n1,"A, B, and C"\n2,"D and E"');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['id', 'description']);
      expect(result.rows[0]!.cells).toEqual(['1', 'A, B, and C']);
      expect(result.rows[1]!.cells).toEqual(['2', 'D and E']);
    });

    it('handles embedded newlines in quotes', () => {
      const csv = Buffer.from('id,text\n1,"Line 1\nLine 2"\n2,"Single line"');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['id', 'text']);
      expect(result.rows[0]!.cells).toEqual(['1', 'Line 1\nLine 2']);
      expect(result.rows[1]!.cells).toEqual(['2', 'Single line']);
      expect(result.rows[1]!.rowNumber).toBe(4);
    });

    it('handles escaped quotes', () => {
      const csv = Buffer.from('id,quote\n1,"He said ""hello"""\n2,"""Test"" value"');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['id', 'quote']);
      expect(result.rows[0]!.cells).toEqual(['1', 'He said "hello"']);
      expect(result.rows[1]!.cells).toEqual(['2', '"Test" value']);
    });

    it('handles CRLF line endings', () => {
      const csv = Buffer.from('a,b\r\n1,2\r\n3,4');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['a', 'b']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.cells).toEqual(['1', '2']);
      expect(result.rows[1]!.cells).toEqual(['3', '4']);
    });

    it('normalizes headers while preserving data cell strings', () => {
      const csv = Buffer.from('  id  ,  name  \n  1  ,  John  ');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['id', 'name']);
      expect(result.rows[0]!.cells).toEqual(['  1  ', '  John  ']);
    });

    it('handles empty quoted fields', () => {
      const csv = Buffer.from('a,b,c\n"","",""');
      const result = parseResearchPortfolioCsv(csv);
      
      expect(result.headers).toEqual(['a', 'b', 'c']);
      expect(result.rows[0]!.cells).toEqual(['', '', '']);
    });
  });

  describe('validation errors', () => {
    it('rejects files over 5 MiB', () => {
      const largeBuffer = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
      expect(() => parseResearchPortfolioCsv(largeBuffer))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects invalid UTF-8', () => {
      const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
      expect(() => parseResearchPortfolioCsv(invalidUtf8))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects NUL bytes', () => {
      const csv = Buffer.from('a,b\n1,\x002');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects stray quotes', () => {
      const csv = Buffer.from('a,b\n1"extra,2');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects duplicate headers (case-insensitive)', () => {
      const csv = Buffer.from('Name,name,NamE\n1,2,3');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects blank headers', () => {
      const csv = Buffer.from('a,,c\n1,2,3');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects header-only files', () => {
      const csv = Buffer.from('a,b,c');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects empty files', () => {
      const csv = Buffer.from('');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects inconsistent column counts', () => {
      const csv = Buffer.from('a,b,c\n1,2\n3,4,5');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects unterminated quotes', () => {
      const csv = Buffer.from('a,b\n"unterminated,2');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects too many data rows', () => {
      const header = 'id\n';
      const rows = Array.from({ length: 10001 }, (_, i) => `${i}`).join('\n');
      const csv = Buffer.from(header + rows);
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('rejects character after closing quote', () => {
      const csv = Buffer.from('a,b\n"quoted"extra,2');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError);
    });

    it('includes row/column info in error', () => {
      const csv = Buffer.from('a,b\n"stray"extra,2');
      try {
        parseResearchPortfolioCsv(csv);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ResearchPortfolioCsvError);
        expect((error as ResearchPortfolioCsvError).rowNumber).toBe(2);
        expect((error as ResearchPortfolioCsvError).columnIndex).toBe(0);
      }
    });
  });

  describe('edge cases', () => {
    it('handles trailing newline', () => {
      const csv = Buffer.from('a,b\n1,2\n');
      const result = parseResearchPortfolioCsv(csv);
      expect(result.rows).toHaveLength(1);
    });

    it('handles empty rows at end', () => {
      const csv = Buffer.from('a,b\n1,2\n\n\n');
      const result = parseResearchPortfolioCsv(csv);
      expect(result.rows).toHaveLength(1);
    });

    it('handles single quoted field', () => {
      const csv = Buffer.from('"single"');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError); // Header-only
    });

    it('handles just quotes', () => {
      const csv = Buffer.from('""');
      expect(() => parseResearchPortfolioCsv(csv))
        .toThrow(ResearchPortfolioCsvError); // Header-only
    });
  });
});
