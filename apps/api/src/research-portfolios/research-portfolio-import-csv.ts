import { TextDecoder } from 'node:util';

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_DATA_ROWS = 10_000;

export interface ParsedResearchPortfolioCsv {
  headers: readonly string[];
  rows: readonly {
    rowNumber: number;
    cells: readonly string[];
  }[];
}

export class ResearchPortfolioCsvError extends Error {
  constructor(
    message: string,
    public readonly rowNumber?: number,
    public readonly columnIndex?: number,
  ) {
    super(message);
    this.name = 'ResearchPortfolioCsvError';
  }
}

interface ParsedRecord {
  rowNumber: number;
  cells: string[];
  blankPhysicalLine: boolean;
}

export function parseResearchPortfolioCsv(input: Buffer): ParsedResearchPortfolioCsv {
  if (input.length > MAX_CSV_BYTES) {
    throw new ResearchPortfolioCsvError('CSV file exceeds the 5 MiB limit');
  }
  if (input.includes(0)) {
    throw new ResearchPortfolioCsvError('CSV contains a NUL byte');
  }

  const bytes = input.subarray(
    input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? 3 : 0,
  );
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ResearchPortfolioCsvError('CSV is not valid UTF-8');
  }

  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let recordHadSyntax = false;
  let physicalLine = 1;
  let recordStartLine = 1;

  const pushField = () => {
    cells.push(field);
    field = '';
    closedQuote = false;
  };
  const pushRecord = () => {
    const blankPhysicalLine = !recordHadSyntax && cells.length === 0 && field.length === 0;
    pushField();
    records.push({ rowNumber: recordStartLine, cells, blankPhysicalLine });
    cells = [];
    recordHadSyntax = false;
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;

    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === '\n') {
          physicalLine += 1;
        } else if (character === '\r') {
          if (content[index + 1] === '\n') {
            field += '\n';
            index += 1;
          }
          physicalLine += 1;
        }
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      throw new ResearchPortfolioCsvError(
        'Unexpected character after a closing quote',
        recordStartLine,
        cells.length,
      );
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new ResearchPortfolioCsvError('Stray quote in an unquoted field', recordStartLine, cells.length);
      }
      inQuotes = true;
      recordHadSyntax = true;
    } else if (character === ',') {
      recordHadSyntax = true;
      pushField();
    } else if (character === '\n' || character === '\r') {
      pushRecord();
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      physicalLine += 1;
      recordStartLine = physicalLine;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new ResearchPortfolioCsvError('Unterminated quoted field', recordStartLine, cells.length);
  }
  if (cells.length > 0 || field.length > 0 || closedQuote || recordHadSyntax) {
    pushRecord();
  }

  while (records.at(-1)?.blankPhysicalLine) records.pop();
  if (records.length === 0) throw new ResearchPortfolioCsvError('CSV file is empty');

  const headers = records[0]!.cells.map((header) => header.trim());
  const seenHeaders = new Set<string>();
  headers.forEach((header, index) => {
    if (!header) throw new ResearchPortfolioCsvError('CSV headers cannot be blank', 1, index);
    const canonical = header.toLocaleLowerCase('en-US');
    if (seenHeaders.has(canonical)) {
      throw new ResearchPortfolioCsvError(`Duplicate CSV header: ${header}`, 1, index);
    }
    seenHeaders.add(canonical);
  });

  const data = records.slice(1);
  if (data.length === 0) throw new ResearchPortfolioCsvError('CSV must contain at least one data row');
  if (data.length > MAX_DATA_ROWS) {
    throw new ResearchPortfolioCsvError('CSV exceeds the 10,000 data-row limit');
  }
  for (const record of data) {
    if (record.cells.length !== headers.length) {
      throw new ResearchPortfolioCsvError(
        `CSV row has ${record.cells.length} columns; expected ${headers.length}`,
        record.rowNumber,
      );
    }
  }

  return {
    headers,
    rows: data.map(({ rowNumber, cells: rowCells }) => ({ rowNumber, cells: rowCells })),
  };
}
