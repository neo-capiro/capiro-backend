export type DefenseSourceFamily =
  | 'rdte'
  | 'procurement'
  | 'operations_maintenance'
  | 'milcon'
  | 'authorization'
  | 'appropriations'
  | 'conference'
  | 'enacted';

export interface NormalizedSourceReference {
  readonly sourceFamily: DefenseSourceFamily;
  readonly documentId: string;
  readonly documentSha256?: string;
  readonly pageNumber?: number;
  readonly exhibitType?: string;
  readonly printedText?: string;
}

export function normalizeDefenseToken(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ');
}

export function normalizeFiscalYear(value: string | number): number {
  const numeric = typeof value === 'number' ? value : Number(value.trim().replace(/^FY/i, ''));
  if (!Number.isInteger(numeric) || numeric < 1900 || numeric > 2200) {
    throw new RangeError(`Invalid fiscal year: ${String(value)}`);
  }
  return numeric;
}

export function normalizeSourceReference(
  input: NormalizedSourceReference,
): NormalizedSourceReference {
  const documentId = normalizeDefenseToken(input.documentId);
  if (!documentId) throw new TypeError('Source document id is required');
  if (
    input.pageNumber !== undefined &&
    (!Number.isInteger(input.pageNumber) || input.pageNumber < 1)
  ) {
    throw new RangeError('Source page number must be a positive integer');
  }
  return {
    ...input,
    documentId,
    exhibitType: input.exhibitType ? normalizeDefenseToken(input.exhibitType) : undefined,
    printedText: input.printedText?.trim() || undefined,
  };
}

export interface ExtractedField<TValue> {
  readonly fieldName: string;
  readonly value: TValue | null;
  readonly source: NormalizedSourceReference;
  readonly parserName: string;
  readonly parserVersion: string;
  readonly confidence?: number;
  readonly warnings: readonly string[];
}
