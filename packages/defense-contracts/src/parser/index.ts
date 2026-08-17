export type DefenseBudgetDocumentFamily =
  | 'R1'
  | 'R2'
  | 'R2A'
  | 'R3'
  | 'P1'
  | 'P40'
  | 'P5'
  | 'P21'
  | 'P3A'
  | 'O1'
  | 'OP5'
  | 'O1R'
  | 'C1'
  | 'HASC'
  | 'SASC'
  | 'HACD'
  | 'SACD'
  | 'NDAA_CONFERENCE'
  | 'APPROPRIATIONS_CONFERENCE'
  | 'ENACTED';

export type DefenseParserMode = 'discover' | 'extract' | 'validate' | 'replay';

export interface DefenseObjectLocator {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
  readonly etag?: string;
  readonly sha256?: string;
}

export interface DefenseSourcePage {
  readonly documentId: string;
  readonly pageNumber: number;
  readonly sourceUrl?: string;
  readonly exhibitType?: string;
  readonly exactText?: string;
  readonly boundingBox?: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface DefenseExactValue {
  /** Exact decimal text from the source. Never a floating-point parse artifact. */
  readonly value: string;
  readonly unit: 'dollars' | 'thousands' | 'millions' | 'quantity' | 'percent' | 'unknown';
  readonly printedText: string;
}

export interface DefenseParserRecord {
  readonly family: DefenseBudgetDocumentFamily;
  readonly nativeIdentityKind:
    | 'program_element'
    | 'procurement_blin'
    | 'om_bli'
    | 'sag'
    | 'milcon_project';
  readonly nativeIdentity: string;
  readonly fiscalYear?: number;
  readonly fieldName: string;
  readonly value: DefenseExactValue | null;
  readonly evidence: readonly DefenseSourcePage[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DefenseParserJobRequest {
  readonly jobId: string;
  readonly mode: DefenseParserMode;
  readonly family: DefenseBudgetDocumentFamily;
  readonly source: DefenseObjectLocator;
  readonly fiscalYear?: number;
  readonly service?: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly idempotencyKey: string;
}

export interface DefenseParserJobResult {
  readonly jobId: string;
  readonly status: 'succeeded' | 'failed' | 'quarantined' | 'partial';
  readonly records: readonly DefenseParserRecord[];
  readonly warnings: readonly string[];
  readonly errors: readonly Readonly<{
    code: string;
    message: string;
    pageNumber?: number;
  }>[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly parserName: string;
  readonly parserVersion: string;
  readonly sourceSha256?: string;
}
