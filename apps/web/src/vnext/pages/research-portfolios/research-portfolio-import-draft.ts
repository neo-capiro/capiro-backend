import type {
  CreateResearchPortfolioImportDto,
  ResearchPortfolioImportWorksheetKind,
} from '@capiro/shared';

export const MAX_RETAINED_IMPORT_BYTES = 5 * 1024 * 1024;
export const IMPORT_FIELDS: Record<
  ResearchPortfolioImportWorksheetKind,
  { required: readonly string[]; optional: readonly string[] }
> = {
  membership: {
    required: ['target_kind', 'target_id'],
    optional: ['label', 'reason', 'evidence', 'access'],
  },
  rules: {
    required: ['readable_expression', 'expression_json'],
    optional: [
      'reason',
      'access',
      'mode',
      'qualification_policy_json',
      'taxonomy_version_id',
      'template_version_id',
    ],
  },
  reviews: {
    required: ['target_kind', 'target_id', 'reason'],
    optional: ['decision_type', 'evidence_for', 'evidence_against', 'access'],
  },
};
export interface RetainedImportFile {
  name: string;
  mediaType: 'text/csv' | 'application/vnd.ms-excel';
  contentBase64: string;
  size: number;
  sha256: string;
  headers: string[];
}
export interface RetainedImportDraft {
  original: RetainedImportFile | null;
  kind: ResearchPortfolioImportWorksheetKind;
  mapping: Record<string, string>;
  attempt: {
    operationKey: string;
    payload: Omit<CreateResearchPortfolioImportDto, 'operationKey'>;
    uncertain: boolean;
  } | null;
}
export function emptyImportDraft(): RetainedImportDraft {
  return { original: null, kind: 'membership', mapping: {}, attempt: null };
}
export function readImportDraft(key: string): RetainedImportDraft {
  const text = sessionStorage.getItem(key);
  if (!text) return emptyImportDraft();
  const value = JSON.parse(text) as RetainedImportDraft;
  if (
    !value ||
    !IMPORT_FIELDS[value.kind] ||
    !value.mapping ||
    typeof value.mapping !== 'object' ||
    Array.isArray(value.mapping) ||
    Object.values(value.mapping).some((header) => typeof header !== 'string')
  )
    throw new Error('The retained import draft is invalid; do not send it');
  if (
    value.original &&
    (typeof value.original.contentBase64 !== 'string' ||
      value.original.size > MAX_RETAINED_IMPORT_BYTES ||
      !Array.isArray(value.original.headers) ||
      typeof value.original.sha256 !== 'string')
  )
    throw new Error('The retained import file is invalid; do not send it');
  if (
    value.attempt &&
    (!value.original ||
      typeof value.attempt.operationKey !== 'string' ||
      !value.attempt.payload ||
      value.attempt.payload.contentBase64 !== value.original.contentBase64 ||
      value.attempt.payload.fileName !== value.original.name ||
      value.attempt.payload.worksheetKind !== value.kind ||
      JSON.stringify(value.attempt.payload.mapping) !== JSON.stringify(value.mapping))
  )
    throw new Error('The retained attempt does not match its original content; do not resend it');
  // A retained attempt was admitted before POST. A closed tab cannot persist
  // the lost response, so remount must treat it as an unknown outcome.
  return value.attempt ? { ...value, attempt: { ...value.attempt, uncertain: true } } : value;
}
function headerRecord(text: string): string[] {
  const result: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      result.push(cell.trim());
      cell = '';
      if (char !== ',') break;
    } else cell += char;
    if (index === text.length - 1) result.push(cell.trim());
  }
  if (
    quoted ||
    !result.length ||
    result.some((value) => !value) ||
    new Set(result).size !== result.length
  )
    throw new Error('CSV headers must be nonempty and unique');
  return result;
}
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function retainImportFile(file: File): Promise<RetainedImportFile> {
  if (file.size > MAX_RETAINED_IMPORT_BYTES)
    throw new Error('CSV file exceeds the server’s 5 MiB limit');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RETAINED_IMPORT_BYTES)
    throw new Error('Choose a nonempty CSV file no larger than 5 MiB');
  const headers = headerRecord(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''),
  );
  return {
    name: file.name,
    mediaType: file.type === 'application/vnd.ms-excel' ? 'application/vnd.ms-excel' : 'text/csv',
    contentBase64: encode(bytes),
    size: bytes.length,
    sha256: await digest(bytes),
    headers,
  };
}
export async function verifyRetainedImportFile(file: RetainedImportFile): Promise<void> {
  const bytes = decode(file.contentBase64);
  if (
    bytes.length !== file.size ||
    bytes.length > MAX_RETAINED_IMPORT_BYTES ||
    (await digest(bytes)) !== file.sha256
  )
    throw new Error('The retained original bytes/hash do not match; do not submit this draft');
}
export function inferredImportMapping(
  kind: ResearchPortfolioImportWorksheetKind,
  headers: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    [...IMPORT_FIELDS[kind].required, ...IMPORT_FIELDS[kind].optional]
      .filter((field) => headers.includes(field))
      .map((field) => [field, field]),
  );
}
